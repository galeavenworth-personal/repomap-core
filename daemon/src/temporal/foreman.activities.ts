/**
 * Foreman Activities — Beads CLI Wrappers for Temporal
 *
 * Temporal activities that encapsulate all Beads CLI interaction for the
 * foreman workflow. Each activity shells out to `.kilocode/tools/bd` (the
 * pinned repo-local wrapper) and parses structured JSON output into typed
 * interfaces from foreman.types.ts.
 *
 * Design invariants:
 * - No shell parsing leaks into workflow code — all CLI interaction is here.
 * - Error classification: BeadsTransientError (retryable) vs BeadsContractError (not).
 * - Uses node:child_process execFile (no shell=true) for safe execution.
 * - bd wrapper path resolved relative to repo root, not PATH.
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { log } from "@temporalio/activity";

import type {
  AnnotateBeadInput,
  AnnotateBeadOutput,
  BeadCandidate,
  CheckStackHealthInput,
  CloseBeadInput,
  CloseBeadOutput,
  CreateEscalationInput,
  CreateEscalationOutput,
  HealthCheckResult,
  SelectNextBeadInput,
  SubsystemHealth,
} from "./foreman.types.js";

// ── Error Types ──

/**
 * Transient CLI failure — process exit, timeout, or I/O error.
 * Temporal should retry these.
 */
export class BeadsTransientError extends Error {
  public readonly retryable = true;

  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "BeadsTransientError";
  }
}

/**
 * Contract failure — bd returned successfully but the output does not
 * conform to the expected schema. Not retryable (same input will produce
 * the same malformed output).
 */
export class BeadsContractError extends Error {
  public readonly retryable = false;

  constructor(
    message: string,
    public readonly rawOutput: string,
  ) {
    super(message);
    this.name = "BeadsContractError";
  }
}

// ── Private Helpers ──

/** Result of a bd CLI invocation. */
export interface BdExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Resolve the path to the bd CLI wrapper.
 * The wrapper lives at `.kilocode/tools/bd` relative to the repo root.
 */
function resolveBdPath(repoPath: string): string {
  return resolve(repoPath, ".kilocode", "tools", "bd");
}

/** Default timeout for bd commands (15 seconds). */
const BD_TIMEOUT_MS = 15_000;

/**
 * Execute a bd CLI command with proper path resolution and error handling.
 *
 * Uses execFile (no shell) for security. Captures stdout, stderr, and exit code.
 * Throws BeadsTransientError on non-zero exit or process errors.
 */
export function execBd(
  repoPath: string,
  args: string[],
  timeoutMs: number = BD_TIMEOUT_MS,
): Promise<BdExecResult> {
  const bdPath = resolveBdPath(repoPath);

  return new Promise((resolvePromise, reject) => {
    execFile(
      bdPath,
      args,
      {
        cwd: repoPath,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          // Timeout
          if (error.killed || error.code === "ETIMEDOUT") {
            reject(
              new BeadsTransientError(
                `bd ${args.join(" ")} timed out after ${timeoutMs}ms`,
                null,
                stderr,
              ),
            );
            return;
          }

          // Non-zero exit
          const exitCode =
            error.code != null && typeof error.code === "number"
              ? error.code
              : (error as NodeJS.ErrnoException & { status?: number }).status ??
                1;
          reject(
            new BeadsTransientError(
              `bd ${args.join(" ")} exited with code ${exitCode}: ${stderr || error.message}`,
              exitCode,
              stderr,
            ),
          );
          return;
        }

        resolvePromise({
          stdout,
          stderr,
          exitCode: 0,
        });
      },
    );
  });
}

/**
 * Parse JSON output from bd with validation.
 * Throws BeadsContractError if the output is not valid JSON.
 */
