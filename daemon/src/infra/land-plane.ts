/**
 * Land Plane — Beads issue completion orchestrator
 *
 * Replaces the shell-based beads_land_plane.sh with proper TypeScript
 * implementation using native JSONL parsing and subprocess management.
 *
 * Responsibilities:
 *   - Run canonical quality gates with bounded budgets (via bounded_gate.py)
 *   - Verify audit proof exists for all gates in .kilocode/gate_runs.jsonl
 *   - Close the bead (idempotent)
 *   - Sync Beads state (unless disabled)
 *
 * Exit codes:
 *   0  Success
 *   1  Gate failure
 *   2  Gate fault or argument error
 *   3  Audit proof missing
 *   4  bd close/sync failure
 *
 * See: repomap-core-76q.5
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Configuration ────────────────────────────────────────────────────────

export interface GateDefinition {
  gateId: string;
  timeoutSeconds: number;
  stallSeconds: number;
  command: string;
}

export interface LandPlaneConfig {
  /** Repository root directory */
  rootDir: string;
  /** Path to the bd binary */
  bdBin: string;
  /** Path to bounded_gate.py */
  boundedGatePy: string;
  /** Path to the Python interpreter in the venv */
  pythonBin: string;
  /** Path to the gate_runs.jsonl audit log */
  auditLogPath: string;
  /** Canonical quality gates to run */
  gates: GateDefinition[];
  /** Required gate IDs that must have PASS records in audit proof */
  requiredGateIds: string[];
}

export function defaultConfig(rootDir?: string): LandPlaneConfig {
  const root = rootDir ?? findRootDir();

  return {
    rootDir: root,
    bdBin: join(root, ".kilocode/tools/bd"),
    boundedGatePy: join(root, ".kilocode/tools/bounded_gate.py"),
    pythonBin: join(root, ".venv/bin/python"),
    auditLogPath: join(root, ".kilocode/gate_runs.jsonl"),
    gates: [
      {
        gateId: "ruff-format",
        timeoutSeconds: 60,
        stallSeconds: 30,
        command: `${join(root, ".venv/bin/python")} -m ruff format --check .`,
      },
      {
        gateId: "ruff-check",
        timeoutSeconds: 60,
        stallSeconds: 30,
        command: `${join(root, ".venv/bin/python")} -m ruff check .`,
      },
      {
        gateId: "mypy-src",
        timeoutSeconds: 120,
        stallSeconds: 60,
        command: `${join(root, ".venv/bin/python")} -m mypy src`,
      },
      {
        gateId: "pytest",
        timeoutSeconds: 180,
        stallSeconds: 60,
        command: `${join(root, ".venv/bin/python")} -m pytest -q`,
      },
    ],
    requiredGateIds: ["ruff-format", "ruff-check", "mypy-src", "pytest"],
  };
}

function findRootDir(): string {
  // Walk up from this file's location to find the repo root
  // In production: daemon/src/infra/land-plane.ts -> ../../.. = repo root
  // But __dirname may not be available in ESM, so use process.cwd() as fallback
  const cwd = process.cwd();
  // If we're in daemon/, go up one level
  if (cwd.endsWith("/daemon")) {
    return join(cwd, "..");
  }
  return cwd;
}

// ── Types ────────────────────────────────────────────────────────────────

export interface GateRunRecord {
  schema_version?: string;
  bead_id: string;
  run_timestamp: string;
  gate_id: string;
  status: string;
  exit_code: number;
  elapsed_seconds: number;
  invocation: string;
  stop_reason: string | null;
}

export interface GateResult {
  gateId: string;
  exitCode: number;
  /** "pass" | "fail" | "fault" */
  status: "pass" | "fail" | "fault";
}

export interface AuditProofResult {
  ok: boolean;
  missingGates: string[];
}

export interface LandPlaneOptions {
  beadId: string;
  skipGates: boolean;
  runTimestamp: string;
  noSync: boolean;
}

export interface LandPlaneResult {
  exitCode: number;
  summary: string;
}

