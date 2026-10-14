'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpush = require('web-push');
const { createRelayServer, parseNotification } = require('../server');
const { loadConfig } = require('../config');

const vapid = webpush.generateVAPIDKeys();
const secret = crypto.randomBytes(32).toString('hex');
const receiver = crypto.createECDH('prime256v1');
receiver.generateKeys();
const env = {
    NODE_INTERNAL_SECRET: secret,
    PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
    PUSH_VAPID_PRIVATE_KEY: vapid.privateKey
};
const config = loadConfig(env);
function requestBody() {
    return {
        vapidPublicKey: vapid.publicKey,
        subscription: {
            endpoint: 'https://fcm.googleapis.com/fcm/send/test',
            keys: {
                p256dh: receiver.getPublicKey().toString('base64url'),
                auth: crypto.randomBytes(16).toString('base64url')
            }
        },
        payload: { title: 'Message reçu', body: 'Ça fonctionne 🃏', url: '/messages' },
        options: { ttl: 120, urgency: 'high', topic: 'message-42' }
    };
}

async function withServer(t, send, overrides = {}) {
    const server = createRelayServer(Object.assign({}, config, overrides), send);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return 'http://127.0.0.1:' + server.address().port;
}
async function post(url, data, headers = {}) {
    const res = await fetch(url + '/push', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Internal-Secret': secret }, headers),
        body: typeof data === 'string' ? data : JSON.stringify(data)
    });
    return { status: res.status, body: await res.json() };
}

test('configuration obligatoire, coherence VAPID et prise en charge du PEM existant', () => {
    assert.throws(() => loadConfig({}), /NODE_INTERNAL_SECRET/);
    assert.throws(() => loadConfig(Object.assign({}, env, { NODE_INTERNAL_SECRET: secret + '\n' })));
    assert.throws(() => loadConfig(Object.assign({}, env, { PUSH_VAPID_PUBLIC_KEY: webpush.generateVAPIDKeys().publicKey })), /correspond/);
    const point = Buffer.from(vapid.publicKey, 'base64url');
    const pem = crypto.createPrivateKey({
        key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey,
            x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
        format: 'jwk'
    }).export({ type: 'pkcs8', format: 'pem' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarot-push-key-test-'));
    const file = path.join(dir, 'fixture.pem');
    try {
        fs.writeFileSync(file, pem);
        const loaded = loadConfig(Object.assign({}, env, { PUSH_VAPID_PRIVATE_KEY: '', PUSH_VAPID_PRIVATE_KEY_FILE: file }));
        assert.deepEqual(loaded.vapidDetails, config.vapidDetails);
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(dir);
    }
});

test('authentification sur toutes les routes et aucun envoi sans la cle', async t => {
    let calls = 0;
    const url = await withServer(t, async () => { calls++; return { statusCode: 201 }; });
    for (const token of ['', 'incorrect', secret + 'x']) {
        const result = await post(url, requestBody(), { 'X-Internal-Secret': token });
        assert.equal(result.status, 401);
    }
    assert.equal((await fetch(url + '/health')).status, 401);
    const health = await fetch(url + '/health', { headers: { 'X-Internal-Secret': secret } });
    assert.equal((await health.json()).vapidPublicKey, vapid.publicKey);
    assert.equal(calls, 0);
});

test('le relais transmet le JSON Unicode et les options a web-push', async t => {
    let sent;
    const url = await withServer(t, async (...args) => { sent = args; return { statusCode: 201 }; });
    const body = requestBody();
    const response = await post(url, body);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
        relay: 'tarot-push-v1', success: true, expired: false, retryable: false, statusCode: 201, error: ''
    });
    assert.deepEqual(sent[0], body.subscription);
    assert.deepEqual(JSON.parse(sent[1]), body.payload);
    assert.equal(sent[2].contentEncoding, 'aes128gcm');
    assert.equal(sent[2].TTL, 120);
    assert.equal(sent[2].urgency, 'high');
    assert.equal(sent[2].topic, 'message-42');
    assert.deepEqual(sent[2].vapidDetails, config.vapidDetails);
});