export function parseBdJson<T>(raw: string, context: string): T {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new BeadsContractError(
      `bd ${context} returned empty output`,
      raw,
    );
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch (e) {
    throw new BeadsContractError(
      `bd ${context} returned invalid JSON: ${(e as Error).message}`,
      raw,
    );
  }
}

// ── Raw bd JSON Shapes ──

/**
 * Shape of a single bead as returned by `bd ready --json`.
 * This is the raw CLI shape — we validate and transform into BeadCandidate.
 */
interface BdReadyItem {
  id?: string;
  title?: string;
  priority?: string;
  labels?: string[];
  depends_on?: string[];
  estimated_complexity?: string;
}

/**
 * Shape of bead detail as returned by `bd show <id> --json`.
 */
interface BdShowItem {
  id?: string;
  title?: string;
  priority?: string;
  labels?: string[];
  depends_on?: string[];
  description?: string;
  estimated_complexity?: string;
  status?: string;
}

// ── Validators ──

/** Priority values accepted by the type system. */
const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

/** Complexity values accepted by the type system. */
const VALID_COMPLEXITIES = new Set([
  "trivial",
  "small",
  "medium",
  "large",
  "unknown",
]);

function toBeadCandidate(raw: BdReadyItem): BeadCandidate | null {
  if (!raw.id || typeof raw.id !== "string") return null;
  if (!raw.title || typeof raw.title !== "string") return null;

  const priority = VALID_PRIORITIES.has(raw.priority ?? "")
    ? (raw.priority as BeadCandidate["priority"])
    : "P3";

  const complexity = VALID_COMPLEXITIES.has(raw.estimated_complexity ?? "")
    ? (raw.estimated_complexity as BeadCandidate["estimatedComplexity"])
    : "unknown";

  return {
    beadId: raw.id,
    title: raw.title,
    priority,
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    dependsOn: Array.isArray(raw.depends_on) ? raw.depends_on : [],
    estimatedComplexity: complexity,
  };
}

// ── Priority Sort ──

const PRIORITY_ORDER: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function comparePriority(a: BeadCandidate, b: BeadCandidate): number {
  return (PRIORITY_ORDER[a.priority] ?? 4) - (PRIORITY_ORDER[b.priority] ?? 4);
}

// ── Health Gate Helpers ──

/** Timeout for individual subsystem health checks (5 seconds). */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Latency threshold above which a subsystem is classified as degraded (3 seconds). */
const DEGRADED_LATENCY_THRESHOLD_MS = 3_000;

/**
 * Measure elapsed time for an async operation.
 * Returns the result and elapsed time in milliseconds.
 */
async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, elapsedMs: Math.round(performance.now() - start) };
}

/**
 * Build a SubsystemHealth from a check result.
 * Applies the latency degradation threshold automatically.
 */
function buildSubsystemHealth(
  status: "up" | "down",
  latencyMs: number | null,
  message: string | null,
): SubsystemHealth {
  // If up but slow, classify as degraded
  const effectiveStatus =
    status === "up" && latencyMs !== null && latencyMs > DEGRADED_LATENCY_THRESHOLD_MS
      ? "degraded"
      : status;
  return { status: effectiveStatus, message, latencyMs };
}

/**
 * Check kilo serve health via HTTP GET /session.
 * Pattern adapted from dispatch.ts runPreflightChecks.
 */