// ── Gate execution ───────────────────────────────────────────────────────

/**
 * Run a single quality gate via bounded_gate.py subprocess.
 *
 * Returns the gate result with exit code and status classification.
 * Exit code 0 = pass, exit code 2 = fault (timeout/stall/env), other = fail.
 */
export function runGate(
  gate: GateDefinition,
  beadId: string,
  runTimestamp: string,
  config: LandPlaneConfig,
  log: (msg: string) => void = console.log,
): GateResult {
  const cmdParts = gate.command.split(/\s+/);

  const args = [
    config.boundedGatePy,
    "--gate-id", gate.gateId,
    "--bead-id", beadId,
    "--run-timestamp", runTimestamp,
    "--timeout-seconds", String(gate.timeoutSeconds),
    "--stall-seconds", String(gate.stallSeconds),
    "--pass-through",
    "--cwd", config.rootDir,
    "--",
    ...cmdParts,
  ];

  log(`Running gate: ${gate.gateId}`);

  const result = spawnSync(config.pythonBin, args, {
    cwd: config.rootDir,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: (gate.timeoutSeconds + 30) * 1000, // Extra margin beyond bounded_gate's own timeout
  });

  const exitCode = result.status ?? 1;
  let status: "pass" | "fail" | "fault";
  if (exitCode === 0) {
    status = "pass";
  } else if (exitCode === 2) {
    status = "fault";
  } else {
    status = "fail";
  }

  return { gateId: gate.gateId, exitCode, status };
}

/**
 * Run all canonical quality gates sequentially.
 * Returns on first failure/fault.
 */
export function runGates(
  beadId: string,
  runTimestamp: string,
  config: LandPlaneConfig,
  log: (msg: string) => void = console.log,
): GateResult[] {
  const results: GateResult[] = [];

  for (const gate of config.gates) {
    const result = runGate(gate, beadId, runTimestamp, config, log);
    results.push(result);

    if (result.status !== "pass") {
      return results;
    }
  }

  return results;
}

// ── Audit proof verification ─────────────────────────────────────────────

/**
 * Parse gate_runs.jsonl and verify that PASS records exist for all required
 * gates matching the given bead_id and run_timestamp.
 *
 * This replaces the inline Python audit proof check from the original shell
 * script with native Node.js JSONL parsing.
 */
export function verifyAuditProof(
  beadId: string,
  runTimestamp: string,
  config: LandPlaneConfig,
  log: (msg: string) => void = console.log,
): AuditProofResult {
  if (!existsSync(config.auditLogPath)) {
    log(`audit_proof=MISSING reason=missing_gate_runs_jsonl`);
    return { ok: false, missingGates: [...config.requiredGateIds] };
  }

  const content = readFileSync(config.auditLogPath, "utf8");
  const lines = content.split("\n");
  const found = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec: GateRunRecord;
    try {
      rec = JSON.parse(trimmed) as GateRunRecord;
    } catch {
      // Skip malformed lines
      continue;
    }

    if (
      rec.bead_id === beadId &&
      rec.run_timestamp === runTimestamp &&
      rec.status === "pass"
    ) {
      found.add(rec.gate_id);
    }
  }

  const missingGates = config.requiredGateIds.filter((id) => !found.has(id));

  if (missingGates.length > 0) {
    log(`audit_proof=MISSING gates=[${missingGates.sort().join(", ")}]`);
    return { ok: false, missingGates };
  }

  log(`audit_proof=OK gate_run_signature=bead_id=${beadId} run_timestamp=${runTimestamp}`);
  return { ok: true, missingGates: [] };
}

// ── Bead management ──────────────────────────────────────────────────────

/**
 * Close a bead via `bd close`. Idempotent — does not fail if already closed.
 */
export function closeBead(
  beadId: string,
  config: LandPlaneConfig,
  log: (msg: string) => void = console.log,
): boolean {
  log(`Closing bead: ${beadId}`);

  const result = spawnSync(config.bdBin, ["close", beadId], {
    cwd: config.rootDir,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 30_000,
  });

  // Idempotent: always return true (matches `|| true` in shell)
  if (result.status !== 0) {
    log(`bd close exited with ${result.status ?? "signal"} (ignored, idempotent)`);
  }

  return true;
}

