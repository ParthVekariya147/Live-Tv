const path = require("path");
const { loadEnv } = require("./env-loader.cjs");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const API_PORT = process.env.API_PORT || "3000";
const CONTROLLER_PORT = process.env.CONTROLLER_PORT || "3004";

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
      env: { PORT: API_PORT, NODE_ENV: "production" },
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
      env: { PORT: CONTROLLER_PORT, NODE_ENV: "production" },
      log_file: path.join(ROOT, "logs", "controller.log"),
      error_file: path.join(ROOT, "logs", "controller-error.log"),
      merge_logs: true,
    },
  ],
};