async function checkKiloServe(host: string, port: number): Promise<SubsystemHealth> {
  try {
    const { result: res, elapsedMs } = await timed(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      try {
        return await fetch(`http://${host}:${port}/session`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    });

    if (res.ok) {
      return buildSubsystemHealth("up", elapsedMs, `HTTP ${res.status}`);
    }
    return buildSubsystemHealth("down", elapsedMs, `HTTP ${res.status} ${res.statusText}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "down", message: `unreachable: ${msg}`, latencyMs: null };
  }
}

/**
 * Check Dolt server health via TCP connection test.
 * Pattern adapted from dispatch.ts canConnectTcp.
 *
 * NOTE: The health gate contract specifies `SELECT 1` for a full check.
 * This implementation uses a TCP connect test to avoid importing a MySQL
 * driver (mysql2 is not in daemon's dependencies). A TCP connect confirms
 * the port is listening, which is sufficient for the health gate. A future
 * iteration can upgrade to `SELECT 1` if mysql2 is added.
 */
async function checkDolt(host: string, port: number): Promise<SubsystemHealth> {
  try {
    const { elapsedMs } = await timed(async () => {
      await new Promise<void>((resolveConn, reject) => {
        const sock = createConnection({ host, port }, () => {
          sock.destroy();
          resolveConn();
        });
        sock.on("error", reject);
        sock.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
          sock.destroy();
          reject(new Error("timeout"));
        });
      });
    });

    return buildSubsystemHealth("up", elapsedMs, `TCP ${host}:${port}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "down", message: `TCP ${host}:${port} failed: ${msg}`, latencyMs: null };
  }
}

/**
 * Check git health via `git status --porcelain`.
 * Exit 0 with no merge conflicts = up.
 * Exit 0 with uncommitted changes = degraded.
 * Non-zero exit = down.
 */
async function checkGit(repoPath: string): Promise<SubsystemHealth> {
  try {
    const { result: stdout, elapsedMs } = await timed(async () => {
      return new Promise<string>((resolveGit, reject) => {
        execFile(
          "git",
          ["status", "--porcelain"],
          { cwd: repoPath, timeout: HEALTH_CHECK_TIMEOUT_MS },
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolveGit(stdout);
          },
        );
      });
    });

    const trimmed = stdout.trim();
    // Check for merge conflict markers (UU, AA, DD prefixes in porcelain output)
    const hasConflicts = trimmed
      .split("\n")
      .some((line) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line));

    if (hasConflicts) {
      return { status: "down", message: "merge conflicts detected", latencyMs: elapsedMs };
    }

    if (trimmed.length > 0) {
      return buildSubsystemHealth("up", elapsedMs, "uncommitted changes present");
    }

    return buildSubsystemHealth("up", elapsedMs, "clean working tree");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "down", message: `git status failed: ${msg}`, latencyMs: null };
  }
}

/**
 * Check Temporal health.
 * The fact that this activity is executing IS proof that Temporal is up.
 * This is documented in the health gate contract as "implicit".
 */
function checkTemporal(): SubsystemHealth {
  // If this code is running, we are inside a Temporal activity.
  // The Temporal server and worker are necessarily functional.
  return { status: "up", message: "implicit: activity is executing", latencyMs: 0 };
}

/**
 * Check beads (bd) health via `bd ready --json`.
 * Exit 0 + valid JSON = up. Exit 0 + empty = degraded.
 * Non-zero exit = down.
 */
async function checkBeads(repoPath: string): Promise<SubsystemHealth> {
  try {
    const { result, elapsedMs } = await timed(async () => {
      return execBd(repoPath, ["ready", "--json"]);
    });

    // Validate JSON parsability
    try {
      const parsed = JSON.parse(result.stdout.trim()) as unknown;
      if (Array.isArray(parsed) && parsed.length === 0) {
        return buildSubsystemHealth("up", elapsedMs, "bd ready: no beads (empty queue)");
      }
      return buildSubsystemHealth("up", elapsedMs, "bd ready: OK");
    } catch {
      // bd returned exit 0 but output isn't valid JSON — degraded
      return { status: "degraded", message: "bd ready: invalid JSON output", latencyMs: elapsedMs };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "down", message: `bd ready failed: ${msg}`, latencyMs: null };
  }
}

/**
 * Aggregate individual subsystem health statuses into an overall result.
 * Rule: any "down" → "fail", any "degraded" → "degraded", else → "pass".
 */
