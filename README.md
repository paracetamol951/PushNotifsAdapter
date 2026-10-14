# Relais Web Push du Tarot

Ce service reçoit les abonnements et messages du site PHP et effectue le chiffrement,
la signature VAPID et l'envoi avec la bibliothèque [web-push](https://github.com/web-push-libs/web-push).
Il n'accède pas à la base SQL. Les préférences, la sélection des destinataires,
la déduplication et les journaux restent dans PHP.

## Installation

Node.js 22 ou ultérieur.

    npm ci --omit=dev
    cp .env.example .env

Sous PowerShell, remplacer la dernière commande par :

    Copy-Item .env.example .env

Renseigner dans `.env` :

- `NODE_INTERNAL_SECRET` : secret dédié, aléatoire, au moins 32 caractères, identique à
  `$pushRelaySecret` côté PHP. Génération possible :
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
- `PUSH_VAPID_PUBLIC_KEY` : clé publique actuellement utilisée par le site.
- `PUSH_VAPID_PRIVATE_KEY` : clé privée actuelle en base64url, **ou**
  `PUSH_VAPID_PRIVATE_KEY_FILE` : chemin d'un PEM P-256 existant.
- `PUSH_VAPID_SUBJECT` : contact VAPID, déjà renseigné pour le site.
- `PORT` : `3184`. URL prévue côté PHP : `https://push.net-assembly.com:3184/push`.
- `TLS_CERT_FILE` / `TLS_KEY_FILE` : certificat avec sa chaîne complète et clé TLS
  pour servir HTTPS directement. Par exemple les fichiers Let’s Encrypt
  `/etc/letsencrypt/live/push.net-assembly.com/fullchain.pem` et `privkey.pem`.
  Le certificat doit couvrir `push.net-assembly.com` et être lisible par le compte du service.
- `HOST` : si vide, écoute sur `0.0.0.0` avec TLS, ou `127.0.0.1` sans TLS.

Ne pas générer une nouvelle paire VAPID pour cette migration : les abonnements existants
doivent continuer à utiliser la même clé publique. Le serveur vérifie la correspondance
entre clés publique et privée au démarrage, et la clé publique fournie par PHP à chaque envoi.
Les secrets ne sont pas fournis dans le dépôt. `.env` et les PEM sont ignorés par Git.

    npm start

`server.js` charge automatiquement `.env` depuis son propre dossier. Les variables
déjà présentes dans l'environnement gardent priorité.

## Reprendre les clés du système PHP existant

Les clés VAPID identifient le site auprès des services push. Elles sont distinctes
du certificat HTTPS du relais. Conserver la paire VAPID existante pour préserver
les abonnements des navigateurs.

Dans le code PHP actuel :

| Variable Node | Source dans le site PHP |
| --- | --- |
| `PUSH_VAPID_PUBLIC_KEY` | Valeur de `$pushVapidPublicKey` dans `includes/pushLocalConfig.php`. |
| `PUSH_VAPID_SUBJECT` | Valeur de `$pushVapidSubject` dans le même fichier : `mailto:contact@jeu-tarot-en-ligne.com`. C'est une adresse de contact, pas une clé ni un certificat. |
| `PUSH_VAPID_PRIVATE_KEY` | Valeur de `$pushVapidPrivateKeyI` dans `includes/admin.php`. `pushLocalConfig.php` référence cette variable ; dans la copie inspectée, c'est une clé base64url. |
| `PUSH_VAPID_PRIVATE_KEY_FILE` | Laisser vide avec cette configuration. Cette option sert uniquement si l'ancienne clé VAPID privée est stockée dans un fichier PEM. |

Copier les valeurs depuis la configuration de production qui a créé les abonnements ;
vérifier qu'elle utilise bien la même paire que la copie de développement inspectée.
Copier seulement le contenu entre guillemets, sans le nom de variable PHP ni le point-virgule.
Ne pas remplacer une clé existante par une nouvelle paire pendant cette migration.
Ne pas mettre le certificat HTTPS ni sa clé privée dans les champs VAPID.

Exemple `.env` pour le format utilisé actuellement :

    PUSH_VAPID_PUBLIC_KEY=COLLER_LA_CLE_PUBLIQUE_EXISTANTE
    PUSH_VAPID_SUBJECT=mailto:contact@jeu-tarot-en-ligne.com
    PUSH_VAPID_PRIVATE_KEY=COLLER_LA_VALEUR_DE_pushVapidPrivateKeyI
    PUSH_VAPID_PRIVATE_KEY_FILE=

Les deux variables de clé privée sont des alternatives : en renseigner une seule.
Si la production utilise finalement un PEM VAPID, copier ce fichier sur le serveur Node,
renseigner son nouveau chemin dans `PUSH_VAPID_PRIVATE_KEY_FILE` et vider
`PUSH_VAPID_PRIVATE_KEY`. Un PEM VAPID peut être conservé tel quel, sans conversion.

