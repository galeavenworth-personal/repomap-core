/**
 * PR Reconciliation — Close Beads issues for merged GitHub PRs
 *
 * For each task-id, queries GitHub for merged PRs with a matching head
 * branch name, then closes the corresponding Beads issue via `bd close`.
 *
 * Uses the GitHubClient (@octokit/rest SDK) for all GitHub API access.
 *
 * Responsibilities:
 *   - Query merged PRs by head branch name using GitHubClient
 *   - Close matching Beads issues via bd CLI
 *   - Support --dry-run (report only, no mutations)
 *   - Support --strict (fail on any API or bd error)
 *   - Produce structured results per task-id
 *
 * See: repomap-core-76q.7, repomap-core-ovm.5
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { GitHubClient, MergedPrSummary } from "./github-client.js";

// ── Types ────────────────────────────────────────────────────────────────

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
  /** Fail on any GitHub or bd error. */
  strict: boolean;
  /** Repository root directory for git commands. */
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
 * Query GitHub for merged PRs with a head branch matching the given task-id.
 * Returns the parsed array (at most 1 result), or throws on API error.
 */
export async function queryMergedPrs(
  taskId: string,
  gh: GitHubClient,
): Promise<MergedPrSummary[]> {
  return gh.listMergedPullRequests(taskId, 1);
}

/**
 * Close a Beads issue by task-id via the bd CLI.
 *
 * Thin wrapper over the injectable BdRunner for testability.
 * The canonical closeBead implementation lives in bead-ops.ts;
 * this wrapper exists because pr-reconcile uses dependency injection
 * for its bd interactions.
 *
 * @see {@link ../infra/bead-ops.ts} for the canonical sync implementation.
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
export async function reconcileOne(
  taskId: string,
  opts: ReconcileOptions,
  gh: GitHubClient,
  runBd: BdRunner = makeBdRunner(opts.bdPath),
): Promise<ReconcileItemResult> {
  // Query merged PRs
  let mergedPrs: MergedPrSummary[];
  try {
    mergedPrs = await queryMergedPrs(taskId, gh);
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
 * @param gh - GitHub client (injectable for testing)
 * @param runBd - bd CLI command runner (injectable for testing)
 */
export async function reconcile(
  taskIds: string[],
  opts: ReconcileOptions,
  gh: GitHubClient,
  runBd: BdRunner = makeBdRunner(opts.bdPath),
): Promise<ReconcileResult> {
  // Check GitHub API availability first
  const ghAvailable = await gh.isAvailable();
  if (!ghAvailable) {
    if (opts.strict) {
      return {
        items: taskIds.map((taskId) => ({
          status: "gh_missing" as const,
          taskId,
          message: "GitHub API not reachable (cannot reconcile merged PRs)",
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
    const result = await reconcileOne(taskId, opts, gh, runBd);
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
 * Resolve the repository root directory.
 */
export function resolveRootDir(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch {
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
