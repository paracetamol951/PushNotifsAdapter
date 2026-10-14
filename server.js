'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const { loadConfig, base64Key } = require('./config');

const PROTOCOL = 'tarot-push-v1';
const MAX_BODY_BYTES = 16384;
const MAX_PAYLOAD_BYTES = 3993;
const URGENCIES = ['very-low', 'low', 'normal', 'high'];

function apiError(status, message) {
    const error = new Error(message);
    error.apiStatus = status;
    return error;
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || /[\s\\]/.test(endpoint)) return false;
    let url;
    try { url = new URL(endpoint); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return false;
    const host = url.hostname.toLowerCase();
    // Comparaison par domaine entier : aucun hote fourni par le client hors de cette liste.
    return host === 'fcm.googleapis.com'
        || host === 'android.googleapis.com'
        || host === 'web.push.apple.com'
        || host === 'updates.push.services.mozilla.com'
        || host.endsWith('.push.services.mozilla.com')
        || host === 'notify.windows.com'
        || host.endsWith('.notify.windows.com');
}

function parseNotification(data, config) {
    if (!isRecord(data) || !isRecord(data.subscription) || !isRecord(data.subscription.keys)) {
        throw apiError(400, 'subscription_invalide');
    }
    if (!validEndpoint(data.subscription.endpoint)) throw apiError(400, 'endpoint_non_autorise');
    try {
        const publicKey = base64Key(data.subscription.keys.p256dh, 65, 'p256dh');
        crypto.ECDH.convertKey(publicKey, 'prime256v1');
        base64Key(data.subscription.keys.auth, 16, 'auth');
    } catch {
        throw apiError(400, 'cles_abonnement_invalides');
    }
    if (data.vapidPublicKey !== config.vapidDetails.publicKey) {
        throw apiError(409, 'cle_publique_vapid_differente_du_site');
    }
    if (!isRecord(data.payload)) throw apiError(400, 'payload_json_invalide');
    const payload = JSON.stringify(data.payload);
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) throw apiError(413, 'payload_trop_volumineux');
    const input = data.options === undefined ? {} : data.options;
    if (!isRecord(input)) throw apiError(400, 'options_invalides');
    const ttl = input.ttl === undefined ? 3600 : input.ttl;
    const urgency = input.urgency === undefined ? 'normal' : input.urgency;
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 2419200 || !URGENCIES.includes(urgency)) {
        throw apiError(400, 'options_invalides');
    }
    const options = {
        TTL: ttl,
        urgency,
        contentEncoding: 'aes128gcm',
        timeout: config.timeout,
        vapidDetails: config.vapidDetails
    };
    if (input.topic !== undefined && input.topic !== '') {
        if (typeof input.topic !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(input.topic)) {
            throw apiError(400, 'topic_invalide');
        }
        options.topic = input.topic;
    }
    return {
        subscription: {
            endpoint: data.subscription.endpoint,
            keys: { p256dh: data.subscription.keys.p256dh, auth: data.subscription.keys.auth }
        },
        payload,
        options
    };
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(apiError(413, 'requete_trop_volumineuse'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (size > MAX_BODY_BYTES) return;
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(apiError(400, 'json_invalide')); }
        });
        req.on('error', () => reject(apiError(400, 'lecture_interrompue')));
        req.on('aborted', () => reject(apiError(400, 'lecture_interrompue')));
    });
}

function createRelayServer(config, sendNotification = webpush.sendNotification.bind(webpush)) {
    const secretDigest = crypto.createHash('sha256').update(config.secret).digest();
    let active = 0;
    const handler = async (req, res) => {
        function reply(status, result) {
            if (res.destroyed || res.writableEnded) return;
            const body = JSON.stringify(Object.assign({ relay: PROTOCOL }, result));
            res.writeHead(status, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
                'Cache-Control': 'no-store',
                'Connection': 'close'
            });
            res.end(body);
        }
        const supplied = req.headers['x-internal-secret'];
        const suppliedDigest = crypto.createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest();
        if (!supplied || !crypto.timingSafeEqual(secretDigest, suppliedDigest)) {
            reply(401, { success: false, expired: false, error: 'authentification_requise' });
            return;
        }
        if (req.method === 'GET' && req.url === '/health') {
            reply(200, { ok: true, vapidPublicKey: config.vapidDetails.publicKey });
            return;
        }
        if (req.url !== '/push') {
            reply(404, { success: false, expired: false, error: 'route_inconnue' });
            return;
        }
        if (req.method !== 'POST') {
            reply(405, { success: false, expired: false, error: 'methode_invalide' });
            return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
            reply(415, { success: false, expired: false, error: 'content_type_invalide' });
            return;
        }
        if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
            reply(413, { success: false, expired: false, error: 'requete_trop_volumineuse' });
            return;
        }
        if (active >= config.maxConcurrent) {
            reply(503, { success: false, expired: false, retryable: true, error: 'relais_occupe' });
            return;
        }
        active++;
        try {
            const notification = parseNotification(await readJson(req), config);
            let result;
            try {
                const response = await sendNotification(notification.subscription, notification.payload, notification.options);
                const code = Number(response.statusCode);
                if (code < 200 || code >= 300 || !Number.isInteger(code)) throw new Error('invalid_upstream_response');
                result = { success: true, expired: false, retryable: false, statusCode: code, error: '' };
            } catch (error) {
                const code = Number.isInteger(error.statusCode) ? error.statusCode : 0;
                // Ne jamais renvoyer le corps fournisseur ni error.message : ils peuvent contenir des secrets.
                result = {
                    success: false,
                    expired: code === 404 || code === 410,
                    retryable: code === 0 || code === 408 || code === 429 || code >= 500,
                    statusCode: code,
                    error: code ? 'push_http_' + code : 'push_transport_error'
                };
            }
            // HTTP 200 = resultat fournisseur. Les erreurs de l'API restent des 4xx/5xx.
            reply(200, result);
        } catch (error) {
            reply(error.apiStatus || 500, {
                success: false, expired: false,
                error: error.apiStatus ? error.message : 'erreur_interne'
            });
        } finally {
            active--;
        }
    };
    const server = config.tls ? https.createServer(config.tls, handler) : http.createServer(handler);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.setTimeout(20000, socket => socket.destroy());
    return server;
}

if (require.main === module) {
    try {
        const envFile = path.join(__dirname, '.env');
        if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
        const config = loadConfig();
        const server = createRelayServer(config);
        server.on('error', error => {
            console.error('Relais push : demarrage impossible (' + (error.code || 'erreur') + ')');
            process.exitCode = 1;
        });
        server.listen(config.port, config.host, () => {
            console.log('Relais push en ecoute sur ' + (config.tls ? 'https://' : 'http://') + config.host + ':' + config.port);
        });
        for (const signal of ['SIGTERM', 'SIGINT']) {
            process.once(signal, () => {
                server.close();
                setTimeout(() => { server.closeAllConnections(); }, 12000).unref();
            });
        }
    } catch (error) {
        console.error('Configuration du relais push invalide : ' + error.message);
        process.exitCode = 1;
    }
}

module.exports = { createRelayServer, parseNotification, validEndpoint };
