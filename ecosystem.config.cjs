const path = require("path");
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: "smk-api",
      script: "server.js",
      cwd: path.join(ROOT, "live-tv-api"),
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 999,
      env: { PORT: "3000", NODE_ENV: "production" },
      log_file: path.join(ROOT, "logs", "api.log"),
      error_file: path.join(ROOT, "logs", "api-error.log"),
      merge_logs: true,
    },
    {
      name: "smk-controller",
      script: "server.cjs",
      cwd: path.join(ROOT, "live-tv-controller-react"),
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 999,
      env: { PORT: "3004", NODE_ENV: "production" },
      log_file: path.join(ROOT, "logs", "controller.log"),
      error_file: path.join(ROOT, "logs", "controller-error.log"),
      merge_logs: true,
    },
  ],
};
