/**
 * PM2 Ecosystem Config — Factory Stack Node.js Processes
 *
 * Manages the two long-lived Node.js processes in the dispatch stack:
 *   1. oc-daemon  — SSE event stream → Dolt punch writer (flight recorder)
 *   2. temporal-worker — Temporal task queue poller for agent-tasks
 *
 * Usage (from repo root):
 *   npx --prefix daemon pm2 start .kilocode/tools/ecosystem.config.cjs
 *   npx --prefix daemon pm2 status
 *   npx --prefix daemon pm2 logs
 *   npx --prefix daemon pm2 stop all
 *   npx --prefix daemon pm2 restart all
 *
 * Native binaries (kilo serve, Dolt, Temporal server) are NOT managed by pm2
 * because they aren't Node.js processes. start-stack.sh handles those directly.
 */

const path = require("path");

// Resolve paths relative to the repo root (two levels up from .kilocode/tools/)
const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const DAEMON_DIR = path.join(REPO_ROOT, "daemon");

module.exports = {
  apps: [
    {
      name: "oc-daemon",
      cwd: DAEMON_DIR,
      script: "src/index.ts",
      interpreter: path.join(DAEMON_DIR, "node_modules/.bin/tsx"),
      env: {
        KILO_HOST: process.env.KILO_HOST || "127.0.0.1",
        KILO_PORT: process.env.KILO_PORT || "4096",
        DOLT_PORT: process.env.DOLT_PORT || "3307",
        DOLT_DATABASE: process.env.DOLT_DATABASE || "factory",
      },
      // Restart on crash with exponential backoff (max 30s)
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 1000,
      // Logs
      error_file: "/tmp/oc-daemon-error.log",
      out_file: "/tmp/oc-daemon.log",
      merge_logs: true,
      // Don't watch files — we restart explicitly via start-stack.sh
      watch: false,
    },
    {
      name: "temporal-worker",
      cwd: DAEMON_DIR,
      script: "src/temporal/worker.ts",
      interpreter: path.join(DAEMON_DIR, "node_modules/.bin/tsx"),
      env: {
        TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS || "localhost:7233",
        TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE || "default",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 1000,
      error_file: "/tmp/temporal-worker-error.log",
      out_file: "/tmp/temporal-worker.log",
      merge_logs: true,
      watch: false,
    },
  ],
};