/**
 * Sync Beads state via `bd sync`.
 */
export function syncBeads(
  config: LandPlaneConfig,
  log: (msg: string) => void = console.log,
): boolean {
  log("Syncing Beads state...");

  const result = spawnSync(config.bdBin, ["sync"], {
    cwd: config.rootDir,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 60_000,
  });

  if (result.status !== 0) {
    log("ERROR: bd sync failed");
    return false;
  }

  return true;
}

// ── Preflight ────────────────────────────────────────────────────────────

/**
 * Run the Beads preflight check (bd binary + .beads/ existence).
 */
export function runPreflight(
  config: LandPlaneConfig,
  log: (msg: string) => void = console.log,
): boolean {
  const preflightScript = join(config.rootDir, ".kilocode/tools/beads_preflight.sh");

  if (!existsSync(preflightScript)) {
    log(`ERROR: missing ${preflightScript}`);
    return false;
  }

  const result = spawnSync("bash", [preflightScript], {
    cwd: config.rootDir,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 10_000,
  });

  return result.status === 0;
}

// ── Main orchestrator ────────────────────────────────────────────────────

/**
 * Orchestrate the full "land plane" sequence:
 *   1. Preflight check
 *   2. Run quality gates (unless --skip-gates)
 *   3. Verify audit proof
 *   4. Close bead
 *   5. Sync (unless --no-sync)
 *
 * Exit codes match the original shell script:
 *   0  Success
 *   1  Gate failure
 *   2  Gate fault or argument error
 *   3  Audit proof missing
 *   4  bd sync failure
 */
export function landPlane(
  options: LandPlaneOptions,
  config: LandPlaneConfig,
  log: (msg: string) => void = console.log,
): LandPlaneResult {
  // 1. Preflight
  if (!runPreflight(config, log)) {
    return { exitCode: 2, summary: "Preflight check failed" };
  }

  // 2. Run gates (unless skipped)
  if (!options.skipGates) {
    const results = runGates(options.beadId, options.runTimestamp, config, log);
    const lastResult = results[results.length - 1];

    if (lastResult && lastResult.status === "fault") {
      log(`ERROR: gate_faulted gate_id=${lastResult.gateId} rc=${lastResult.exitCode}`);
      return { exitCode: 2, summary: `Gate faulted: ${lastResult.gateId}` };
    }

    if (lastResult && lastResult.status === "fail") {
      log(`ERROR: gate_failed gate_id=${lastResult.gateId} rc=${lastResult.exitCode}`);
      return { exitCode: 1, summary: `Gate failed: ${lastResult.gateId}` };
    }
  }

  // 3. Verify audit proof
  const auditResult = verifyAuditProof(options.beadId, options.runTimestamp, config, log);
  if (!auditResult.ok) {
    return { exitCode: 3, summary: `Audit proof missing: ${auditResult.missingGates.join(", ")}` };
  }

  // 4. Close bead (idempotent)
  closeBead(options.beadId, config, log);

  // 5. Sync (unless disabled)
  let syncStatus = "YES";
  if (!options.noSync) {
    if (!syncBeads(config, log)) {
      return { exitCode: 4, summary: "bd sync failed" };
    }
  } else {
    syncStatus = "SKIPPED";
  }

  // Success summary
  const summary = [
    "=== LAND PLANE SUMMARY ===",
    `bead_id: ${options.beadId}`,
    `run_timestamp: ${options.runTimestamp}`,
    `gate_run_signature=bead_id=${options.beadId} run_timestamp=${options.runTimestamp}`,
    "gates: ALL PASS",
    "audit_proof: OK",
    "bead_closed: YES",
    `sync: ${syncStatus}`,
    "===========================",
  ].join("\n");

  log(summary);

  return { exitCode: 0, summary };
}
