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
import { type GitHubClient, type MergedPr, createGitHubClient, discoverRepo } from "./github-client.js";

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
 * Check whether GitHub access is available.
 */
export function isGhAvailable(client?: GitHubClient): boolean {
  if (client) {
    return true;
  }

  try {
    createGitHubClient();
    return true;
  } catch {
    return false;
  }
}

/**
 * Query GitHub for merged PRs with a head branch matching the given task-id.
 * Returns merged PR metadata from the GitHub API client.
 */
export function queryMergedPrs(
  taskId: string,
  client: GitHubClient,
  repoRef: { owner: string; repo: string },
): Promise<MergedPr[]> {
  return client.listMergedPrs(repoRef.owner, repoRef.repo, `${repoRef.owner}:${taskId}`);
}

/**
 * Close a Beads issue by task-id via the bd CLI.
 * Throws on bd error.
 *
 * This is a thin adapter over an injected {@link BdRunner} for testability.
 * The canonical bead-close implementation lives in {@link closeBeadCore} from `./bead-ops.js`.
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
  client: GitHubClient,
  repoRef: { owner: string; repo: string },
  runBd: BdRunner = makeBdRunner(opts.bdPath),
): Promise<ReconcileItemResult> {
  // Query merged PRs
  let mergedPrs: MergedPr[];
  try {
    mergedPrs = await queryMergedPrs(taskId, client, repoRef);
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
 * @param client - GitHub client (injectable for testing)
 * @param runBd - bd CLI command runner (injectable for testing)
 */
export async function reconcile(
  taskIds: string[],
  opts: ReconcileOptions,
  client?: GitHubClient,
  runBd: BdRunner = makeBdRunner(opts.bdPath),
): Promise<ReconcileResult> {
  let ghClient: GitHubClient;
  try {
    ghClient = client ?? createGitHubClient();
  } catch {
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

  let repoRef: { owner: string; repo: string };
  try {
    repoRef = discoverRepo(opts.rootDir);
  } catch {
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
    const result = await reconcileOne(taskId, opts, ghClient, repoRef, runBd);
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
