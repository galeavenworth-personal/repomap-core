/**
 * Bead Operations — Canonical Beads CLI primitives
 *
 * Single source of truth for bead lifecycle operations (close, etc.).
 * All call sites delegate to these functions or use thin wrappers
 * that adapt to their execution model (sync/async, DI, Temporal).
 *
 * Design:
 * - Sync by default (spawnSync) — covers land-plane and ad-hoc callers.
 * - Async callers (e.g., Temporal activities) use thin wrappers that
 *   delegate to their own async exec helpers while acknowledging this
 *   module as the canonical logic definition.
 * - No imports from other daemon modules (pure utility leaf).
 *
 * See: repomap-core-ovm.2 (PP-4 consolidation)
 */

import { spawnSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────────

export interface CloseBeadOptions {
  /** Working directory for the bd process. Defaults to process.cwd(). */
  cwd?: string;
  /** Timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
  /**
   * When true, non-zero exit codes are logged but do not cause a false
   * return — mirrors the `|| true` semantics in the original shell scripts.
   * Defaults to true.
   */
  idempotent?: boolean;
  /** Logger function. Defaults to console.log. */
  log?: (msg: string) => void;
}

// ── Canonical closeBead ──────────────────────────────────────────────────

/**
 * Close a bead via `bd close <beadId>`.
 *
 * This is the **canonical** implementation. All sync call sites in the
 * daemon should delegate here. Async call sites (Temporal activities)
 * mirror the same logic through their async exec helpers.
 *
 * @returns true if the close succeeded (or was idempotent), false on
 *          non-idempotent failure.
 */
export function closeBead(
  beadId: string,
  bdBin: string,
  opts: CloseBeadOptions = {},
): boolean {
  const {
    cwd = process.cwd(),
    timeoutMs = 30_000,
    idempotent = true,
    log = console.log,
  } = opts;

  log(`Closing bead: ${beadId}`);

  const result = spawnSync(bdBin, ["close", beadId], {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: timeoutMs,
  });

  if (result.status !== 0) {
    log(`bd close exited with ${result.status ?? "signal"} (${idempotent ? "ignored, idempotent" : "FAILED"})`);
    return idempotent;
  }

  return true;
}
