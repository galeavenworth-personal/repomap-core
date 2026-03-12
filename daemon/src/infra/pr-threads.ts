/**
 * PR Review Threads — Structured Payload for Agent Handoff
 *
 * Fetches PR review threads as structured JSON using the GitHubClient
 * (@octokit/rest SDK), then groups inline comments into threads.
 *
 * Responsibilities:
 *   - Fetch PR metadata, review comments, reviews, files, issue comments
 *   - Group inline review comments into threads by in_reply_to_id
 *   - Produce a structured JSON payload for downstream agent consumption
 *
 * See: repomap-core-76q.6, repomap-core-ovm.5
 */

import type { GitHubClient } from "./github-client.js";

// ── Types ────────────────────────────────────────────────────────────────

/** PR metadata from GitHub API. */
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

/** Review entry from GitHub API. */
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

// ── Core logic ───────────────────────────────────────────────────────────

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
 * @param prNumber - PR number
 * @param gh       - GitHub client (injectable for testing)
 */
export async function fetchPrThreads(
  prNumber: number,
  gh: GitHubClient,
): Promise<PrThreadsPayload> {
  // Fetch all data concurrently
  const [meta, reviewComments, reviewsData, filesData, issueComments] = await Promise.all([
    gh.getPullRequest(prNumber),
    gh.listReviewComments(prNumber),
    gh.listReviews(prNumber),
    gh.listFiles(prNumber),
    gh.listIssueComments(prNumber),
  ]);

  // Group inline comments into threads
  const inlineThreads = groupIntoThreads(reviewComments);

  // Extract changed file paths
  const changedFiles = filesData.map((f) => f.path);

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
    reviews: reviewsData,
    issue_comments: issueComments.map((c) => ({
      user: c.user.login,
      body: c.body,
      created_at: c.created_at,
    })),
  };
}
