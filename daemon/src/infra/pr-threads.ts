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
import {
  type GitHubClient,
  createGitHubClient,
  discoverRepo as discoverRepoFromGit,
} from "./github-client.js";
import type { IssueComment, PrMeta, RawReviewComment, Review } from "./github-client.js";

// ── Types ────────────────────────────────────────────────────────────────

export type { IssueComment, PrMeta, RawReviewComment, Review };

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

/** The complete structured payload. */
export interface PrThreadsPayload {
  pr: PrMeta;
  changed_files: string[];
  thread_summary: ThreadSummary;
  inline_threads: InlineThread[];
  reviews: Review[];
  issue_comments: IssueComment[];
}

// ── Core logic ───────────────────────────────────────────────────────────

/**
 * Discover the repo owner/name (e.g. "org/repo") via git origin URL.
 */
export function discoverRepoStr(cwd?: string): string {
  const repoRef = discoverRepoFromGit(cwd);
  return `${repoRef.owner}/${repoRef.repo}`;
}

/**
 * Discover the current git branch name.
 */
export function discoverBranch(): string {
  // Use git directly, not gh, for branch discovery
  const output = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" });
  return output.trim();
}

/**
 * Discover the PR number for the current branch.
 * Returns null if no PR is found.
 */
export async function discoverPrNumber(
  branch: string,
  client: GitHubClient,
  repoRef: { owner: string; repo: string },
): Promise<number | null> {
  try {
    const prs = await client.listPrs(repoRef.owner, repoRef.repo, {
      head: `${repoRef.owner}:${branch}`,
      state: "open",
    });
    const num = prs[0]?.number;
    return typeof num === "number" ? num : null;
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
 * @param client - GitHub client (injectable for testing)
 */
export async function fetchPrThreads(
  prNumber: number | null = null,
  client?: GitHubClient,
): Promise<PrThreadsPayload> {
  const ghClient = client ?? createGitHubClient();
  const repoRef = discoverRepoFromGit();

  // Discover PR number if not provided
  let resolvedPrNumber = prNumber;
  if (resolvedPrNumber === null) {
    const branch = discoverBranch();
    resolvedPrNumber = await discoverPrNumber(branch, ghClient, repoRef);
    if (resolvedPrNumber === null) {
      throw new Error(`No PR found for branch '${branch}'`);
    }
  }

  // 1. PR metadata
  const meta = await ghClient.getPr(repoRef.owner, repoRef.repo, resolvedPrNumber);

  // 2. Review comments (inline, threaded via in_reply_to_id)
  const reviewComments = await ghClient.listReviewComments(repoRef.owner, repoRef.repo, resolvedPrNumber);

  // 3. PR-level reviews
  const reviews = await ghClient.listReviews(repoRef.owner, repoRef.repo, resolvedPrNumber);

  // 4. Changed files
  const changedFiles = await ghClient.listFiles(repoRef.owner, repoRef.repo, resolvedPrNumber);

  // 5. Issue-level comments
  const issueComments = await ghClient.listIssueComments(repoRef.owner, repoRef.repo, resolvedPrNumber);

  // Group inline comments into threads
  const inlineThreads = groupIntoThreads(reviewComments);

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
    reviews,
    issue_comments: issueComments,
  };
}
