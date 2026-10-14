'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const webpush = require('web-push');
const { createRelayServer } = require('../server');
const { loadConfig } = require('../config');

// Optionnel hors du poste de developpement : renseigner ces chemins pour le test PHP reel.
const php = process.env.TAROT_PHP_BIN;
const site = process.env.TAROT_PHP_SITE;
const curlExtension = process.env.TAROT_PHP_CURL_EXTENSION;

async function runPhp(args, input) {
    return new Promise((resolve, reject) => {
        const child = spawn(php, args, { windowsHide: true });
        let out = '';
        let err = '';
        child.stdout.on('data', data => { out += data; });
        child.stderr.on('data', data => { err += data; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(out) : reject(new Error(out + '\n' + err)));
        child.stdin.end(JSON.stringify(input));
    });
}

test('integration PHP sans OpenSSL/GMP : streams et cURL, journaux et erreurs', {
    skip: !php || !site ? 'Configurer TAROT_PHP_BIN et TAROT_PHP_SITE pour ce test' : false
}, async t => {
    const vapid = webpush.generateVAPIDKeys();
    const config = loadConfig({
        NODE_INTERNAL_SECRET: crypto.randomBytes(32).toString('hex'),
        PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
        PUSH_VAPID_PRIVATE_KEY: vapid.privateKey
    });
    const receiver = crypto.createECDH('prime256v1');
    receiver.generateKeys();
    const sent = [];
    const server = createRelayServer(config, async (subscription, payload, options) => {
        const decoded = JSON.parse(payload);
        assert.equal(decoded.title, 'Message reçu');
        assert.equal(decoded.body, 'Bonjour & merci');
        assert.equal(decoded.id, 42);
        assert.equal(decoded.tag, 'message-42');
        assert.equal(options.TTL, 60);
        sent.push(subscription.endpoint);
        if (subscription.endpoint.endsWith('/success')) return { statusCode: 201 };
        const error = new Error('simulated push response');
        error.statusCode = subscription.endpoint.endsWith('/expired') ? 410 : 503;
        throw error;
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const fixture = {
        url: 'http://127.0.0.1:' + server.address().port + '/push',
        secret: config.secret,
        vapidPublicKey: vapid.publicKey,
        subscription: {
            endpoint: 'https://fcm.googleapis.com/fcm/send/success',
            p256dh: receiver.getPublicKey().toString('base64url'),
            auth: crypto.randomBytes(16).toString('base64url')
        }
    };
    const script = path.join(site, 'tools', 'test_push_relay.php');
    const out = await runPhp(['-n', script, '--integration'], fixture);
    assert.match(out, /HTTP streams/);
    assert.equal(sent.length, 3);
    if (curlExtension) {
        const curl = await runPhp(['-n', '-d', 'extension=' + curlExtension, script, '--integration'], fixture);
        assert.match(curl, /HTTP cURL/);
        assert.equal(sent.length, 6);
    }
});