test('web-push chiffre le message et produit une signature VAPID verifiable', () => {
    const data = parseNotification(requestBody(), config);
    const details = webpush.generateRequestDetails(data.subscription, data.payload, data.options);
    assert.equal(details.method, 'POST');
    assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
    assert.ok(Buffer.isBuffer(details.body));
    assert.equal(details.body.includes(Buffer.from('Message reçu')), false);
    const token = details.headers.Authorization.match(/t=([^, ]+)/)[1];
    const parts = token.split('.');
    const point = Buffer.from(vapid.publicKey, 'base64url');
    const publicKey = crypto.createPublicKey({
        key: { kty: 'EC', crv: 'P-256',
            x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
        format: 'jwk'
    });
    assert.equal(crypto.verify('sha256', Buffer.from(parts[0] + '.' + parts[1]),
        { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true);
    assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url')).aud, 'https://fcm.googleapis.com');
});

test('abonnements expires, limitations et panne fournisseur sans fuite de secrets', async t => {
    let code = 410;
    const url = await withServer(t, async () => {
        const error = new Error('secret=' + secret);
        error.statusCode = code;
        error.body = 'sensitive subscription';
        throw error;
    });
    for (const status of [404, 410, 403, 429, 503, 0]) {
        code = status;
        const response = await post(url, requestBody());
        assert.equal(response.status, 200);
        assert.equal(response.body.expired, status === 404 || status === 410);
        assert.equal(response.body.retryable, status === 0 || status === 429 || status === 503);
        assert.equal(response.body.statusCode, status);
        assert.ok(!JSON.stringify(response).includes(secret));
        assert.ok(!JSON.stringify(response).includes('sensitive'));
    }
});

test('refus des endpoints arbitraires, cles invalides, mauvais VAPID et gros messages', async t => {
    let calls = 0;
    const url = await withServer(t, async () => { calls++; return { statusCode: 201 }; });
    for (const endpoint of [
        'http://fcm.googleapis.com/send/test',
        'https://127.0.0.1/private',
        'https://169.254.169.254/latest/meta-data',
        'https://fcm.googleapis.com.attacker.invalid/send',
        'https://fcm.googleapis.com@attacker.invalid/send',
        'https://fcm.googleapis.com:8443/send',
        'https://fcm.googleapis.com/send#fragment',
        'https://attacker.invalid/send'
    ]) {
        const body = requestBody();
        body.subscription.endpoint = endpoint;
        assert.equal((await post(url, body)).status, 400, endpoint);
    }
    const broken = requestBody();
    broken.subscription.keys.p256dh = Buffer.alloc(65).toString('base64url');
    assert.equal((await post(url, broken)).status, 400);
    const mismatch = requestBody();
    mismatch.vapidPublicKey = webpush.generateVAPIDKeys().publicKey;
    assert.equal((await post(url, mismatch)).status, 409);
    const large = requestBody();
    large.payload.body = '🃏'.repeat(1100);
    assert.equal((await post(url, large)).status, 413);
    large.payload.body = 'a'.repeat(18000);
    assert.equal((await post(url, large)).status, 413);
    assert.equal((await post(url, '{bad')).status, 400);
    assert.equal((await post(url, requestBody(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(calls, 0);
});

test('saturation : refus temporaire avant de contacter le fournisseur', async t => {
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const url = await withServer(t, async () => {
        entered();
        await new Promise(resolve => { release = resolve; });
        return { statusCode: 201 };
    }, { maxConcurrent: 1 });
    const first = post(url, requestBody());
    await started;
    try {
        const second = await post(url, requestBody());
        assert.equal(second.status, 503);
        assert.equal(second.body.expired, false);
        assert.equal(second.body.retryable, true);
    } finally {
        release();
        assert.equal((await first).body.success, true);
    }
});

test('HTTPS direct sur le port configure, certificat verifie et authentification conservee', async t => {
    const https = require('node:https');
    const certFile = path.join(__dirname, 'fixtures', 'localhost-cert.pem');
    const keyFile = path.join(__dirname, 'fixtures', 'localhost-key.pem');
    assert.equal(config.port, 3184);
    assert.throws(() => loadConfig(Object.assign({}, env, { TLS_CERT_FILE: certFile })), /ensemble/);
    const tlsConfig = loadConfig(Object.assign({}, env, { TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile }));
    assert.equal(tlsConfig.host, '0.0.0.0');
    const server = createRelayServer(tlsConfig, async () => { throw new Error('unexpected push'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    async function health(token) {
        return new Promise((resolve, reject) => {
            const req = https.get({
                hostname: '127.0.0.1',
                port: server.address().port,
                path: '/health',
                ca: fs.readFileSync(certFile),
                rejectUnauthorized: true,
                headers: { 'X-Internal-Secret': token }
            }, res => {
                let body = '';
                res.on('data', chunk => { body += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
                res.on('error', reject);
            });
            req.on('error', reject);
        });
    }
    const accepted = await health(secret);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.ok, true);
    assert.equal((await health('incorrect')).status, 401);
});