Le certificat HTTPS se configure séparément via `TLS_CERT_FILE` et `TLS_KEY_FILE`.
Il doit couvrir `push.net-assembly.com` ; un certificat existant couvrant ce nom
(par exemple `*.net-assembly.com`) peut convenir. Les fichiers Let’s Encrypt
`fullchain.pem` et `privkey.pem` de ce domaine servent à TLS, pas à VAPID.
Le troisième secret, `NODE_INTERNAL_SECRET`, authentifie les appels PHP vers Node ;
il doit être identique à `$pushRelaySecret`, et distinct de la clé privée VAPID.

## Connexion depuis les anciens PHP

Le domaine prévu est `push.net-assembly.com`, avec HTTPS sur le port `3184`.
Configurer son DNS vers le serveur Node et autoriser le port TCP 3184 pour les serveurs PHP.

Pour HTTPS direct, renseigner les deux chemins TLS dans `.env`. Node vérifie
le certificat et la clé au démarrage et utilise TLS 1.2 au minimum. Redémarrer le
service après renouvellement du certificat pour recharger les fichiers.

Un reverse proxy HTTPS reste possible : laisser les champs TLS vides et conserver
Node sur une adresse locale. Le proxy doit servir le domaine et le port publics
ci-dessus et transmettre les requêtes au port interne choisi dans `PORT`.
Choisir un autre port interne si le proxy occupe déjà 3184 sur toutes les interfaces.
Autoriser uniquement les IP des serveurs PHP au niveau du pare-feu ou du proxy si possible.
Le header `X-Internal-Secret` doit être transmis sans être enregistré dans les logs.

Sans extension OpenSSL PHP, cURL peut encore prendre en charge HTTPS selon sa compilation.
Il faut vérifier la connexion depuis la production. Le client du relais conserve la
vérification TLS ; il n'utilise pas le réglage historique `pushSslVerifyPeer`.

