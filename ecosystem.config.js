module.exports = {
  apps: [
    {
      name: 'matrix-server',
      script: 'src/index.js',
      cwd: '/Users/nipampranav/Downloads/LUMOS LOGIC/matrix-server',
      restart_delay: 5000,
      max_restarts: 10,
    },
    {
      name: 'invite-bot',
      script: 'index.js',
      cwd: '/Users/nipampranav/Downloads/LUMOS LOGIC/matrix-server/matrix-invite-bot',
      restart_delay: 5000,
      max_restarts: 10,
      wait_ready: false,
    },
    {
      name: 'ai-bot',
      script: 'index.js',
      cwd: '/Users/nipampranav/Downloads/LUMOS LOGIC/matrix-server/matrix-ai-bot',
      restart_delay: 5000,
      max_restarts: 10,
      wait_ready: false,
    },
  ],
};
