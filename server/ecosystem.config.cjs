module.exports = {
  apps: [
    {
      name: 'atmos-payment',
      script: 'index.js',
      cwd: '/home/ubuntu/swipies__ai_/atmos payment system/server',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      restart_delay: 2000,
      max_restarts: 1000,
      min_uptime: '5s',
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
  ],
};
