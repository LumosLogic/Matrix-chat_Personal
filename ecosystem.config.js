module.exports = {
  apps: [
    {
      name: 'matrix-server',
      script: 'src/index.js',
      cwd: 'C:/matrix-server',
      restart_delay: 5000,
      max_restarts: 10,
    },
    {
      name: 'invite-bot',
      script: 'index.js',
      cwd: 'C:/matrix-server/matrix-invite-bot',
      restart_delay: 5000,
      max_restarts: 10,
      // Wait for Synapse to be ready before starting
      wait_ready: false,
    },
    {
      name: 'ai-bot',
      script: 'index.js',
      cwd: 'C:/matrix-server/matrix-ai-bot',
      restart_delay: 5000,
      max_restarts: 10,
      wait_ready: false,
    },
  ],
};
