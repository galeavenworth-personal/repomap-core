/**
 * Stack Manager — TypeScript logic module
 *
 * Replaces the shell-based health checks, start sequences, and stop logic
 * from start-stack.sh with native Node.js implementations.
 *
 * Responsibilities:
 *   - Health check for all 5 stack components (kilo serve, Dolt, oc-daemon,
 *     Temporal server, Temporal worker)
 *   - Start sequence: validate/start kilo, ensure Dolt via dolt-lifecycle.ts,
 *     apply punch card schema, ensure Temporal server, start pm2 ecosystem
 *   - Stop sequence: stop pm2 processes, kill Temporal server
 *   - Structured JSON health reports
 *
 * See: repomap-core-76q.2
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, sleep, timestamp } from "./utils.js";

import {
  checkPort,
} from "./factory-dispatch.js";

import {
  withPm2Connection,
  pm2Start,
  pm2List,
  pm2Stop,
  pm2Delete,
  isAppOnline,
} from "./pm2-client.js";

import {
  checkServerHealth as checkDoltHealth,
  ensureHealthy as ensureDoltHealthy,
  defaultConfig as doltDefaultConfig,
  type DoltLifecycleConfig,
} from "./dolt-lifecycle.js";

// ── Configuration ────────────────────────────────────────────────────────

export interface StackConfig {
  /** Kilo serve host (default: 127.0.0.1) */
  kiloHost: string;
  /** Kilo serve port (default: 4096) */
  kiloPort: number;
  /** Dolt server port (default: 3307) */
  doltPort: number;
  /** Temporal server gRPC port (default: 7233) */
  temporalPort: number;
  /** Temporal UI port (default: 8233) */
  temporalUiPort: number;
  /** Whether to manage (start) kilo serve if missing */
  manageKilo: boolean;
  /** Path to repo root */
  repoRoot: string;
  /** Path to daemon directory */
  daemonDir: string;
  /** Path to pm2 binary */
  pm2Bin: string;
  /** Path to ecosystem config */
  ecosystemConfig: string;
  /** Dolt data directory */
  doltDataDir: string;
  /** Dolt lifecycle config (derived) */
  doltConfig: DoltLifecycleConfig;
}

const HOME = process.env.HOME ?? "/home/user";

export function defaultConfig(): StackConfig {
  const repoRoot = process.env.REPO_ROOT ?? findRepoRoot();
  const daemonDir = join(repoRoot, "daemon");
  const doltDataDir = process.env.DOLT_DATA_DIR ?? join(HOME, ".dolt-data/beads");

  const doltConfig = doltDefaultConfig();

  return {
    kiloHost: process.env.KILO_HOST ?? "127.0.0.1",
    kiloPort: Number(process.env.KILO_PORT ?? "4096"),
    doltPort: Number(process.env.DOLT_PORT ?? "3307"),
    temporalPort: Number(process.env.TEMPORAL_PORT ?? "7233"),
    temporalUiPort: Number(process.env.TEMPORAL_UI_PORT ?? "8233"),
    manageKilo: true,
    repoRoot,
    daemonDir,
    pm2Bin: join(daemonDir, "node_modules/.bin/pm2"),
    ecosystemConfig: join(repoRoot, ".kilocode/tools/ecosystem.config.cjs"),
    doltDataDir,
    doltConfig,
  };
}

// ── Types ────────────────────────────────────────────────────────────────

export type ComponentName =
  | "kilo serve"
  | "Dolt server"
  | "oc-daemon"
  | "Temporal server"
  | "Temporal worker";

export interface ComponentHealth {
  name: ComponentName;
  ok: boolean;
  detail: string;
}

export interface StackHealth {
  ok: boolean;
  healthy: number;
  total: number;
  components: ComponentHealth[];
}

export type EnsureAction =
  | "all_healthy"
  | "started_missing"
  | "failed";

export interface EnsureResult {
  action: EnsureAction;
  health: StackHealth;
  message: string;
  errors: string[];
}

export type Logger = (msg: string) => void;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Resolve a binary from multiple candidate paths, then fall back to PATH.
 */
