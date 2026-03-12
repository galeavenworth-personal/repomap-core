/**
 * Tests for PR review threads structured payload.
 *
 * These tests verify the core logic using mock command runners,
 * without requiring a real GitHub repository or gh CLI.
 */

import { describe, expect, it } from "vitest";
import {
  type CommandRunner,
  type RawReviewComment,
  type PrThreadsPayload,
  groupIntoThreads,
  discoverPrNumber,
  discoverRepo,
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
};

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

const MOCK_REVIEWS = {
  reviews: [
    {
      author: { login: "bob" },
      state: "CHANGES_REQUESTED",
      body: "A few nits.",
      submittedAt: "2026-03-01T10:00:00Z",
    },
  ],
};

const MOCK_FILES = {
  files: [
    { path: "src/widget.ts", additions: 20, deletions: 5 },
    { path: "src/utils.ts", additions: 3, deletions: 1 },
  ],
};

const MOCK_ISSUE_COMMENTS = [
  {
    user: { login: "dave" },
    body: "LGTM overall, just the inline comments.",
    created_at: "2026-03-01T13:00:00Z",
  },
];

// ── Mock command runner factory ──────────────────────────────────────────

function makeMockRunner(
  overrides: Record<string, string> = {},
): CommandRunner {
  const responses: Record<string, string> = {
    "repo,view,--json,nameWithOwner,--jq,.nameWithOwner": "org/repo\n",
    "pr,list,--head,feat/widget,--json,number,--jq,.[0].number": "42\n",
    "pr,view,42,--json,number,title,url,headRefName,baseRefName,state,author,body":
      JSON.stringify(MOCK_META),
    "api,repos/org/repo/pulls/42/comments,--paginate":
      JSON.stringify(MOCK_REVIEW_COMMENTS),
    "pr,view,42,--json,reviews": JSON.stringify(MOCK_REVIEWS),
    "pr,view,42,--json,files": JSON.stringify(MOCK_FILES),
    "api,repos/org/repo/issues/42/comments,--paginate":
      JSON.stringify(MOCK_ISSUE_COMMENTS),
    ...overrides,
  };

  return (args: string[]): string => {
    const key = args.join(",");
    const response = responses[key];
    if (response === undefined) {
      throw new Error(`Mock runner: unexpected args: ${key}`);
    }
    return response;
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("pr-threads", () => {
  describe("discoverRepo", () => {
    it("extracts repo name from gh output", () => {
      const run = makeMockRunner();
      const repo = discoverRepo(run);
      expect(repo).toBe("org/repo");
    });
  });

  describe("discoverPrNumber", () => {
    it("discovers PR number from branch name", () => {
      const run = makeMockRunner();
      const num = discoverPrNumber("feat/widget", run);
      expect(num).toBe(42);
    });

    it("returns null when no PR exists for branch", () => {
      const run = makeMockRunner({
        "pr,list,--head,no-pr-branch,--json,number,--jq,.[0].number": "\n",
      });
      const num = discoverPrNumber("no-pr-branch", run);
      expect(num).toBeNull();
    });

    it("returns null when gh command fails", () => {
      const run: CommandRunner = () => {
        throw new Error("gh not found");
      };
      const num = discoverPrNumber("any-branch", run);
      expect(num).toBeNull();
    });

    it("returns null for null output", () => {
      const run = makeMockRunner({
        "pr,list,--head,orphan,--json,number,--jq,.[0].number": "null\n",
      });
      const num = discoverPrNumber("orphan", run);
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
    it("assembles complete payload with provided PR number", () => {
      const run = makeMockRunner();
      const payload: PrThreadsPayload = fetchPrThreads(42, run);

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

    it("handles PR with no review comments", () => {
      const run = makeMockRunner({
        "api,repos/org/repo/pulls/42/comments,--paginate": "[]",
      });
      const payload = fetchPrThreads(42, run);
      expect(payload.inline_threads).toEqual([]);
      expect(payload.thread_summary.total_threads).toBe(0);
      expect(payload.thread_summary.total_inline_comments).toBe(0);
    });

    it("handles PR with no issue comments", () => {
      const run = makeMockRunner({
        "api,repos/org/repo/issues/42/comments,--paginate": "[]",
      });
      const payload = fetchPrThreads(42, run);
      expect(payload.issue_comments).toEqual([]);
      expect(payload.thread_summary.total_issue_comments).toBe(0);
    });

    it("handles PR with no reviews", () => {
      const run = makeMockRunner({
        "pr,view,42,--json,reviews": JSON.stringify({ reviews: [] }),
      });
      const payload = fetchPrThreads(42, run);
      expect(payload.reviews).toEqual([]);
    });

    it("handles PR with no changed files", () => {
      const run = makeMockRunner({
        "pr,view,42,--json,files": JSON.stringify({ files: [] }),
      });
      const payload = fetchPrThreads(42, run);
      expect(payload.changed_files).toEqual([]);
    });

    it("handles missing files key gracefully", () => {
      const run = makeMockRunner({
        "pr,view,42,--json,files": JSON.stringify({}),
      });
      const payload = fetchPrThreads(42, run);
      expect(payload.changed_files).toEqual([]);
    });

    it("handles missing reviews key gracefully", () => {
      const run = makeMockRunner({
        "pr,view,42,--json,reviews": JSON.stringify({}),
      });
      const payload = fetchPrThreads(42, run);
      expect(payload.reviews).toEqual([]);
    });

    it("throws when gh command fails for required data", () => {
      const run: CommandRunner = (args) => {
        if (args[0] === "repo") return "org/repo\n";
        throw new Error("gh api failed");
      };
      expect(() => fetchPrThreads(42, run)).toThrow("gh api failed");
    });
  });
});
