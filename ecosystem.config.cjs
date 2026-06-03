const path = require("node:path");

const root = __dirname;

module.exports = {
  apps: [
    {
      name: "meteora-bot",
      cwd: root,
      script: "dist/cli.js",
      args: ["start", "--config", path.join(root, "src", "config", "user-config.json")],
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "800M",
      kill_timeout: 10000,
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
      merge_logs: true,
      error_file: path.join(root, "logs", "pm2-error.log"),
      out_file: path.join(root, "logs", "pm2-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "meteora-web",
      cwd: path.join(root, "web"),
      script: "node_modules/next/dist/bin/next",
      args: ["start", "-p", "4555"],
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      merge_logs: true,
      error_file: path.join(root, "logs", "pm2-web-error.log"),
      out_file: path.join(root, "logs", "pm2-web-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
