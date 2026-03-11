/**
 * PR Review Threads — Structured Payload for Agent Handoff
 *
 * Migrated from .kilocode/tools/gh_pr_threads.sh (127 lines).
 * Fetches PR review threads as structured JSON using the gh CLI
 * for GitHub API calls, then groups inline comments into threads.
 *
 * Responsibilities:
 *   - Discover PR number from the current branch (if not provided)
 *   - Fetch PR metadata, review comments, reviews, files, issue comments
 *   - Group inline review comments into threads by in_reply_to_id
 *   - Produce a structured JSON payload for downstream agent consumption
 *
 * See: repomap-core-76q.6
 */

import { execFileSync } from "node:child_process";

// ── Types ────────────────────────────────────────────────────────────────

/** Function signature for running gh CLI commands. Injectable for testing. */
export type CommandRunner = (args: string[]) => string;

/** PR metadata from `gh pr view`. */
export interface PrMeta {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  author: { login: string };
  body: string;
}

/** Raw review comment from the GitHub REST API. */
export interface RawReviewComment {
  id: number;
  in_reply_to_id?: number;
  user: { login: string };
  body: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  side?: string;
  created_at: string;
  diff_hunk?: string;
}

/** A single comment within a thread (normalized). */
export interface ThreadComment {
  id: number;
  user: string;
  body: string;
  path: string;
  line: number | null;
  side: string;
  created_at: string;
  diff_hunk: string;
}

/** A grouped inline thread. */
export interface InlineThread {
  thread_id: number;
  path: string;
  line: number | null;
  comments: ThreadComment[];
  comment_count: number;
}

/** Summary statistics for the payload. */
export interface ThreadSummary {
  total_threads: number;
  total_inline_comments: number;
  total_issue_comments: number;
}

/** Raw issue comment from the GitHub REST API. */
export interface RawIssueComment {
  user: { login: string };
  body: string;
  created_at: string;
}

/** Normalized issue comment in the payload. */
export interface IssueComment {
  user: string;
  body: string;
  created_at: string;
}

/** Review entry from `gh pr view --json reviews`. */
export interface Review {
  author: { login: string };
  state: string;
  body: string;
  submittedAt: string;
}

/** The complete structured payload. */
export interface PrThreadsPayload {
  pr: PrMeta;
  changed_files: string[];
  thread_summary: ThreadSummary;
  inline_threads: InlineThread[];
  reviews: Review[];
  issue_comments: IssueComment[];
}

// ── Default command runner ───────────────────────────────────────────────

/**
 * Default command runner: executes `gh` with the given arguments
 * and returns stdout as a string.
 */
export function defaultCommandRunner(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024, // 50 MB for large PRs
  });
}

// ── Core logic ───────────────────────────────────────────────────────────

/**
 * Discover the repo owner/name (e.g. "org/repo") via `gh repo view`.
 */
export function discoverRepo(run: CommandRunner = defaultCommandRunner): string {
  const output = run(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  return output.trim();
}

/**
 * Discover the current git branch name.
 */
export function discoverBranch(run: CommandRunner = defaultCommandRunner): string {
  // Use git directly, not gh, for branch discovery
  const output = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" });
  return output.trim();
}

/**
 * Discover the PR number for the current branch.
 * Returns null if no PR is found.
 */
export function discoverPrNumber(
  branch: string,
  run: CommandRunner = defaultCommandRunner,
): number | null {
  try {
    const output = run([
      "pr", "list",
      "--head", branch,
      "--json", "number",
      "--jq", ".[0].number",
    ]);
    const trimmed = output.trim();
    if (trimmed === "" || trimmed === "null") return null;
    const num = Number.parseInt(trimmed, 10);
    return Number.isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

/**
 * Group raw review comments into threads by in_reply_to_id.
 * Comments with no in_reply_to_id start their own thread (keyed by their own id).
 */
export function groupIntoThreads(reviewComments: RawReviewComment[]): InlineThread[] {
  const threads = new Map<number, ThreadComment[]>();

  for (const c of reviewComments) {
    const threadId = c.in_reply_to_id ?? c.id;
    const comment: ThreadComment = {
      id: c.id,
      user: c.user.login,
      body: c.body,
      path: c.path ?? "",
      line: c.line ?? c.original_line ?? null,
      side: c.side ?? "",
      created_at: c.created_at,
      diff_hunk: c.diff_hunk ?? "",
    };

    const existing = threads.get(threadId);
    if (existing) {
      existing.push(comment);
    } else {
      threads.set(threadId, [comment]);
    }
  }

  // Sort by thread_id for deterministic output
  const sortedEntries = [...threads.entries()].sort(([a], [b]) => a - b);

  return sortedEntries.map(([threadId, comments]) => ({
    thread_id: threadId,
    path: comments[0].path,
    line: comments[0].line,
    comments,
    comment_count: comments.length,
  }));
}

/**
 * Fetch all PR review thread data and assemble the structured payload.
 *
 * @param prNumber - PR number (if null, auto-discovers from current branch)
 * @param run - Command runner (injectable for testing)
 */
export function fetchPrThreads(
  prNumber: number | null = null,
  run: CommandRunner = defaultCommandRunner,
): PrThreadsPayload {
  // Discover PR number if not provided
  let resolvedPrNumber = prNumber;
  if (resolvedPrNumber === null) {
    const branch = discoverBranch();
    resolvedPrNumber = discoverPrNumber(branch, run);
    if (resolvedPrNumber === null) {
      throw new Error(`No PR found for branch '${branch}'`);
    }
  }

  const repo = discoverRepo(run);
  const prStr = String(resolvedPrNumber);

  // 1. PR metadata
  const metaRaw = run([
    "pr", "view", prStr,
    "--json", "number,title,url,headRefName,baseRefName,state,author,body",
  ]);
  const meta: PrMeta = JSON.parse(metaRaw);

  // 2. Review comments (inline, threaded via in_reply_to_id)
  const reviewCommentsRaw = run([
    "api", `repos/${repo}/pulls/${prStr}/comments`, "--paginate",
  ]);
  const reviewComments: RawReviewComment[] = JSON.parse(reviewCommentsRaw);

  // 3. PR-level reviews
  const reviewsRaw = run(["pr", "view", prStr, "--json", "reviews"]);
  const reviewsData: { reviews: Review[] } = JSON.parse(reviewsRaw);

  // 4. Changed files
  const filesRaw = run(["pr", "view", prStr, "--json", "files"]);
  const filesData: { files: Array<{ path: string }> } = JSON.parse(filesRaw);

  // 5. Issue-level comments
  const issueCommentsRaw = run([
    "api", `repos/${repo}/issues/${prStr}/comments`, "--paginate",
  ]);
  const issueComments: RawIssueComment[] = JSON.parse(issueCommentsRaw);

  // Group inline comments into threads
  const inlineThreads = groupIntoThreads(reviewComments);

  // Extract changed file paths
  const changedFiles = (filesData.files ?? []).map((f) => f.path);

  // Assemble payload
  return {
    pr: meta,
    changed_files: changedFiles,
    thread_summary: {
      total_threads: inlineThreads.length,
      total_inline_comments: reviewComments.length,
      total_issue_comments: issueComments.length,
    },
    inline_threads: inlineThreads,
    reviews: reviewsData.reviews ?? [],
    issue_comments: issueComments.map((c) => ({
      user: c.user.login,
      body: c.body,
      created_at: c.created_at,
    })),
  };
}