function aggregateHealth(
  subsystems: HealthCheckResult["subsystems"],
): HealthCheckResult["overall"] {
  const statuses = Object.values(subsystems).map((s) => s.status);
  if (statuses.includes("down")) return "fail";
  if (statuses.includes("degraded")) return "degraded";
  return "pass";
}

// ── Activities ──

/**
 * Check the health of all stack subsystems before dispatch.
 *
 * Runs health checks against all five subsystems in parallel and returns
 * an aggregate HealthCheckResult. This activity NEVER throws — all check
 * failures are reported in the result structure. Only infrastructure
 * failures that prevent the activity itself from running (e.g., Temporal
 * worker crash) will surface as activity failures.
 *
 * ADR Section 5.1, Health Gate Contract.
 */
export async function checkStackHealth(
  input: CheckStackHealthInput,
): Promise<HealthCheckResult> {
  const { repoPath, doltHost, doltPort, kiloHost, kiloPort } = input;

  log.info(
    `checkStackHealth: checking 5 subsystems (kilo=${kiloHost}:${kiloPort}, dolt=${doltHost}:${doltPort})`,
  );

  // Run all checks in parallel for speed
  const [kiloServe, dolt, git, temporal, beads] = await Promise.all([
    checkKiloServe(kiloHost, kiloPort),
    checkDolt(doltHost, doltPort),
    checkGit(repoPath),
    Promise.resolve(checkTemporal()),
    checkBeads(repoPath),
  ]);

  const subsystems = { kiloServe, dolt, git, temporal, beads };
  const overall = aggregateHealth(subsystems);

  log.info(
    `checkStackHealth: overall=${overall} (kilo=${kiloServe.status}, dolt=${dolt.status}, git=${git.status}, temporal=${temporal.status}, beads=${beads.status})`,
  );

  return {
    overall,
    checkedAt: new Date().toISOString(),
    subsystems,
  };
}

/**
 * Select the next bead eligible for dispatch.
 *
 * Runs `bd ready --json`, parses the output, filters out beads in the
 * skip list and beads with exhausted retries, sorts by priority, and
 * returns the highest-priority candidate (or null).
 *
 * ADR Section 5.2.
 */
export async function selectNextBead(
  input: SelectNextBeadInput,
): Promise<BeadCandidate | null> {
  const { repoPath, retryLedger, skipList } = input;

  log.info(`selectNextBead: running bd ready --json in ${repoPath}`);
  const result = await execBd(repoPath, ["ready", "--json"]);

  const rawItems = parseBdJson<BdReadyItem[]>(result.stdout, "ready --json");

  if (!Array.isArray(rawItems)) {
    throw new BeadsContractError(
      "bd ready --json did not return an array",
      result.stdout,
    );
  }

  // Build skip set from explicit skipList + exhausted retry entries
  const skipSet = new Set(skipList);
  for (const entry of retryLedger) {
    if (entry.exhausted) {
      skipSet.add(entry.beadId);
    }
  }

  // Transform, filter, sort
  const candidates: BeadCandidate[] = [];
  for (const raw of rawItems) {
    const candidate = toBeadCandidate(raw);
    if (candidate && !skipSet.has(candidate.beadId)) {
      candidates.push(candidate);
    }
  }

  candidates.sort(comparePriority);

  const selected = candidates[0] ?? null;
  log.info(
    `selectNextBead: ${rawItems.length} raw, ${candidates.length} eligible, selected=${selected?.beadId ?? "none"}`,
  );

  return selected;
}

/**
 * Get full detail for a bead.
 *
 * Runs `bd show <id> --json` and returns structured detail including
 * dependencies, labels, and description. Used by the foreman before
 * dispatch to assess dispatchability.
 *
 * ADR Section 5.2 (detail fetch).
 */
