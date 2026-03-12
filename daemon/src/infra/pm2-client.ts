/**
 * PM2 Programmatic API Client — promisified wrappers.
 *
 * Replaces CLI shell-outs (execFileSync → pm2 start/jlist/stop/delete)
 * with the pm2 programmatic API (callback-based → Promise-based).
 *
 * See: repomap-core-ovm.4
 */

import pm2 from "pm2";
import type { ProcessDescription, Proc, StartOptions } from "pm2";

// ── Promisified Wrappers ─────────────────────────────────────────────────

/**
 * Connect to the PM2 daemon (or launch one).
 * Must be called before any other pm2 operation.
 */
export function pm2Connect(noDaemonMode = false): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.connect(noDaemonMode, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Disconnect from the PM2 daemon.
 * Call this when done with PM2 operations.
 */
export function pm2Disconnect(): void {
  pm2.disconnect();
}

/**
 * Start a process via PM2 programmatic API.
 *
 * Accepts either a config file path (ecosystem.config.cjs)
 * or a StartOptions object.
 */
export function pm2Start(configOrOptions: string | StartOptions): Promise<Proc> {
  return new Promise((resolve, reject) => {
    if (typeof configOrOptions === "string") {
      pm2.start(configOrOptions, (err, proc) => {
        if (err) reject(err);
        else resolve(proc);
      });
    } else {
      pm2.start(configOrOptions, (err, proc) => {
        if (err) reject(err);
        else resolve(proc);
      });
    }
  });
}

/**
 * Get the list of running processes managed by PM2.
 */
export function pm2List(): Promise<ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });
}

/**
 * Stop a PM2-managed process (leaves it in PM2's list).
 * @param target Process name, id, or "all"
 */
export function pm2Stop(target: string | number): Promise<Proc> {
  return new Promise((resolve, reject) => {
    pm2.stop(target, (err, proc) => {
      if (err) reject(err);
      else resolve(proc);
    });
  });
}

/**
 * Stop and remove a PM2-managed process from PM2's list.
 * @param target Process name, id, or "all"
 */
export function pm2Delete(target: string | number): Promise<Proc> {
  return new Promise((resolve, reject) => {
    pm2.delete(target, (err, proc) => {
      if (err) reject(err);
      else resolve(proc);
    });
  });
}

// ── Lifecycle Convenience ────────────────────────────────────────────────

/**
 * Execute a callback within a PM2 connection lifecycle.
 * Connects, runs the callback, then always disconnects.
 */
export async function withPm2<T>(fn: () => Promise<T>): Promise<T> {
  await pm2Connect();
  try {
    return await fn();
  } finally {
    pm2Disconnect();
  }
}

/**
 * Check if a named PM2 app is currently online.
 * Manages its own connect/disconnect lifecycle.
 */
export async function pm2IsAppOnline(appName: string): Promise<boolean> {
  try {
    return await withPm2(async () => {
      const procs = await pm2List();
      return procs.some(
        (p) => p.name === appName && p.pm2_env?.status === "online",
      );
    });
  } catch {
    return false;
  }
}