function resolveBin(name: string, ...candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const found = execFileSync("which", [name], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (found) return found;
  } catch {
    // Not on PATH
  }
  return null;
}

/**
 * Find the Temporal CLI binary.
 */
export function findTemporalCli(): string | null {
  return resolveBin(
    "temporal",
    join(HOME, ".temporalio/bin/temporal"),
    join(HOME, ".local/bin/temporal"),
  );
}

// ── Health Checks ────────────────────────────────────────────────────────

/**
 * Check if kilo serve is healthy by fetching /session and validating JSON.
 * Replaces: curl + python3 JSON validation.
 */
export async function checkKiloHealth(
  host: string,
  port: number,
  fetchFn: typeof fetch = fetch,
): Promise<ComponentHealth> {
  try {
    const resp = await fetchFn(`http://${host}:${port}/session`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      return { name: "kilo serve", ok: false, detail: `HTTP ${resp.status} from ${host}:${port}` };
    }
    const sessions = (await resp.json()) as unknown[];
    return {
      name: "kilo serve",
      ok: true,
      detail: `healthy (${sessions.length} sessions)`,
    };
  } catch {
    return {
      name: "kilo serve",
      ok: false,
      detail: `NOT reachable at ${host}:${port}`,
    };
  }
}

/**
 * Check Dolt server health via dolt-lifecycle.ts.
 * Replaces: ss port check + dolt_start.sh --check.
 */
export async function checkDoltComponent(
  config: StackConfig,
): Promise<ComponentHealth> {
  const status = await checkDoltHealth(config.doltConfig);
  switch (status.state) {
    case "healthy":
      return {
        name: "Dolt server",
        ok: true,
        detail: `port ${config.doltPort}, databases verified`,
      };
    case "rogue":
      return {
        name: "Dolt server",
        ok: false,
        detail: `port ${config.doltPort} occupied but WRONG databases (rogue server?)`,
      };
    case "down":
      return {
        name: "Dolt server",
        ok: false,
        detail: `NOT running on port ${config.doltPort}`,
      };
  }
}

/**
 * Check if a pm2 app is online using the CLI (subprocess, no lingering handles).
 */