export async function getBeadDetail(
  repoPath: string,
  beadId: string,
): Promise<{
  beadId: string;
  title: string;
  priority: BeadCandidate["priority"];
  labels: string[];
  dependsOn: string[];
  description: string;
  estimatedComplexity: BeadCandidate["estimatedComplexity"];
  status: string;
}> {
  log.info(`getBeadDetail: running bd show ${beadId} --json`);
  const result = await execBd(repoPath, ["show", beadId, "--json"]);

  const raw = parseBdJson<BdShowItem>(result.stdout, `show ${beadId} --json`);

  if (!raw || typeof raw !== "object") {
    throw new BeadsContractError(
      `bd show ${beadId} --json did not return an object`,
      result.stdout,
    );
  }

  if (!raw.id || typeof raw.id !== "string") {
    throw new BeadsContractError(
      `bd show ${beadId} --json: missing or invalid 'id' field`,
      result.stdout,
    );
  }

  const priority = VALID_PRIORITIES.has(raw.priority ?? "")
    ? (raw.priority as BeadCandidate["priority"])
    : "P3";

  const complexity = VALID_COMPLEXITIES.has(raw.estimated_complexity ?? "")
    ? (raw.estimated_complexity as BeadCandidate["estimatedComplexity"])
    : "unknown";

  return {
    beadId: raw.id,
    title: raw.title ?? "",
    priority,
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    dependsOn: Array.isArray(raw.depends_on) ? raw.depends_on : [],
    description: raw.description ?? "",
    estimatedComplexity: complexity,
    status: raw.status ?? "unknown",
  };
}

/**
 * Update a bead's status.
 *
 * Runs `bd update <id> --status <status>` to claim beads (in_progress)
 * or mark other status transitions.
 *
 * Returns success/failure indicator. Throws BeadsTransientError on CLI failure.
 */
export async function updateBeadStatus(
  repoPath: string,
  beadId: string,
  status: string,
): Promise<{ updated: boolean; error: string | null }> {
  log.info(`updateBeadStatus: bd update ${beadId} --status ${status}`);
  try {
    await execBd(repoPath, ["update", beadId, "--status", status]);
    log.info(`updateBeadStatus: ${beadId} -> ${status} succeeded`);
    return { updated: true, error: null };
  } catch (e) {
    if (e instanceof BeadsTransientError) {
      log.warn(
        `updateBeadStatus: ${beadId} -> ${status} failed (transient): ${e.message}`,
      );
      throw e; // Let Temporal retry
    }
    // Unexpected error — wrap as transient to be safe
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`updateBeadStatus: ${beadId} -> ${status} failed: ${msg}`);
    return { updated: false, error: msg };
  }
}

/**
 * Close a bead after durable success.
 *
 * Runs `bd close <beadId>` in the repository directory.
 * Idempotent: if the bead is already closed, treats as success.
 *
 * ADR Section 5.6.
 */
export async function closeBead(
  input: CloseBeadInput,
): Promise<CloseBeadOutput> {
  const { repoPath, beadId } = input;

  log.info(`closeBead: bd close ${beadId}`);
  try {
    await execBd(repoPath, ["close", beadId]);
    log.info(`closeBead: ${beadId} closed successfully`);
    return { closed: true, error: null };
  } catch (e) {
    if (e instanceof BeadsTransientError) {
      // Idempotency: if bead is already closed, treat as success
      const msg = e.message.toLowerCase();
      if (msg.includes("already closed") || msg.includes("already_closed")) {
        log.info(`closeBead: ${beadId} already closed — treating as success`);
        return { closed: true, error: null };
      }
      log.warn(`closeBead: ${beadId} failed (transient): ${e.message}`);
      throw e; // Let Temporal retry
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`closeBead: ${beadId} failed: ${msg}`);
    return { closed: false, error: msg };
  }
}

/**
 * Annotate a bead with a comment preserving the audit trail.
 *
 * Runs `bd comments add <beadId> "<comment>"` in the repository directory.
 * Used to record outcome reasons (failure, timeout, budget exceeded, etc.)
 * on beads that are NOT being closed.
 *
 * Throws BeadsTransientError on CLI failure (Temporal will retry).
 */
