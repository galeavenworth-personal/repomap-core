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
import { resolve } from "node:path";
import { log } from "@temporalio/activity";

import type {
  BeadCandidate,
  CloseBeadInput,
  CloseBeadOutput,
  SelectNextBeadInput,
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

// ── Activities ──

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
      log.warn(`closeBead: ${beadId} failed (transient): ${e.message}`);
      throw e; // Let Temporal retry
    }
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`closeBead: ${beadId} failed: ${msg}`);
    return { closed: false, error: msg };
  }
}
