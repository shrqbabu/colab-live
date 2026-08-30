// PM2 Config — VPS pe 24/7 Web Dashboard aur Playwright Worker chalane ke liye
// Use: pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: 'colab-pro-vps',
      script: './server.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      max_memory_restart: '800M',
      kill_timeout: 10000,
      out_file: './pm2_out.log',
      error_file: './pm2_err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HEADLESS: 'true',
      },
    },
  ],
};