/**
 * Tests for PR review threads structured payload.
 *
 * These tests verify the core logic using a mock GitHub client.
 */

import { describe, expect, it } from "vitest";
import { parseGitRemoteUrl, type GitHubClient, type IssueComment, type PrMeta, type Review } from "../src/infra/github-client.js";
import {
  type RawReviewComment,
  type PrThreadsPayload,
  groupIntoThreads,
  discoverPrNumber,
  fetchPrThreads,
} from "../src/infra/pr-threads.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_META = {
  number: 42,
  title: "feat: add widget",
  url: "https://github.com/org/repo/pull/42",
  headRefName: "feat/widget",
  baseRefName: "main",
  state: "OPEN",
  author: { login: "alice" },
  body: "Adds the widget feature.",
} satisfies PrMeta;

const MOCK_REVIEW_COMMENTS: RawReviewComment[] = [
  {
    id: 100,
    user: { login: "bob" },
    body: "Needs a null check here.",
    path: "src/widget.ts",
    line: 15,
    side: "RIGHT",
    created_at: "2026-03-01T10:00:00Z",
    diff_hunk: "@@ -10,5 +10,8 @@",
  },
  {
    id: 101,
    in_reply_to_id: 100,
    user: { login: "alice" },
    body: "Good point, fixed.",
    path: "src/widget.ts",
    line: 15,
    side: "RIGHT",
    created_at: "2026-03-01T11:00:00Z",
    diff_hunk: "@@ -10,5 +10,8 @@",
  },
  {
    id: 200,
    user: { login: "carol" },
    body: "Consider renaming this variable.",
    path: "src/utils.ts",
    line: 42,
    side: "RIGHT",
    created_at: "2026-03-01T12:00:00Z",
    diff_hunk: "@@ -40,3 +40,5 @@",
  },
];

const MOCK_REVIEWS: Review[] = [
  {
    author: { login: "bob" },
    state: "CHANGES_REQUESTED",
    body: "A few nits.",
    submittedAt: "2026-03-01T10:00:00Z",
  },
];

const MOCK_FILES = ["src/widget.ts", "src/utils.ts"];

const MOCK_ISSUE_COMMENTS: IssueComment[] = [
  {
    user: "dave",
    body: "LGTM overall, just the inline comments.",
    created_at: "2026-03-01T13:00:00Z",
  },
];

// ── Mock GitHub client factory ────────────────────────────────────────────

function makeMockClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const client: GitHubClient = {
    getPr: async () => MOCK_META,
    listPrs: async () => [{ number: 42 } as Awaited<ReturnType<GitHubClient["listPrs"]>>[number],
    ],
    listReviewComments: async () => MOCK_REVIEW_COMMENTS,
    listReviews: async () => MOCK_REVIEWS,
    listFiles: async () => MOCK_FILES,
    listIssueComments: async () => MOCK_ISSUE_COMMENTS,
    listMergedPrs: async () => [],
    ...overrides,
  };

  return client;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("pr-threads", () => {
  describe("parseGitRemoteUrl", () => {
    it("parses owner and repo from https remote", () => {
      const repo = parseGitRemoteUrl("https://github.com/org/repo.git");
      expect(repo).toEqual({ owner: "org", repo: "repo" });
    });
  });

  describe("discoverPrNumber", () => {
    it("discovers PR number from branch name", async () => {
      const client = makeMockClient({
        listPrs: async (_owner, _repo, params) => {
          if (params?.head === "org:feat/widget") {
            return [{ number: 42 } as Awaited<ReturnType<GitHubClient["listPrs"]>>[number]];
          }
          return [];
        },
      });
      const num = await discoverPrNumber("feat/widget", client, { owner: "org", repo: "repo" });
      expect(num).toBe(42);
    });

    it("returns null when no PR exists for branch", async () => {
      const client = makeMockClient({
        listPrs: async () => [],
      });
      const num = await discoverPrNumber("no-pr-branch", client, { owner: "org", repo: "repo" });
      expect(num).toBeNull();
    });

    it("returns null when client list call fails", async () => {
      const client = makeMockClient({
        listPrs: async () => {
          throw new Error("api error");
        },
      });
      const num = await discoverPrNumber("orphan", client, { owner: "org", repo: "repo" });
      expect(num).toBeNull();
    });
  });

  describe("groupIntoThreads", () => {
    it("groups reply comments under the parent thread", () => {
      const threads = groupIntoThreads(MOCK_REVIEW_COMMENTS);
      expect(threads).toHaveLength(2);

      // Thread 100: original comment + reply
      const thread100 = threads.find((t) => t.thread_id === 100);
      expect(thread100).toBeDefined();
      expect(thread100!.comments).toHaveLength(2);
      expect(thread100!.comment_count).toBe(2);
      expect(thread100!.path).toBe("src/widget.ts");
      expect(thread100!.line).toBe(15);
      expect(thread100!.comments[0].user).toBe("bob");
      expect(thread100!.comments[1].user).toBe("alice");

      // Thread 200: standalone comment
      const thread200 = threads.find((t) => t.thread_id === 200);
      expect(thread200).toBeDefined();
      expect(thread200!.comments).toHaveLength(1);
      expect(thread200!.comment_count).toBe(1);
      expect(thread200!.path).toBe("src/utils.ts");
    });

    it("returns empty array for no comments", () => {
      const threads = groupIntoThreads([]);
      expect(threads).toEqual([]);
    });

    it("sorts threads by thread_id", () => {
      const reversed: RawReviewComment[] = [
        {
          id: 300,
          user: { login: "z" },
          body: "last",
          path: "c.ts",
          created_at: "2026-01-03T00:00:00Z",
        },
        {
          id: 100,
          user: { login: "a" },
          body: "first",
          path: "a.ts",
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const threads = groupIntoThreads(reversed);
      expect(threads[0].thread_id).toBe(100);
      expect(threads[1].thread_id).toBe(300);
    });

    it("handles missing optional fields gracefully", () => {
      const comments: RawReviewComment[] = [
        {
          id: 500,
          user: { login: "minimal" },
          body: "bare comment",
          created_at: "2026-01-01T00:00:00Z",
        },
      ];
      const threads = groupIntoThreads(comments);
      expect(threads).toHaveLength(1);
      const c = threads[0].comments[0];
      expect(c.path).toBe("");
      expect(c.line).toBeNull();
      expect(c.side).toBe("");
      expect(c.diff_hunk).toBe("");
    });
  });

  describe("fetchPrThreads", () => {
    it("assembles complete payload with provided PR number", async () => {
      const client = makeMockClient();
      const payload: PrThreadsPayload = await fetchPrThreads(42, client);

      // PR metadata
      expect(payload.pr.number).toBe(42);
      expect(payload.pr.title).toBe("feat: add widget");
      expect(payload.pr.headRefName).toBe("feat/widget");
      expect(payload.pr.state).toBe("OPEN");

      // Changed files
      expect(payload.changed_files).toEqual(["src/widget.ts", "src/utils.ts"]);

      // Thread summary
      expect(payload.thread_summary.total_threads).toBe(2);
      expect(payload.thread_summary.total_inline_comments).toBe(3);
      expect(payload.thread_summary.total_issue_comments).toBe(1);

      // Inline threads
      expect(payload.inline_threads).toHaveLength(2);

      // Reviews
      expect(payload.reviews).toHaveLength(1);
      expect(payload.reviews[0].state).toBe("CHANGES_REQUESTED");

      // Issue comments
      expect(payload.issue_comments).toHaveLength(1);
      expect(payload.issue_comments[0].user).toBe("dave");
      expect(payload.issue_comments[0].body).toBe(
        "LGTM overall, just the inline comments.",
      );
    });

    it("handles PR with no review comments", async () => {
      const client = makeMockClient({
        listReviewComments: async () => [],
      });
      const payload = await fetchPrThreads(42, client);
      expect(payload.inline_threads).toEqual([]);
      expect(payload.thread_summary.total_threads).toBe(0);
      expect(payload.thread_summary.total_inline_comments).toBe(0);
    });

    it("handles PR with no issue comments", async () => {
      const client = makeMockClient({
        listIssueComments: async () => [],
      });
      const payload = await fetchPrThreads(42, client);
      expect(payload.issue_comments).toEqual([]);
      expect(payload.thread_summary.total_issue_comments).toBe(0);
    });

    it("handles PR with no reviews", async () => {
      const client = makeMockClient({
        listReviews: async () => [],
      });
      const payload = await fetchPrThreads(42, client);
      expect(payload.reviews).toEqual([]);
    });

    it("handles PR with no changed files", async () => {
      const client = makeMockClient({
        listFiles: async () => [],
      });
      const payload = await fetchPrThreads(42, client);
      expect(payload.changed_files).toEqual([]);
    });

    it("throws when client method fails for required data", async () => {
      const client = makeMockClient({
        getPr: async () => {
          throw new Error("api failed");
        },
      });
      await expect(fetchPrThreads(42, client)).rejects.toThrow("api failed");
    });
  });
});
