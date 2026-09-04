// ecosystem.config.js — PM2 process definitions for ASHS
module.exports = {
  apps: [
    {
      name: "ashs",
      script: "bun",
      args: "run src/index.ts",
      cwd: "/opt/ashs",
      env_file: "/opt/ashs/.env",
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/var/log/ashs/error.log",
      out_file: "/var/log/ashs/out.log",
      merge_logs: true,
    },
  ],
};
