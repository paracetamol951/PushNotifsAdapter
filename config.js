'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const webpush = require('web-push');

function integer(value, fallback, min, max, name) {
    const number = value === undefined || value === '' ? fallback : Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new Error(name + ' invalide');
    }
    return number;
}

function base64Key(value, bytes, name) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
        throw new Error(name + ' invalide');
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== bytes || decoded.toString('base64url') !== value.replace(/=+$/, '')) {
        throw new Error(name + ' invalide');
    }
    return decoded;
}

function loadConfig(env = process.env, baseDirectory = __dirname) {
    const secret = env.NODE_INTERNAL_SECRET || '';
    if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
        throw new Error('NODE_INTERNAL_SECRET requis : 32 a 512 caracteres ASCII sans espaces');
    }
    let privateKey = (env.PUSH_VAPID_PRIVATE_KEY || '').trim();
    const privateFile = (env.PUSH_VAPID_PRIVATE_KEY_FILE || '').trim();
    if (privateFile && privateKey) {
        throw new Error('Renseigner une seule source de cle privee VAPID');
    }
    if (privateFile) {
        const key = crypto.createPrivateKey(fs.readFileSync(path.resolve(baseDirectory, privateFile)));
        const jwk = key.export({ format: 'jwk' });
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) {
            throw new Error('Le PEM VAPID doit contenir une cle privee P-256');
        }
        privateKey = jwk.d;
    }
    const privateBytes = base64Key(privateKey, 32, 'PUSH_VAPID_PRIVATE_KEY');
    const publicBytes = base64Key((env.PUSH_VAPID_PUBLIC_KEY || '').trim(), 65, 'PUSH_VAPID_PUBLIC_KEY');
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    if (!crypto.timingSafeEqual(ecdh.getPublicKey(), publicBytes)) {
        throw new Error('La cle publique VAPID ne correspond pas a la cle privee');
    }
    const vapidDetails = {
        subject: (env.PUSH_VAPID_SUBJECT || 'mailto:contact@jeu-tarot-en-ligne.com').trim(),
        publicKey: publicBytes.toString('base64url'),
        privateKey: privateBytes.toString('base64url')
    };
    // Validation de la configuration au demarrage, sans appel reseau.
    webpush.getVapidHeaders('https://fcm.googleapis.com', vapidDetails.subject,
        vapidDetails.publicKey, vapidDetails.privateKey, 'aes128gcm');
    const certFile = (env.TLS_CERT_FILE || '').trim();
    const keyFile = (env.TLS_KEY_FILE || '').trim();
    if (Boolean(certFile) !== Boolean(keyFile)) {
        throw new Error('TLS_CERT_FILE et TLS_KEY_FILE doivent etre renseignes ensemble');
    }
    let tlsOptions = null;
    if (certFile) {
        tlsOptions = {
            cert: fs.readFileSync(path.resolve(baseDirectory, certFile)),
            key: fs.readFileSync(path.resolve(baseDirectory, keyFile)),
            minVersion: 'TLSv1.2'
        };
        tls.createSecureContext(tlsOptions);
    }
    return {
        tls: tlsOptions,
        host: env.HOST || (tlsOptions ? '0.0.0.0' : '127.0.0.1'),
        port: integer(env.PORT, 3184, 1, 65535, 'PORT'),
        secret,
        vapidDetails,
        timeout: integer(env.PUSH_TIMEOUT_MS, 8000, 1000, 10000, 'PUSH_TIMEOUT_MS'),
        maxConcurrent: integer(env.PUSH_MAX_CONCURRENT, 32, 1, 256, 'PUSH_MAX_CONCURRENT')
    };
}

module.exports = { loadConfig, base64Key };