Sans aucun transport TLS disponible, joindre une IP privée à travers un réseau de
confiance ou un tunnel pris en charge hors de PHP. HTTP n'est accepté par le client
PHP que sur `localhost`, `::1`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12` ou
`192.168.0.0/16`, avec `$pushRelayAllowHttp = true`. Une IP privée seule ne garantit
pas la confidentialité du réseau. Ne jamais envoyer le secret en HTTP sur Internet.

Dans `includes/pushLocalConfig.php` du site :

    $pushRelayUrl = "https://push.net-assembly.com:3184/push";
    $pushRelaySecret = "MEME_SECRET_ALEATOIRE_QUE_NODE_INTERNAL_SECRET";
    $pushRelayTimeout = 15;
    $pushRelayCaInfo = ""; // Facultatif : fichier CA pour le relais.
    $pushRelayAllowHttp = false;

Pour un tunnel local, par exemple :

    $pushRelayUrl = "http://127.0.0.1:3184/push";
    $pushRelayAllowHttp = true;

Une URL non vide sélectionne le relais pour tous les envois, indépendamment des
extensions PHP. Une URL vide conserve l'envoi PHP historique.
Les mêmes options sont disponibles par variables d'environnement
`TAROT_PUSH_RELAY_URL`, `TAROT_PUSH_RELAY_SECRET`, `TAROT_PUSH_RELAY_TIMEOUT`,
`TAROT_PUSH_RELAY_CA_INFO` et `TAROT_PUSH_RELAY_ALLOW_HTTP`.
Les valeurs renseignées dans `pushLocalConfig.php` ont priorité, même si elles sont vides.

Conserver `$pushVapidPublicKey` côté PHP. La clé privée PHP n'est plus nécessaire en
mode relais, mais elle reste nécessaire si l'on réactive l'ancien transport.
Aucune modification SQL, JavaScript navigateur ou service worker n'est nécessaire.

## API

Toutes les routes, y compris `/health`, exigent :

    X-Internal-Secret: <NODE_INTERNAL_SECRET>

`GET /health` renvoie l'état de l'API et la clé publique VAPID. Il ne teste pas
la connectivité avec les fournisseurs push.

`POST /push`, avec `Content-Type: application/json` :

    {
      "vapidPublicKey": "CLE_PUBLIQUE_VAPID_ACTUELLE",
      "subscription": {
        "endpoint": "https://fcm.googleapis.com/fcm/send/...",
        "keys": { "p256dh": "...", "auth": "..." }
      },
      "payload": {
        "id": 42,
        "title": "Nouveau message",
        "body": "Vous avez reçu un message.",
        "url": "/messages",
        "tag": "message-42"
      },
      "options": { "ttl": 3600, "urgency": "normal", "topic": "message-42" }
    }

`ttl`, `urgency` et `topic` sont facultatifs. Le corps HTTP est limité à 16 Kio ;
le payload à 3993 octets UTF-8. Les seuls endpoints admis sont ceux de Google,
Mozilla, Apple et Windows listés dans `validEndpoint()`, en HTTPS sur le port standard.
La liste doit être revue si un nouveau fournisseur est ajouté.

Un HTTP 200 indique que le relais renvoie un **résultat d'envoi** :

    {
      "relay": "tarot-push-v1",
      "success": true,
      "expired": false,
      "retryable": false,
      "statusCode": 201,
      "error": ""
    }

`success` signifie accepté par le fournisseur, pas nécessairement affiché sur l'appareil.
Un fournisseur répondant 404 ou 410 entraîne `expired: true` et la désactivation
de cet abonnement par PHP. Une erreur 404 du relais ou du reverse proxy ne désactive rien.
Les erreurs d'authentification/configuration/format utilisent un HTTP 4xx ;
un relais saturé répond HTTP 503. Les autres échecs fournisseur sont journalisés
côté PHP sans désactiver l'abonnement.

Le service ne stocke aucune file d'attente et ne réessaie pas automatiquement.
PHP ne retente pas non plus l'envoi via son ancien transport après une erreur du relais :
un délai dépassé pourrait cacher un message déjà accepté et provoquer un doublon.
Une notification en échec reste en erreur dans le journal existant.
`retryable` indique la nature temporaire de l'erreur ; il ne déclenche pas de reprise.

## Lancement avec PM2

Le fichier `ecosystem.config.js` lance un processus nommé `tarot-push` avec
redémarrage automatique et un délai d'arrêt de 15 secondes. Les secrets restent
dans `.env`. Utiliser le même compte Unix que pour les autres applications PM2
et un Node.js 22 ou ultérieur.

Depuis le dossier installé sur le serveur, après configuration de `.env` :

    npm ci --omit=dev
    pm2 start ecosystem.config.js --only tarot-push
    pm2 save
    pm2 logs tarot-push

Si PM2 redémarre déjà avec la machine, `pm2 save` suffit pour ajouter ce service
à la liste restaurée. Sinon, exécuter `pm2 startup`, suivre la commande affichée
par PM2, puis `pm2 save`.

Après une modification de `.env` ou un renouvellement des certificats TLS :

    pm2 restart tarot-push

Si les variables sont fournies par l'environnement du shell plutôt que par `.env` :

    pm2 restart ecosystem.config.js --only tarot-push --update-env

Les variables déjà présentes dans l'environnement ont priorité sur `.env`.
Le compte qui lance PM2 doit pouvoir lire les certificats et la clé TLS.
Aucun service systemd propre au relais n'est nécessaire : PM2 gère son processus.

Les réponses et erreurs détaillées par abonnement restent consultables dans
les journaux PHP existants. Le relais n'écrit ni les secrets, ni les endpoints,
ni le contenu des notifications dans ses logs.

Documentation PM2 : [fichier ecosystem](https://pm2.keymetrics.io/docs/usage/application-declaration/)
et [restauration au démarrage](https://pm2.keymetrics.io/docs/usage/startup/).

## Vérification

    npm test

Les tests Node utilisent un fournisseur simulé ; aucun push réel n'est envoyé.
Le chiffrement et la signature VAPID sont aussi vérifiés avec la vraie bibliothèque.
Les certificats de test dans `test/fixtures` sont publics, factices et réservés à localhost ;
ils ne doivent jamais être utilisés en production. Un test vérifie HTTPS avec validation
complète du certificat et authentification par le secret.

Pour inclure l'intégration avec un véritable PHP 5.4, sous PowerShell :

    $env:TAROT_PHP_BIN = "D:\WorkspacePHP\Tarot\output\php54-audit\runtime\php.exe"
    $env:TAROT_PHP_SITE = "D:\WorkspacePHP\Tarot"
    $env:TAROT_PHP_CURL_EXTENSION = "D:\WorkspacePHP\Tarot\output\php54-audit\runtime\ext\php_curl.dll"
    npm test

Le test exécute PHP avec `-n`, sans OpenSSL ni GMP, une fois avec les streams natifs,
puis avec cURL si le chemin d'extension est fourni. Il copie les classes dans une
configuration temporaire isolée et n'ouvre aucune connexion SQL.
Test PHP seul, depuis le dossier du site :

    output\php54-audit\runtime\php.exe -n tools\test_push_relay.php

Après déploiement, vérifier `/health` avec le secret, puis effectuer un envoi réel
vers un abonnement de test avant d'activer le relais sur tous les serveurs PHP.