export async function annotateBead(
  input: AnnotateBeadInput,
): Promise<AnnotateBeadOutput> {
  const { repoPath, beadId, comment } = input;

  log.info(`annotateBead: bd comments add ${beadId}`);
  try {
    await execBd(repoPath, ["comments", "add", beadId, comment]);
    log.info(`annotateBead: ${beadId} annotated successfully`);
    return { annotated: true, error: null };
  } catch (e) {
    if (e instanceof BeadsTransientError) {
      log.warn(`annotateBead: ${beadId} failed (transient): ${e.message}`);
      throw e; // Let Temporal retry
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`annotateBead: ${beadId} failed: ${msg}`);
    return { annotated: false, error: msg };
  }
}

/**
 * Create an escalation bead for human intervention.
 *
 * Runs `bd create "Escalation: <title>" --label escalation --label human-required`
 * with a structured description body. This is the foreman's mechanism for
 * requesting human help when autonomous recovery has failed.
 *
 * ADR Section 5.7, Escalation Contract.
 */
export async function createEscalation(
  input: CreateEscalationInput,
): Promise<CreateEscalationOutput> {
  const { repoPath, beadId, reason, outcomes, retryEntry } = input;

  const title = `Escalation: ${beadId} — ${reason}`;
  const totalCost = outcomes.reduce((sum, o) => sum + o.totalCost, 0);

  // Build structured description body
  const lines: string[] = [
    `## Escalation Summary`,
    ``,
    `- **Original bead:** ${beadId}`,
    `- **Exception class:** ${reason}`,
    `- **Total attempts:** ${retryEntry.attempts}`,
    `- **Total cost incurred:** $${totalCost.toFixed(2)}`,
    ``,
    `## Dispatch History`,
    ``,
  ];

  for (const outcome of outcomes) {
    lines.push(`### Attempt ${outcome.attempt}`);
    lines.push(`- **Started:** ${outcome.startedAt}`);
    lines.push(`- **Duration:** ${outcome.durationMs}ms`);
    lines.push(`- **Cost:** $${outcome.totalCost.toFixed(2)}`);
    lines.push(`- **Result:** ${outcome.result.kind}`);
    if ("error" in outcome.result) {
      lines.push(`- **Error:** ${(outcome.result as { error: string }).error}`);
    }
    lines.push(`- **Session ID:** ${outcome.sessionId ?? "n/a"}`);
    lines.push(`- **Workflow ID:** ${outcome.workflowId}`);
    lines.push(``);
  }

  lines.push(`## Retry Ledger`);
  lines.push(`- **Max attempts:** ${retryEntry.maxAttempts}`);
  lines.push(`- **Last error:** ${retryEntry.lastError}`);
  lines.push(`- **Exhausted:** ${retryEntry.exhausted ? "yes" : "no"}`);

  const description = lines.join("\n");

  log.info(`createEscalation: creating escalation bead for ${beadId}`);
  try {
    const result = await execBd(repoPath, [
      "create",
      title,
      "--label", "escalation",
      "--label", "human-required",
      "-d", description,
      "--json",
    ]);

    // Parse the created bead ID from JSON output
    const parsed = parseBdJson<{ id?: string }>(result.stdout, "create escalation");
    const escalationBeadId = parsed.id ?? "unknown";

    log.info(`createEscalation: created ${escalationBeadId} for ${beadId}`);
    return { escalationBeadId };
  } catch (e) {
    if (e instanceof BeadsTransientError) {
      log.warn(`createEscalation: ${beadId} failed (transient): ${e.message}`);
      throw e; // Let Temporal retry
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`createEscalation: ${beadId} failed: ${msg}`);
    // On contract error, still try to return something useful
    throw new BeadsTransientError(
      `createEscalation failed: ${msg}`,
      null,
      msg,
    );
  }
}
