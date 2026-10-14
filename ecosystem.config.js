'use strict';

// Les secrets et le port restent dans .env, charge par server.js.
module.exports = {
    apps: [{
        name: 'tarot-push',
        cwd: __dirname,
        script: './server.js',
        interpreter: process.execPath,
        exec_mode: 'fork',
        instances: 1,
        watch: false,
        autorestart: true,
        restart_delay: 5000,
        kill_timeout: 15000,
        time: true,
        env: { NODE_ENV: 'production' }
    }]
};
