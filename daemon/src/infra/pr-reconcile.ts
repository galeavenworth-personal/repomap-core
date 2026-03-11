/**
 * PR Reconciliation — Close Beads issues for merged GitHub PRs
 *
 * Migrated from .kilocode/tools/bd_reconcile_merged_prs.sh (116 lines).
 * For each task-id, queries GitHub for merged PRs with a matching head
 * branch name, then closes the corresponding Beads issue via `bd close`.
 *
 * Responsibilities:
 *   - Query merged PRs by head branch name using gh CLI
 *   - Close matching Beads issues via bd CLI
 *   - Support --dry-run (report only, no mutations)
 *   - Support --strict (fail on any gh or bd error)
 *   - Produce structured results per task-id
 *
 * See: repomap-core-76q.7
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────

/** Function signature for running gh CLI commands. Injectable for testing. */
export type GhRunner = (args: string[], cwd?: string) => string;

/** Function signature for running bd CLI commands. Injectable for testing. */
export type BdRunner = (args: string[]) => string;

/** Result of reconciling a single task-id. */
export type ReconcileItemResult =
  | { status: "closed"; taskId: string; message: string }
  | { status: "no_merged_pr"; taskId: string; message: string }
  | { status: "dry_run"; taskId: string; message: string }
  | { status: "gh_error"; taskId: string; message: string }
  | { status: "bd_error"; taskId: string; message: string }
  | { status: "gh_missing"; taskId: string; message: string };

/** Options for the reconciliation run. */
export interface ReconcileOptions {
  /** Do not mutate Beads; just report what would be closed. */
  dryRun: boolean;
  /** Fail on any gh or bd error. */
  strict: boolean;
  /** Repository root directory for gh commands. */
  rootDir: string;
  /** Path to the bd binary. */
  bdPath: string;
}

/** Aggregate result of a reconciliation run. */
export interface ReconcileResult {
  items: ReconcileItemResult[];
  /** True if the run succeeded (no fatal errors). */
  success: boolean;
}

// ── Default runners ─────────────────────────────────────────────────────

/**
 * Default gh command runner: executes `gh` with the given arguments
 * and returns stdout as a string.
 */
export function defaultGhRunner(args: string[], cwd?: string): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Default bd command runner: executes the bd binary with the given arguments
 * and returns stdout as a string.
 */
export function makeBdRunner(bdPath: string): BdRunner {
  return (args: string[]): string => {
    return execFileSync(bdPath, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  };
}

// ── Core logic ───────────────────────────────────────────────────────────

/**
 * Check whether the gh CLI is available.
 */
export function isGhAvailable(runGh: GhRunner = defaultGhRunner): boolean {
  try {
    runGh(["version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Query GitHub for merged PRs with a head branch matching the given task-id.
 * Returns the parsed JSON array (at most 1 result), or throws on gh error.
 */
export function queryMergedPrs(
  taskId: string,
  rootDir: string,
  runGh: GhRunner = defaultGhRunner,
): Array<{ number: number; url: string; title: string; mergedAt: string }> {
  const output = runGh(
    ["pr", "list", "--state", "merged", "--head", taskId, "-L", "1", "--json", "number,url,title,mergedAt"],
    rootDir,
  );
  const parsed = JSON.parse(output);
  return parsed;
}

/**
 * Close a Beads issue by task-id via the bd CLI.
 * Throws on bd error.
 */
export function closeBead(
  taskId: string,
  runBd: BdRunner,
): void {
  runBd(["close", taskId]);
}

/**
 * Truncate and sanitize an error message for structured output.
 * Collapses whitespace and limits to maxLen characters.
 */
export function sanitizeError(raw: unknown, maxLen = 200): string {
  const msg = raw instanceof Error ? raw.message : String(raw);
  const collapsed = msg.replaceAll(/\s+/g, " ").trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) + "…" : collapsed;
}

/**
 * Reconcile a single task-id: check for merged PR, close bead if found.
 */
export function reconcileOne(
  taskId: string,
  opts: ReconcileOptions,
  runGh: GhRunner = defaultGhRunner,
  runBd: BdRunner = makeBdRunner(opts.bdPath),
): ReconcileItemResult {
  // Query merged PRs
  let mergedPrs: Array<{ number: number; url: string; title: string; mergedAt: string }>;
  try {
    mergedPrs = queryMergedPrs(taskId, opts.rootDir, runGh);
  } catch (err) {
    const errMsg = sanitizeError(err);
    if (opts.strict) {
      return { status: "gh_error", taskId, message: `gh query failed: ${errMsg}` };
    }
    return { status: "gh_error", taskId, message: `reconciliation skipped (gh error): ${errMsg}` };
  }

  // No merged PR found
  if (mergedPrs.length === 0) {
    return { status: "no_merged_pr", taskId, message: "no merged PR found (no-op)" };
  }

  // Dry-run mode
  if (opts.dryRun) {
    return { status: "dry_run", taskId, message: "merged PR found (dry-run; would close in Beads)" };
  }

  // Close the bead
  try {
    closeBead(taskId, runBd);
  } catch (err) {
    const errMsg = sanitizeError(err);
    if (opts.strict) {
      return { status: "bd_error", taskId, message: `bd close failed: ${errMsg}` };
    }
    return { status: "bd_error", taskId, message: `merged PR found; FAILED to close in Beads: ${errMsg}` };
  }

  return { status: "closed", taskId, message: "merged PR found; closed in Beads" };
}

/**
 * Reconcile multiple task-ids against merged GitHub PRs.
 * This is the main entry point for the reconciliation logic.
 *
 * @param taskIds - Task IDs to reconcile
 * @param opts - Reconciliation options
 * @param runGh - gh CLI command runner (injectable for testing)
 * @param runBd - bd CLI command runner (injectable for testing)
 */
export function reconcile(
  taskIds: string[],
  opts: ReconcileOptions,
  runGh: GhRunner = defaultGhRunner,
  runBd: BdRunner = makeBdRunner(opts.bdPath),
): ReconcileResult {
  // Check gh availability first
  if (!isGhAvailable(runGh)) {
    if (opts.strict) {
      return {
        items: taskIds.map((taskId) => ({
          status: "gh_missing" as const,
          taskId,
          message: "gh CLI not found on PATH (cannot reconcile merged PRs)",
        })),
        success: false,
      };
    }
    return {
      items: taskIds.map((taskId) => ({
        status: "gh_missing" as const,
        taskId,
        message: "reconciliation skipped (gh missing)",
      })),
      success: true,
    };
  }

  const items: ReconcileItemResult[] = [];
  let success = true;

  for (const taskId of taskIds) {
    const result = reconcileOne(taskId, opts, runGh, runBd);
    items.push(result);

    // In strict mode, gh_error and bd_error are fatal
    if (opts.strict && (result.status === "gh_error" || result.status === "bd_error")) {
      success = false;
      break; // Stop processing further task-ids
    }
  }

  return { items, success };
}

// ── Default options factory ─────────────────────────────────────────────

/**
 * Resolve the repository root directory (two levels up from .kilocode/tools/).
 */
export function resolveRootDir(): string {
  // Use the git rev-parse to find the repo root
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // Fallback: assume we're in the repo root
    return process.cwd();
  }
}

/**
 * Create default reconcile options.
 */
export function defaultOptions(overrides: Partial<ReconcileOptions> = {}): ReconcileOptions {
  const rootDir = overrides.rootDir ?? resolveRootDir();
  return {
    dryRun: false,
    strict: false,
    rootDir,
    bdPath: overrides.bdPath ?? resolve(rootDir, ".kilocode/tools/bd"),
    ...overrides,
  };
}
