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
import { existsSync } from "node:fs";
import { createConnection } from "mysql2/promise";
import { log } from "@temporalio/activity";
import {
  BeadsTransientError,
  closeBeadCore,
  execBd,
} from "../infra/bead-ops.js";
import {
  buildSubsystemHealth,
} from "./health-utils.js";
import { timed } from "../infra/utils.js";

import type {
  BeadCandidate,
  CheckStackHealthInput,
  CloseBeadInput,
  CloseBeadOutput,
  HealthCheckResult,
  SelectNextBeadInput,
  SubsystemHealth,
} from "./foreman.types.js";

// ── Error Types ──

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

/**
 * Resolve the absolute path to the git binary.
 * Checks well-known fixed paths to avoid insecure PATH resolution (SonarQube S4036).
 */
function resolveGitBin(): string {
  for (const p of ["/usr/bin/git", "/usr/local/bin/git"]) {
    if (existsSync(p)) return p;
  }
  return "git"; // fallback — will use PATH if no fixed path found
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

interface RetrySelectionSets {
  skipSet: Set<string>;
  backoffPendingSet: Set<string>;
  retryByBeadId: Map<string, SelectNextBeadInput["retryLedger"][number]>;
}

function buildRetrySelectionSets(
  retryLedger: SelectNextBeadInput["retryLedger"],
  skipList: string[],
  nowMs: number,
): RetrySelectionSets {
  const skipSet = new Set(skipList);
  const retryByBeadId = new Map(retryLedger.map((entry) => [entry.beadId, entry] as const));
  const backoffPendingSet = new Set<string>();

  for (const entry of retryLedger) {
    if (entry.exhausted) {
      skipSet.add(entry.beadId);
      continue;
    }
    if (entry.nextRetryAfter && Date.parse(entry.nextRetryAfter) > nowMs) {
      backoffPendingSet.add(entry.beadId);
    }
  }

  return { skipSet, backoffPendingSet, retryByBeadId };
}

function classifyEligibleCandidates(
  rawItems: BdReadyItem[],
  skipSet: Set<string>,
  backoffPendingSet: Set<string>,
  retryByBeadId: Map<string, SelectNextBeadInput["retryLedger"][number]>,
): { retryEligible: BeadCandidate[]; freshCandidates: BeadCandidate[] } {
  const retryEligible: BeadCandidate[] = [];
  const freshCandidates: BeadCandidate[] = [];

  for (const raw of rawItems) {
    const candidate = toBeadCandidate(raw);
    if (!candidate) continue;
    if (skipSet.has(candidate.beadId)) continue;
    if (backoffPendingSet.has(candidate.beadId)) continue;

    if (retryByBeadId.has(candidate.beadId)) {
      retryEligible.push(candidate);
      continue;
    }
    freshCandidates.push(candidate);
  }

  return { retryEligible, freshCandidates };
}

// ── Health Gate Helpers ──

/** Timeout for individual subsystem health checks (5 seconds). */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

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
 * Check Dolt server health via `SELECT 1` query.
 * Uses mysql2/promise to verify the Dolt SQL server is responding to queries,
 * per the health gate contract.
 */
async function checkDolt(host: string, port: number, database: string): Promise<SubsystemHealth> {
  try {
    const { elapsedMs } = await timed(async () => {
      const conn = await createConnection({
        host,
        port,
        database,
        connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
      });
      try {
        await conn.query("SELECT 1");
      } finally {
        await conn.end();
      }
    });

    return buildSubsystemHealth("up", elapsedMs, `SELECT 1 OK (${host}:${port})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "down", message: `Dolt ${host}:${port} failed: ${msg}`, latencyMs: null };
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
          resolveGitBin(),
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
      return { status: "degraded", message: "uncommitted changes present", latencyMs: elapsedMs };
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
        return { status: "degraded", message: "bd ready: no beads (empty queue)", latencyMs: elapsedMs };
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
  const statuses = new Set(Object.values(subsystems).map((s) => s.status));
  if (statuses.has("down")) return "fail";
  if (statuses.has("degraded")) return "degraded";
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
  const { repoPath, doltHost, doltPort, doltDatabase, kiloHost, kiloPort } = input;

  log.info(
    `checkStackHealth: checking 5 subsystems (kilo=${kiloHost}:${kiloPort}, dolt=${doltHost}:${doltPort})`,
  );

  // Run all checks in parallel for speed
  const [kiloServe, dolt, git, temporal, beads] = await Promise.all([
    checkKiloServe(kiloHost, kiloPort),
    checkDolt(doltHost, doltPort, doltDatabase),
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

  const { skipSet, backoffPendingSet, retryByBeadId } = buildRetrySelectionSets(
    retryLedger,
    skipList,
    Date.now(),
  );

  const { retryEligible, freshCandidates } = classifyEligibleCandidates(
    rawItems,
    skipSet,
    backoffPendingSet,
    retryByBeadId,
  );

  // Prefer retry-eligible beads whose backoff has elapsed
  const pool = retryEligible.length > 0 ? retryEligible : freshCandidates;
  pool.sort(comparePriority);

  const selected = pool[0] ?? null;
  log.info(
    `selectNextBead: ${rawItems.length} raw, ${pool.length} eligible (retryPreferred=${retryEligible.length > 0}), selected=${selected?.beadId ?? "none"}`,
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
    // Unexpected error — wrap as transient so Temporal retries
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(
      `updateBeadStatus: ${beadId} -> ${status} failed (wrapped as transient): ${msg}`,
    );
    throw new BeadsTransientError(msg, null, "");
  }
}

/**
 * Close a bead after durable success.
 *
 * Runs `bd close <beadId>` in the repository directory.
 *
 * ADR Section 5.6.
 */
export async function closeBead(
  input: CloseBeadInput,
): Promise<CloseBeadOutput> {
  const { beadId } = input;

  log.info(`closeBead: bd close ${beadId}`);
  try {
    await closeBeadCore(input.repoPath, beadId);
    log.info(`closeBead: ${beadId} closed successfully`);
    return { closed: true, error: null };
  } catch (e) {
    if (e instanceof BeadsTransientError) {
      log.warn(`closeBead: ${beadId} failed (transient): ${e.message}`);
      throw e; // Let Temporal retry
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`closeBead: ${beadId} failed: ${msg}`);
    return { closed: false, error: msg };
  }
}
