/**
 * Dolt Server Lifecycle Management
 *
 * Replaces the shell-based rogue detection / database validation logic
 * from dolt_start.sh with proper MySQL protocol queries and Node.js
 * process management.
 *
 * Responsibilities:
 *   - Validate the running Dolt server has the required databases
 *   - Detect rogue servers (started by bd from .beads/dolt/)
 *   - Kill rogue servers and clear bd's cached state files
 *   - Start the canonical server from the correct data directory
 *   - Report health status
 *
 * See: repomap-core-4hw
 */

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, readlinkSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { sleep } from "./utils.js";

// ── Configuration ────────────────────────────────────────────────────────

export interface DoltLifecycleConfig {
  /** Canonical Dolt data directory (default: ~/.dolt-data/beads) */
  dataDir: string;
  /** Server host (default: 127.0.0.1) */
  host: string;
  /** Server port (default: 3307) */
  port: number;
  /** MySQL user (default: root) */
  user: string;
  /** MySQL password (default: empty string) */
  password: string;
  /** Path to dolt binary */
  doltBin: string;
  /** Databases that MUST be present on the server */
  requiredDatabases: string[];
  /** .beads directories to clear state files from */
  beadsDirs: string[];
  /** Server log file path */
  logFile: string;
}

const HOME = process.env.HOME ?? "/home/user";

function resolveDoltBin(): string {
  const envBin = process.env.DOLT_BIN || "";
  if (envBin !== "") return envBin;
  const localBin = join(HOME, ".local/bin/dolt");
  if (existsSync(localBin)) return localBin;
  return "dolt";
}

export function defaultConfig(): DoltLifecycleConfig {
  const doltBin = resolveDoltBin();

  return {
    dataDir: process.env.DOLT_DATA_DIR ?? join(HOME, ".dolt-data/beads"),
    host: "127.0.0.1",
    port: 3307,
    user: "root",
    password: "",
    doltBin,
    requiredDatabases: ["beads_repomap-core", "punch_cards"],
    beadsDirs: [
      // Both clones
      join(HOME, "Projects/repomap-core/.beads"),
      join(HOME, "Projects-Employee-1/repomap-core/.beads"),
    ],
    logFile: process.env.DOLT_LOG_FILE ?? join(HOME, ".dolt-data/dolt-server.log"),
  };
}

// ── Types ────────────────────────────────────────────────────────────────

export type ServerStatus =
  | { state: "healthy"; pid: number; databases: string[] }
  | { state: "rogue"; pid: number; databases: string[]; missing: string[] }
  | { state: "down" };

export interface EnsureResult {
  action: "already_healthy" | "killed_rogue_and_started" | "started" | "failed";
  pid?: number;
  message: string;
}

// ── bd state file management ─────────────────────────────────────────────

/** Files that bd creates to cache its managed server state. */
const BD_STATE_FILES = [
  "dolt-server.port",
  "dolt-server.pid",
  "dolt-server.lock",
  "dolt-server.activity",
  "dolt-server.log",
  "dolt-monitor.pid",
  "dolt-monitor.pid.lock",
];

/**
 * Clear bd's cached server state files from all known .beads directories.
 * Returns the number of files removed.
 */
export function clearBdStateFiles(config: DoltLifecycleConfig): number {
  let cleared = 0;
  for (const beadsDir of config.beadsDirs) {
    if (!existsSync(beadsDir)) continue;
    for (const f of BD_STATE_FILES) {
      const path = join(beadsDir, f);
      try {
        if (existsSync(path)) {
          unlinkSync(path);
          cleared++;
        }
      } catch {
        // Ignore permission errors on files we don't own
      }
    }
  }
  return cleared;
}

function clearBdStateFilesWithLog(
  config: DoltLifecycleConfig,
  log: (msg: string) => void,
): number {
  const cleared = clearBdStateFiles(config);
  if (cleared > 0) {
    log(`  Cleared ${cleared} stale bd state files`);
  }
  return cleared;
}

// ── Server validation ────────────────────────────────────────────────────

/**
 * Query the running Dolt server for its databases via the MySQL protocol.
 * Returns the list of database names, or null if the server is unreachable.
 */
export async function queryServerDatabases(
  config: DoltLifecycleConfig,
  timeoutMs = 5000,
): Promise<string[] | null> {
  let connection: mysql.Connection | undefined;
  try {
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      connectTimeout: timeoutMs,
    });
    const [rows] = await connection.query("SHOW DATABASES");
    const databases = (rows as Array<Record<string, string>>).map(
      (row) => Object.values(row)[0],
    );
    return databases;
  } catch {
    return null;
  } finally {
    if (connection) {
      await connection.end().catch(() => {});
    }
  }
}

/**
 * Check whether the running server has all required databases.
 */
export async function checkServerHealth(
  config: DoltLifecycleConfig,
): Promise<ServerStatus> {
  const databases = await queryServerDatabases(config);
  if (databases === null) {
    return { state: "down" };
  }

  const missing = config.requiredDatabases.filter(
    (db) => !databases.includes(db),
  );

  const pid = findDoltServerPid();

  if (missing.length === 0) {
    return { state: "healthy", pid: pid ?? 0, databases };
  }

  return { state: "rogue", pid: pid ?? 0, databases, missing };
}

