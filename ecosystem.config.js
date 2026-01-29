/**
 * PM2 Ecosystem Configuration for Wolt Sync System
 */

module.exports = {
  apps: [
    {
      name: 'wolt-sync-all',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        SYNC_INTERVAL_MINUTES: '15'
      },
      error_file: './logs/all-stores-err.log',
      out_file: './logs/all-stores-out.log',
      time: true,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
