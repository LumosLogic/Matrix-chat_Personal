const path = require('path');
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'cloudflare-tunnel',
      script: '/usr/local/bin/cloudflared',
      args: 'tunnel --url http://localhost:3000',
      interpreter: 'none',
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      // Both stdout and stderr go to tunnel.log so the server can read the URL from it
      out_file: path.join(ROOT, 'tunnel.log'),
      error_file: path.join(ROOT, 'tunnel.log'),
      merge_logs: true,
    },
    {
      name: 'matrix-server',
      script: 'src/index.js',
      cwd: ROOT,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: 5000,
    },
    // invite-bot and ai-bot disabled — start manually when needed:
    // pm2 start ecosystem.config.js --only invite-bot
    // pm2 start ecosystem.config.js --only ai-bot
  ],
};