function isPm2AppOnlineCli(pm2Bin: string, appName: string): boolean {
  try {
    const out = execFileSync(pm2Bin, ["jlist"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const procs = JSON.parse(out) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    return procs.some((p) => p.name === appName && p.pm2_env?.status === "online");
  } catch {
    return false;
  }
}

/**
 * Check oc-daemon health via pm2 jlist.
 */
export async function checkOcDaemon(pm2Bin: string): Promise<ComponentHealth> {
  const ok = isPm2AppOnlineCli(pm2Bin, "oc-daemon");
  return {
    name: "oc-daemon",
    ok,
    detail: ok ? "online (pm2, SSE → Dolt)" : "NOT running (no flight recorder!)",
  };
}

/**
 * Check Temporal server health via port check.
 * Replaces: ss -tlnp | grep :PORT.
 */
export async function checkTemporalServer(
  host: string,
  port: number,
): Promise<ComponentHealth> {
  const ok = await checkPort(host, port);
  return {
    name: "Temporal server",
    ok,
    detail: ok ? `port ${port}` : `NOT listening on port ${port}`,
  };
}

/**
 * Check Temporal worker health via pm2 jlist.
 */
export async function checkTemporalWorker(pm2Bin: string): Promise<ComponentHealth> {
  const ok = isPm2AppOnlineCli(pm2Bin, "temporal-worker");
  return {
    name: "Temporal worker",
    ok,
    detail: ok ? "online (pm2)" : "NOT running",
  };
}

/**
 * Run health check on all 5 stack components.
 * Returns a structured StackHealth object.
 */
export async function checkStack(
  config: StackConfig,
  fetchFn: typeof fetch = fetch,
): Promise<StackHealth> {
  const [kilo, dolt, ocDaemon, temporal, temporalWorker] = await Promise.all([
    checkKiloHealth(config.kiloHost, config.kiloPort, fetchFn),
    checkDoltComponent(config),
    checkOcDaemon(config.pm2Bin),
    checkTemporalServer(config.kiloHost, config.temporalPort),
    checkTemporalWorker(config.pm2Bin),
  ]);
  const components: ComponentHealth[] = [kilo, dolt, ocDaemon, temporal, temporalWorker];

  const healthy = components.filter((c) => c.ok).length;
  return {
    ok: components.every((c) => c.ok),
    healthy,
    total: components.length,
    components,
  };
}

// ── Start Sequences ──────────────────────────────────────────────────────

/**
 * Start kilo serve if not running and manageKilo is true.
 * Replaces: nohup kilo serve + poll loop.
 */
export async function ensureKilo(
  config: StackConfig,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const health = await checkKiloHealth(config.kiloHost, config.kiloPort, fetchFn);
  if (health.ok) {
    log(`${timestamp()} ✅ kilo serve already healthy on ${config.kiloHost}:${config.kiloPort}`);
    return;
  }

  if (!config.manageKilo) {
    throw new Error(
      `kilo serve is not running at ${config.kiloHost}:${config.kiloPort}. ` +
      `Start it first: kilo serve --port ${config.kiloPort}`,
    );
  }

  log(`${timestamp()} Starting kilo serve on ${config.kiloHost}:${config.kiloPort}...`);

  // kilo serve uses OAuth from 'kilo auth login' (stored in ~/.local/share/kilo/auth.json).
  // Do NOT wrap with 'op run' — that's for DSPy compilation, not kilo serve.
  // Launch via bash nohup — kilo doesn't survive Node.js spawn({detached:true}) alone
  // because it exits when the parent's process group terminates. bash nohup + disown
  // is the proven pattern for kilo specifically.
  execFileSync("bash", ["-c", `nohup kilo serve --port ${config.kiloPort} >> /tmp/kilo-serve.log 2>&1 & disown`], {
    timeout: 5000,
    stdio: "ignore",
  });

  // Wait up to 20s for kilo serve to become healthy
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const check = await checkKiloHealth(config.kiloHost, config.kiloPort, fetchFn);
    if (check.ok) {
      log(`${timestamp()} ✅ kilo serve started.`);
      return;
    }
  }

  throw new Error("kilo serve failed to start within 20s. Check /tmp/kilo-serve.log");
}

/**
 * Ensure Dolt server is running with correct databases.
 * Delegates to dolt-lifecycle.ts ensureHealthy().
 */
export async function ensureDolt(
  config: StackConfig,
  log: Logger,
): Promise<void> {
  log(`${timestamp()} Ensuring Dolt server with correct databases...`);
  const result = await ensureDoltHealthy(config.doltConfig, log);
  if (result.action === "failed") {
    throw new Error(`Dolt server failed to start: ${result.message}`);
  }
  log(`${timestamp()} ✅ Dolt server verified.`);
}

/**
 * Apply idempotent punch card schema migration.
 * Delegates to dolt_apply_punch_card_schema.sh.
 */
export function applyPunchCardSchema(config: StackConfig, log: Logger): void {
  log(`${timestamp()} Applying idempotent punch card schema migration...`);
  const scriptPath = join(config.repoRoot, ".kilocode/tools/dolt_apply_punch_card_schema.sh");
  if (!existsSync(scriptPath)) {
    throw new Error(`Schema migration script not found: ${scriptPath}`);
  }
  execFileSync("bash", [scriptPath], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      DOLT_PORT: String(config.doltPort),
      DOLT_DATA_DIR: config.doltDataDir,
    },
  });
  log(`${timestamp()} ✅ Punch card schema migration complete.`);
}

/**
 * Ensure daemon node_modules are installed.
 */
export function ensureNodeModules(config: StackConfig, log: Logger): void {
  if (existsSync(join(config.daemonDir, "node_modules"))) return;
  log(`${timestamp()} Installing daemon dependencies...`);
  execFileSync("npm", ["install", "--silent"], {
    cwd: config.daemonDir,
    encoding: "utf8",
    timeout: 120000,
  });
}

