/**
 * GitHub Client — Typed Octokit wrapper for PR operations
 *
 * Isolates all GitHub API access behind a typed interface so consumers
 * (pr-threads.ts, pr-reconcile.ts) never touch Octokit or gh CLI directly.
 *
 * Authentication: reads GITHUB_TOKEN from the environment (same env var
 * that the gh CLI uses).
 *
 * See: repomap-core-ovm.5
 */

import { Octokit } from "@octokit/rest";

// ── Types ────────────────────────────────────────────────────────────────

/** PR metadata normalized to match the PrMeta interface in pr-threads.ts. */
export interface PrMetadata {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  author: { login: string };
  body: string;
}

/** Raw review comment shape returned from GitHub REST API. */
export interface ReviewComment {
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

/** Review entry from GitHub REST API. */
export interface ReviewEntry {
  author: { login: string };
  state: string;
  body: string;
  submittedAt: string;
}

/** Issue comment from GitHub REST API. */
export interface IssueCommentEntry {
  user: { login: string };
  body: string;
  created_at: string;
}

/** Changed file path entry. */
export interface ChangedFile {
  path: string;
}

/** Merged PR summary for reconciliation. */
export interface MergedPrSummary {
  number: number;
  url: string;
  title: string;
  mergedAt: string;
}

/**
 * Typed interface for GitHub PR operations.
 * All methods are async. Consumers depend on this interface, not Octokit.
 */
export interface GitHubClient {
  /** Fetch PR metadata by number. */
  getPullRequest(prNumber: number): Promise<PrMetadata>;

  /** List all review comments (inline, threaded) for a PR. Handles pagination. */
  listReviewComments(prNumber: number): Promise<ReviewComment[]>;

  /** List all reviews for a PR. Handles pagination. */
  listReviews(prNumber: number): Promise<ReviewEntry[]>;

  /** List all changed files for a PR. Handles pagination. */
  listFiles(prNumber: number): Promise<ChangedFile[]>;

  /** List all issue-level comments for a PR. Handles pagination. */
  listIssueComments(prNumber: number): Promise<IssueCommentEntry[]>;

  /** List merged PRs whose head branch matches the given name. Returns at most `limit` results. */
  listMergedPullRequests(headBranch: string, limit?: number): Promise<MergedPrSummary[]>;

  /** Return the owner/repo slug, e.g. "org/repo". */
  getRepoSlug(): string;

  /** Check whether the client can reach the GitHub API. */
  isAvailable(): Promise<boolean>;
}

// ── Octokit implementation ──────────────────────────────────────────────

/**
 * Map GitHub API PR state to the upper-case form the gh CLI used.
 * GitHub REST API returns "open" | "closed", gh CLI returned "OPEN" | "CLOSED" | "MERGED".
 */
function normalizePrState(state: string, mergedAt: string | null): string {
  if (mergedAt) return "MERGED";
  return state.toUpperCase();
}

/**
 * Create a GitHubClient backed by @octokit/rest.
 *
 * @param owner - Repository owner (org or user)
 * @param repo  - Repository name
 * @param token - GitHub personal access token (defaults to GITHUB_TOKEN env var)
 */
export function createGitHubClient(
  owner: string,
  repo: string,
  token?: string,
): GitHubClient {
  const resolvedToken = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!resolvedToken) {
    throw new Error(
      "GitHub token not found. Set GITHUB_TOKEN or GH_TOKEN environment variable, or pass token explicitly.",
    );
  }

  const octokit = new Octokit({ auth: resolvedToken });

  return {
    async getPullRequest(prNumber: number): Promise<PrMetadata> {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return {
        number: data.number,
        title: data.title,
        url: data.html_url,
        headRefName: data.head.ref,
        baseRefName: data.base.ref,
        state: normalizePrState(data.state, data.merged_at),
        author: { login: data.user?.login ?? "unknown" },
        body: data.body ?? "",
      };
    },

    async listReviewComments(prNumber: number): Promise<ReviewComment[]> {
      const comments = await octokit.paginate(
        octokit.rest.pulls.listReviewComments,
        { owner, repo, pull_number: prNumber, per_page: 100 },
      );
      return comments.map((c) => ({
        id: c.id,
        in_reply_to_id: c.in_reply_to_id ?? undefined,
        user: { login: c.user.login },
        body: c.body,
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        original_line: c.original_line ?? null,
        side: c.side,
        created_at: c.created_at,
        diff_hunk: c.diff_hunk,
      }));
    },

    async listReviews(prNumber: number): Promise<ReviewEntry[]> {
      const reviews = await octokit.paginate(
        octokit.rest.pulls.listReviews,
        { owner, repo, pull_number: prNumber, per_page: 100 },
      );
      return reviews.map((r) => ({
        author: { login: r.user?.login ?? "unknown" },
        state: r.state,
        body: r.body ?? "",
        submittedAt: r.submitted_at ?? "",
      }));
    },

    async listFiles(prNumber: number): Promise<ChangedFile[]> {
      const files = await octokit.paginate(
        octokit.rest.pulls.listFiles,
        { owner, repo, pull_number: prNumber, per_page: 100 },
      );
      return files.map((f) => ({ path: f.filename }));
    },

    async listIssueComments(prNumber: number): Promise<IssueCommentEntry[]> {
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        { owner, repo, issue_number: prNumber, per_page: 100 },
      );
      return comments.map((c) => ({
        user: { login: c.user?.login ?? "unknown" },
        body: c.body ?? "",
        created_at: c.created_at,
      }));
    },

    async listMergedPullRequests(
      headBranch: string,
      limit = 1,
    ): Promise<MergedPrSummary[]> {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "closed",
        head: `${owner}:${headBranch}`,
        per_page: limit,
      });
      // Filter to only truly merged PRs
      return data
        .filter((pr) => pr.merged_at !== null)
        .slice(0, limit)
        .map((pr) => ({
          number: pr.number,
          url: pr.html_url,
          title: pr.title,
          mergedAt: pr.merged_at!,
        }));
    },

    getRepoSlug(): string {
      return `${owner}/${repo}`;
    },

    async isAvailable(): Promise<boolean> {
      try {
        await octokit.rest.rateLimit.get();
        return true;
      } catch {
        return false;
      }
    },
  };
}
