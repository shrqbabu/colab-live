// PM2 Config — Unified Google Cloud Shell & Colab 24/7 Automation
// Usage: pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: 'google-automation-manager',
      script: './server.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      max_memory_restart: '1200M',
      kill_timeout: 10000,
      out_file: './pm2_out.log',
      error_file: './pm2_err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 80,
        HEADLESS: 'true',
      },
    },
  ],
};
