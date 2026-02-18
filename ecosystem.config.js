const path = require('path');
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'cloudflare-tunnel',
      script: '/usr/local/opt/cloudflared/bin/cloudflared',
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
      restart_delay: 5000,
      max_restarts: 10,
    },
    {
      name: 'invite-bot',
      script: 'index.js',
      cwd: path.join(ROOT, 'matrix-invite-bot'),
      restart_delay: 5000,
      max_restarts: 10,
      wait_ready: false,
    },
    {
      name: 'ai-bot',
      script: 'index.js',
      cwd: path.join(ROOT, 'matrix-ai-bot'),
      restart_delay: 5000,
      max_restarts: 10,
      wait_ready: false,
    },
  ],
};