// ── Process management ───────────────────────────────────────────────────

/**
 * Find ALL running dolt sql-server PIDs by scanning /proc.
 * This avoids depending on the external `pgrep` binary.
 */
export function findAllDoltServerPids(): number[] {
  try {
    const procEntries = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
    const results: number[] = [];
    for (const entry of procEntries) {
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
        if (cmdline.includes("dolt") && cmdline.includes("sql-server")) {
          results.push(Number.parseInt(entry, 10));
        }
      } catch {
        // Process may have exited between readdir and readFile
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Find the PID of any running dolt sql-server process.
 */
export function findDoltServerPid(): number | null {
  const pids = findAllDoltServerPids();
  return pids.length > 0 ? pids[0] : null;
}

/**
 * Get the working directory of a process (Linux /proc).
 * Returns null if not accessible.
 */
export function getProcessCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Kill all dolt sql-server processes. Sends SIGTERM, then SIGKILL after 2s.
 * Returns the list of killed PIDs.
 */
export function killAllDoltServers(): number[] {
  const pids = findAllDoltServerPids();
  if (pids.length === 0) return [];

  // SIGTERM first
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
    }
  }

  // Wait briefly, then SIGKILL any survivors
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) break;
    // Brief sync pause
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }

  // Force-kill survivors
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }

  return pids;
}

// ── Server start ─────────────────────────────────────────────────────────

/**
 * Start the Dolt SQL server with the canonical data directory.
 * Returns the PID of the new process.
 */
export function startDoltServer(config: DoltLifecycleConfig): number {
  if (!existsSync(config.dataDir)) {
    throw new Error(
      `Dolt data directory not found: ${config.dataDir}. Has beads been initialized?`,
    );
  }

  if (!existsSync(config.doltBin)) {
    throw new Error(`Dolt binary not found: ${config.doltBin}`);
  }

  const logFd = openSync(config.logFile, "a");

  const child = spawn(
    config.doltBin,
    [
      "sql-server",
      "--host",
      config.host,
      "--port",
      String(config.port),
      "--data-dir",
      config.dataDir,
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );

  // Detach so the parent can exit without killing the server
  child.unref();

  return child.pid ?? 0;
}

// ── Main orchestrator ────────────────────────────────────────────────────

/**
 * Ensure the Dolt server is running with the correct data directory and databases.
 * This is the main entry point — it handles the full lifecycle:
 *   1. Check if a server is running and healthy
 *   2. If rogue, kill it and clear bd state
 *   3. Start the correct server
 *   4. Wait for it to become healthy
 */
export async function ensureHealthy(
  config: DoltLifecycleConfig,
  log: (msg: string) => void = console.log,
): Promise<EnsureResult> {
  const status = await checkServerHealth(config);

  if (status.state === "healthy") {
    clearBdStateFilesWithLog(config, log);
    log(
      `✓ Dolt server already running on ${config.host}:${config.port} (databases verified)`,
    );
    return {
      action: "already_healthy",
      pid: status.pid,
      message: `Server healthy with databases: ${config.requiredDatabases.join(", ")}`,
    };
  }

  if (status.state === "rogue") {
    log(
      `⚠ Dolt server on ${config.host}:${config.port} is missing required databases!`,
    );
    log(`  Required: ${config.requiredDatabases.join(", ")}`);
    log(`  Found:    ${status.databases.join(", ")}`);
    log(`  Missing:  ${status.missing.join(", ")}`);
    log(`  This is likely a rogue server started by bd from .beads/dolt/`);
    log(`  Killing rogue server and restarting from ${config.dataDir}...`);

    const killed = killAllDoltServers();
    log(`  Killed ${killed.length} Dolt process(es): ${killed.join(", ")}`);

    clearBdStateFilesWithLog(config, log);

    // Wait for port to be released
    await sleep(1500);
  } else {
    // state === "down"
    clearBdStateFilesWithLog(config, log);
  }

  // Start the server
  log(
    `Starting Dolt SQL server (${config.host}:${config.port}, data-dir=${config.dataDir})...`,
  );
  const pid = startDoltServer(config);

  // Wait up to 10 seconds for the server to become healthy
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const check = await checkServerHealth(config);
    if (check.state === "healthy") {
      log(
        `✓ Dolt server started (pid=${pid}, data-dir=${config.dataDir})`,
      );
      return {
        action: status.state === "rogue" ? "killed_rogue_and_started" : "started",
        pid,
        message: `Server started with databases: ${config.requiredDatabases.join(", ")}`,
      };
    }
  }

  return {
    action: "failed",
    message: `Server did not become healthy within 10 seconds. Check ${config.logFile}`,
  };
}

/**
 * Stop the Dolt server and clean up.
 */
export async function stopServer(
  config: DoltLifecycleConfig,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const pids = killAllDoltServers();
  clearBdStateFiles(config);
  if (pids.length > 0) {
    log(`✓ Dolt server stopped (killed ${pids.length} process(es))`);
  } else {
    log("Dolt server was not running.");
  }
}
