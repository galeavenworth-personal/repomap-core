import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";

export interface PrMeta {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  author: { login: string };
  body: string | null;
}

export interface ListPrsParams {
  head?: string;
  state?: "open" | "closed" | "all";
  per_page?: number;
}

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

export interface Review {
  author: { login: string };
  state: string;
  body: string | null;
  submittedAt: string | null;
}

export interface IssueComment {
  user: string;
  body: string;
  created_at: string;
}

export interface MergedPr {
  number: number;
  url: string;
  title: string;
  mergedAt: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

type PullListItem = Awaited<ReturnType<Octokit["rest"]["pulls"]["list"]>>["data"][number];

export interface GitHubClient {
  getPr(owner: string, repo: string, pull_number: number): Promise<PrMeta>;
  listPrs(owner: string, repo: string, params?: ListPrsParams): Promise<PullListItem[]>;
  listReviewComments(owner: string, repo: string, pull_number: number): Promise<RawReviewComment[]>;
  listReviews(owner: string, repo: string, pull_number: number): Promise<Review[]>;
  listFiles(owner: string, repo: string, pull_number: number): Promise<string[]>;
  listIssueComments(owner: string, repo: string, issue_number: number): Promise<IssueComment[]>;
  listMergedPrs(owner: string, repo: string, head: string): Promise<MergedPr[]>;
}

export class OctokitGitHubClient implements GitHubClient {
  constructor(private readonly octokit: Octokit) {}

  async getPr(owner: string, repo: string, pull_number: number): Promise<PrMeta> {
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number });
    return {
      number: data.number,
      title: data.title,
      url: data.html_url,
      headRefName: data.head.ref,
      baseRefName: data.base.ref,
      state: data.state,
      author: { login: data.user?.login ?? "" },
      body: data.body,
    };
  }

  async listPrs(owner: string, repo: string, params: ListPrsParams = {}): Promise<PullListItem[]> {
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: params.state,
      head: params.head,
      per_page: params.per_page,
    });
    return data;
  }

  async listReviewComments(owner: string, repo: string, pull_number: number): Promise<RawReviewComment[]> {
    const comments = await this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    });

    return comments.map((comment) => ({
      id: comment.id,
      in_reply_to_id: comment.in_reply_to_id ?? undefined,
      user: { login: comment.user?.login ?? "" },
      body: comment.body,
      path: comment.path ?? undefined,
      line: comment.line,
      original_line: comment.original_line,
      side: comment.side ?? undefined,
      created_at: comment.created_at,
      diff_hunk: comment.diff_hunk ?? undefined,
    }));
  }

  async listReviews(owner: string, repo: string, pull_number: number): Promise<Review[]> {
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    });

    return reviews.map((review) => ({
      author: { login: review.user?.login ?? "" },
      state: review.state,
      body: review.body,
      submittedAt: review.submitted_at ?? null,
    }));
  }

  async listFiles(owner: string, repo: string, pull_number: number): Promise<string[]> {
    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    });

    return files.map((file) => file.filename);
  }

  async listIssueComments(owner: string, repo: string, issue_number: number): Promise<IssueComment[]> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number,
      per_page: 100,
    });

    return comments.map((comment) => ({
      user: comment.user?.login ?? "",
      body: comment.body ?? "",
      created_at: comment.created_at,
    }));
  }

  async listMergedPrs(owner: string, repo: string, head: string): Promise<MergedPr[]> {
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: "closed",
      head,
      per_page: 100,
    });

    return data
      .filter((pr) => pr.merged_at !== null)
      .map((pr) => ({
        number: pr.number,
        url: pr.html_url,
        title: pr.title,
        mergedAt: pr.merged_at as string,
      }));
  }
}

function resolveGitHubToken(explicitToken?: string): string {
  if (explicitToken) {
    return explicitToken;
  }

  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  try {
    const ghToken = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (ghToken) {
      return ghToken;
    }
  } catch {
    // Fall through to unified error below.
  }

  throw new Error(
    "Missing GitHub credentials: provide a token argument, set GITHUB_TOKEN, or authenticate with 'gh auth login'",
  );
}

export function createGitHubClient(token?: string): GitHubClient {
  const resolvedToken = resolveGitHubToken(token);

  return new OctokitGitHubClient(
    new Octokit({
      auth: resolvedToken,
    }),
  );
}

export function parseGitRemoteUrl(url: string): RepoRef {
  const trimmed = url.trim();

  const sshMatch = /^git@github\.com:([^/]+)\/([^\s]+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const sshProtocolMatch = /^ssh:\/\/git@github\.com\/([^/]+)\/([^\s]+?)(?:\.git)?$/.exec(trimmed);
  if (sshProtocolMatch) {
    return { owner: sshProtocolMatch[1], repo: sshProtocolMatch[2] };
  }

  const httpsMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  throw new Error(`Unsupported GitHub remote URL format: ${url}`);
}

export function discoverRepo(cwd?: string): RepoRef {
  const originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
  }).trim();

  return parseGitRemoteUrl(originUrl);
}