/**
 * Ensure Temporal dev server is running.
 * Replaces: nohup temporal server start-dev + poll loop.
 */
export async function ensureTemporalServer(
  config: StackConfig,
  log: Logger,
): Promise<void> {
  const ok = await checkPort(config.kiloHost, config.temporalPort);
  if (ok) {
    log(`${timestamp()} ✅ Temporal server already running on port ${config.temporalPort}.`);
    return;
  }

  log(`${timestamp()} Starting Temporal dev server on port ${config.temporalPort} (UI: ${config.temporalUiPort})...`);

  const temporalCli = findTemporalCli();
  if (!temporalCli) {
    throw new Error(
      "'temporal' CLI not found. Install via: curl -sSf https://temporal.download/cli.sh | sh",
    );
  }

  const child = spawn(
    temporalCli,
    [
      "server", "start-dev",
      "--port", String(config.temporalPort),
      "--ui-port", String(config.temporalUiPort),
      "--db-filename", "/tmp/temporal-dev.db",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  log(`${timestamp()} Temporal server starting (PID ${child.pid ?? "?"})...`);

  // Wait up to 10s for Temporal server
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const listening = await checkPort(config.kiloHost, config.temporalPort);
    if (listening) {
      log(`${timestamp()} ✅ Temporal server started.`);
      return;
    }
  }

  throw new Error(
    "Temporal server failed to start within 10s. Check /tmp/temporal-dev.log",
  );
}

/**
 * Start pm2-managed processes (oc-daemon + temporal-worker).
 * Replaces: pm2 start ecosystem.config.cjs + poll loop.
 */
export async function ensurePm2Ecosystem(
  config: StackConfig,
  log: Logger,
): Promise<void> {
  log(`${timestamp()} Starting pm2-managed processes...`);

  // Set env vars that the ecosystem config reads from process.env
  const savedEnv = {
    KILO_HOST: process.env.KILO_HOST,
    KILO_PORT: process.env.KILO_PORT,
    DOLT_PORT: process.env.DOLT_PORT,
  };
  process.env.KILO_HOST = config.kiloHost;
  process.env.KILO_PORT = String(config.kiloPort);
  process.env.DOLT_PORT = String(config.doltPort);
  try {
    await withPm2Connection(() => pm2Start(config.ecosystemConfig));
  } finally {
    // Restore original env values
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }

  const { ocDaemonOnline, temporalWorkerOnline } = await withPm2Connection(async () => {
    // Wait up to 15s for both to come online using one PM2 connection.
    for (let i = 0; i < 15; i++) {
      const ocdOk = await isAppOnline("oc-daemon");
      const twOk = await isAppOnline("temporal-worker");
      if (ocdOk && twOk) {
        return { ocDaemonOnline: true, temporalWorkerOnline: true };
      }
      await sleep(1000);
    }

    return {
      ocDaemonOnline: await isAppOnline("oc-daemon"),
      temporalWorkerOnline: await isAppOnline("temporal-worker"),
    };
  });

  if (!ocDaemonOnline) {
    throw new Error(`oc-daemon failed to start. Check: ${config.pm2Bin} logs oc-daemon`);
  }
  log(`${timestamp()} ✅ oc-daemon online (pm2, auto-restart enabled).`);

  if (!temporalWorkerOnline) {
    throw new Error(`Temporal worker failed to start. Check: ${config.pm2Bin} logs temporal-worker`);
  }
  log(`${timestamp()} ✅ Temporal worker online (pm2, auto-restart enabled).`);
}

// ── Orchestrators ────────────────────────────────────────────────────────

/**
 * Ensure the full stack is running.
 * This is the main start entry point — mirrors the shell script's do_start().
 */
export async function ensureStack(
  config: StackConfig,
  log: Logger = console.log,
  fetchFn: typeof fetch = fetch,
): Promise<EnsureResult> {
  const errors: string[] = [];

  try {
    // Step 1: Validate/start kilo serve
    await ensureKilo(config, log, fetchFn);
  } catch (e) {
    errors.push((e as Error).message);
    const health = await checkStack(config, fetchFn);
    return { action: "failed", health, message: errors.join("; "), errors };
  }

  try {
    // Step 2: Ensure Dolt server
    await ensureDolt(config, log);
  } catch (e) {
    errors.push((e as Error).message);
    const health = await checkStack(config, fetchFn);
    return { action: "failed", health, message: errors.join("; "), errors };
  }

  try {
    // Step 2.5: Apply punch card schema
    applyPunchCardSchema(config, log);
  } catch (e) {
    errors.push((e as Error).message);
    const health = await checkStack(config, fetchFn);
    return { action: "failed", health, message: errors.join("; "), errors };
  }

  // Step 3: Ensure node_modules
  try {
    ensureNodeModules(config, log);
  } catch (e) {
    errors.push((e as Error).message);
    const health = await checkStack(config, fetchFn);
    return { action: "failed", health, message: errors.join("; "), errors };
  }

  try {
    // Step 4: Ensure Temporal server
    await ensureTemporalServer(config, log);
  } catch (e) {
    errors.push((e as Error).message);
    const health = await checkStack(config, fetchFn);
    return { action: "failed", health, message: errors.join("; "), errors };
  }

  try {
    // Step 5: Start pm2 ecosystem
    await ensurePm2Ecosystem(config, log);
  } catch (e) {
    errors.push((e as Error).message);
    const health = await checkStack(config, fetchFn);
    return { action: "failed", health, message: errors.join("; "), errors };
  }

  // Final health check
  const health = await checkStack(config, fetchFn);

  if (health.ok) {
    log("");
    log("═══════════════════════════════════════════════════");
    log(` FULL STACK READY (${health.healthy}/${health.total} components)`);
    log("═══════════════════════════════════════════════════");
    log(`  kilo serve:     http://${config.kiloHost}:${config.kiloPort}`);
    log(`  Dolt SQL:       127.0.0.1:${config.doltPort}`);
    log(`  oc-daemon:      pm2 (auto-restart, SSE → Dolt)`);
    log(`  Temporal gRPC:  localhost:${config.temporalPort}`);
    log(`  Temporal UI:    http://localhost:${config.temporalUiPort}`);
    log("");
    return {
      action: "all_healthy",
      health,
      message: `Full stack ready (${health.healthy}/${health.total} components)`,
      errors: [],
    };
  }

  return {
    action: "started_missing",
    health,
    message: `Stack partially started (${health.healthy}/${health.total} components)`,
    errors: health.components.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
  };
}

/**
 * Stop managed components.
 * Mirrors the shell script's do_stop().
 *
 * Stops pm2-managed processes and Temporal server.
 * Dolt and kilo serve are left running (may be shared).
 */
export async function stopStack(
  config: StackConfig,
  log: Logger = console.log,
): Promise<void> {
  log(`${timestamp()} Stopping managed components...`);

  // Stop pm2-managed Node.js processes
  try {
    await withPm2Connection(async () => {
      const processes = await pm2List();
      if (processes.length > 0) {
        await pm2Stop("all");
        await pm2Delete("all");
        log(`${timestamp()} pm2 processes stopped (oc-daemon, temporal-worker).`);
      } else {
        log(`${timestamp()} No pm2 processes to stop.`);
      }
    });
  } catch {
    log(`${timestamp()} No pm2 processes to stop.`);
  }

  // Stop Temporal server (native binary, not pm2)
  const temporalOk = await checkPort(config.kiloHost, config.temporalPort);
  if (temporalOk) {
    try {
      execFileSync("pkill", ["-f", "temporal server start-dev"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "ignore"],
      });
      log(`${timestamp()} Temporal server stopped.`);
    } catch {
      log(`${timestamp()} Failed to stop Temporal server.`);
    }
  } else {
    log(`${timestamp()} Temporal server not running.`);
  }

  // Note: Dolt and kilo serve are NOT stopped
  log(`${timestamp()} Done. (Dolt and kilo serve left running — stop manually if needed.)`);
}
