/**
 * Tests for PR reconciliation logic.
 *
 * These tests verify the core reconciliation logic using mock GitHubClient/bd runners,
 * without requiring a real GitHub repository, API token, or bd binary.
 */

import { describe, expect, it } from "vitest";
import type { GitHubClient, MergedPrSummary } from "../src/infra/github-client.js";
import {
  type BdRunner,
  type ReconcileOptions,
  reconcile,
  reconcileOne,
  queryMergedPrs,
  sanitizeError,
} from "../src/infra/pr-reconcile.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_MERGED_PR: MergedPrSummary[] = [
  {
    number: 99,
    url: "https://github.com/org/repo/pull/99",
    title: "feat: implement task-abc",
    mergedAt: "2026-03-10T12:00:00Z",
  },
];

const EMPTY_PR_LIST: MergedPrSummary[] = [];

function makeOpts(overrides: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return {
    dryRun: false,
    strict: false,
    rootDir: "/fake/repo",
    bdPath: "/fake/repo/.kilocode/tools/bd",
    ...overrides,
  };
}

// ── Mock client factories ───────────────────────────────────────────────

/** Base mock client with sensible defaults. */
function makeMockClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getPullRequest: async () => ({
      number: 1,
      title: "",
      url: "",
      headRefName: "",
      baseRefName: "",
      state: "OPEN",
      author: { login: "unknown" },
      body: "",
    }),
    listReviewComments: async () => [],
    listReviews: async () => [],
    listFiles: async () => [],
    listIssueComments: async () => [],
    listMergedPullRequests: async () => [],
    getRepoSlug: () => "org/repo",
    isAvailable: async () => true,
    ...overrides,
  };
}

/** Client that returns merged PRs for specific task-ids. */
function makeMergedPrClient(mergedMap: Record<string, MergedPrSummary[]> = {}): GitHubClient {
  return makeMockClient({
    listMergedPullRequests: async (headBranch: string) => {
      return mergedMap[headBranch] ?? [];
    },
    isAvailable: async () => true,
  });
}

/** Client that simulates GitHub API being unavailable. */
function makeUnavailableClient(): GitHubClient {
  return makeMockClient({
    isAvailable: async () => false,
    listMergedPullRequests: async () => {
      throw new Error("GitHub API not reachable");
    },
  });
}

/** Client that fails on PR queries but passes availability check. */
function makeFailingClient(): GitHubClient {
  return makeMockClient({
    isAvailable: async () => true,
    listMergedPullRequests: async () => {
      throw new Error("HTTP 500: internal server error\nfailed to query PRs");
    },
  });
}

// ── Mock bd runner factories ────────────────────────────────────────────

/** bd runner that succeeds for all close calls. */
function makeSuccessBdRunner(): BdRunner {
  return (): string => "Closed issue.\n";
}

/** bd runner that fails for all close calls. */
function makeFailingBdRunner(): BdRunner {
  return (): string => {
    throw new Error("bd close: issue not found\n  additional detail line");
  };
}

/** bd runner that tracks which task-ids were closed. */
function makeTrackingBdRunner(): { runner: BdRunner; closed: string[] } {
  const closed: string[] = [];
  const runner: BdRunner = (args: string[]): string => {
    if (args[0] === "close" && args[1]) {
      closed.push(args[1]);
    }
    return "Closed issue.\n";
  };
  return { runner, closed };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("pr-reconcile", () => {
  describe("sanitizeError", () => {
    it("collapses whitespace and trims", () => {
      const result = sanitizeError("line one\n  line two\n\tline three");
      expect(result).toBe("line one line two line three");
    });

    it("truncates to maxLen with ellipsis", () => {
      const longMsg = "x".repeat(300);
      const result = sanitizeError(longMsg, 200);
      expect(result).toHaveLength(201); // 200 + ellipsis char
      expect(result.endsWith("…")).toBe(true);
    });

    it("handles Error objects", () => {
      const err = new Error("something broke");
      const result = sanitizeError(err);
      expect(result).toBe("something broke");
    });

    it("handles non-string values", () => {
      const result = sanitizeError(42);
      expect(result).toBe("42");
    });

    it("returns message unchanged when under maxLen", () => {
      const result = sanitizeError("short message", 200);
      expect(result).toBe("short message");
    });
  });

  describe("queryMergedPrs", () => {
    it("returns parsed merged PR array", async () => {
      const gh = makeMergedPrClient({ "task-abc": MOCK_MERGED_PR });
      const result = await queryMergedPrs("task-abc", gh);
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(99);
      expect(result[0].url).toBe("https://github.com/org/repo/pull/99");
    });

    it("returns empty array when no merged PR", async () => {
      const gh = makeMergedPrClient({ "task-xyz": EMPTY_PR_LIST });
      const result = await queryMergedPrs("task-xyz", gh);
      expect(result).toEqual([]);
    });

    it("throws when client fails", async () => {
      const gh = makeFailingClient();
      await expect(queryMergedPrs("task-abc", gh)).rejects.toThrow();
    });
  });

  describe("reconcileOne", () => {
    it("returns 'closed' when merged PR found and bd close succeeds", async () => {
      const opts = makeOpts();
      const gh = makeMergedPrClient({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-abc", opts, gh, bdRun);
      expect(result.status).toBe("closed");
      expect(result.taskId).toBe("task-abc");
      expect(result.message).toContain("closed in Beads");
    });

    it("returns 'no_merged_pr' when no PR found", async () => {
      const opts = makeOpts();
      const gh = makeMergedPrClient({ "task-none": EMPTY_PR_LIST });
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-none", opts, gh, bdRun);
      expect(result.status).toBe("no_merged_pr");
      expect(result.message).toContain("no merged PR found");
    });

    it("returns 'dry_run' when merged PR found in dry-run mode", async () => {
      const opts = makeOpts({ dryRun: true });
      const gh = makeMergedPrClient({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-abc", opts, gh, bdRun);
      expect(result.status).toBe("dry_run");
      expect(result.message).toContain("dry-run");
      expect(result.message).toContain("would close");
    });

    it("does not call bd close in dry-run mode", async () => {
      const opts = makeOpts({ dryRun: true });
      const gh = makeMergedPrClient({ "task-abc": MOCK_MERGED_PR });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      await reconcileOne("task-abc", opts, gh, bdRun);
      expect(closed).toEqual([]);
    });

    it("returns 'gh_error' when query fails (lenient)", async () => {
      const opts = makeOpts({ strict: false });
      const gh = makeFailingClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-abc", opts, gh, bdRun);
      expect(result.status).toBe("gh_error");
      expect(result.message).toContain("reconciliation skipped");
    });

    it("returns 'gh_error' when query fails (strict)", async () => {
      const opts = makeOpts({ strict: true });
      const gh = makeFailingClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-abc", opts, gh, bdRun);
      expect(result.status).toBe("gh_error");
      expect(result.message).toContain("gh query failed");
    });

    it("returns 'bd_error' when bd close fails (lenient)", async () => {
      const opts = makeOpts({ strict: false });
      const gh = makeMergedPrClient({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeFailingBdRunner();
      const result = await reconcileOne("task-abc", opts, gh, bdRun);
      expect(result.status).toBe("bd_error");
      expect(result.message).toContain("FAILED to close");
    });

    it("returns 'bd_error' when bd close fails (strict)", async () => {
      const opts = makeOpts({ strict: true });
      const gh = makeMergedPrClient({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeFailingBdRunner();
      const result = await reconcileOne("task-abc", opts, gh, bdRun);
      expect(result.status).toBe("bd_error");
      expect(result.message).toContain("bd close failed");
    });

    it("calls bd close with the correct task-id", async () => {
      const opts = makeOpts();
      const gh = makeMergedPrClient({ "task-abc": MOCK_MERGED_PR });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      await reconcileOne("task-abc", opts, gh, bdRun);
      expect(closed).toEqual(["task-abc"]);
    });
  });

  describe("reconcile", () => {
    it("processes multiple task-ids", async () => {
      const opts = makeOpts();
      const gh = makeMergedPrClient({
        "task-a": MOCK_MERGED_PR,
        "task-b": EMPTY_PR_LIST,
        "task-c": MOCK_MERGED_PR,
      });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = await reconcile(["task-a", "task-b", "task-c"], opts, gh, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(3);
      expect(result.items[0].status).toBe("closed");
      expect(result.items[1].status).toBe("no_merged_pr");
      expect(result.items[2].status).toBe("closed");
      expect(closed).toEqual(["task-a", "task-c"]);
    });

    it("returns gh_missing for all items when GitHub API is unavailable (lenient)", async () => {
      const opts = makeOpts({ strict: false });
      const gh = makeUnavailableClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcile(["task-a", "task-b"], opts, gh, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_missing");
      expect(result.items[1].status).toBe("gh_missing");
      expect(result.items[0].message).toContain("gh missing");
    });

    it("returns gh_missing and fails when GitHub API is unavailable (strict)", async () => {
      const opts = makeOpts({ strict: true });
      const gh = makeUnavailableClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcile(["task-a", "task-b"], opts, gh, bdRun);

      expect(result.success).toBe(false);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_missing");
      expect(result.items[0].message).toContain("GitHub API not reachable");
    });

    it("stops processing on first error in strict mode (gh_error)", async () => {
      const opts = makeOpts({ strict: true });
      const gh = makeFailingClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcile(["task-a", "task-b", "task-c"], opts, gh, bdRun);

      expect(result.success).toBe(false);
      // Should stop after first failure
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("gh_error");
    });

    it("stops processing on first error in strict mode (bd_error)", async () => {
      const opts = makeOpts({ strict: true });
      const gh = makeMergedPrClient({
        "task-a": MOCK_MERGED_PR,
        "task-b": MOCK_MERGED_PR,
      });
      const bdRun = makeFailingBdRunner();
      const result = await reconcile(["task-a", "task-b"], opts, gh, bdRun);

      expect(result.success).toBe(false);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("bd_error");
    });

    it("continues processing on errors in lenient mode", async () => {
      const opts = makeOpts({ strict: false });
      // task-a fails, task-b succeeds
      let callCount = 0;
      const gh = makeMockClient({
        isAvailable: async () => true,
        listMergedPullRequests: async () => {
          callCount++;
          if (callCount === 1) throw new Error("transient failure");
          return MOCK_MERGED_PR;
        },
      });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = await reconcile(["task-a", "task-b"], opts, gh, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_error");
      expect(result.items[1].status).toBe("closed");
      expect(closed).toEqual(["task-b"]);
    });

    it("handles dry-run mode for multiple task-ids", async () => {
      const opts = makeOpts({ dryRun: true });
      const gh = makeMergedPrClient({
        "task-a": MOCK_MERGED_PR,
        "task-b": MOCK_MERGED_PR,
      });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = await reconcile(["task-a", "task-b"], opts, gh, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("dry_run");
      expect(result.items[1].status).toBe("dry_run");
      expect(closed).toEqual([]); // No mutations
    });

    it("handles empty task-id list", async () => {
      const opts = makeOpts();
      const gh = makeMergedPrClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcile([], opts, gh, bdRun);

      expect(result.items).toHaveLength(0);
      expect(result.success).toBe(true);
    });

    it("sanitizes multi-line error messages from API", async () => {
      const opts = makeOpts({ strict: false });
      const gh = makeMockClient({
        isAvailable: async () => true,
        listMergedPullRequests: async () => {
          throw new Error("HTTP 500:\n  internal server error\n  request-id: abc123");
        },
      });
      const bdRun = makeSuccessBdRunner();
      const result = await reconcile(["task-a"], opts, gh, bdRun);

      expect(result.items[0].status).toBe("gh_error");
      // Error message should be collapsed to single line
      expect(result.items[0].message).not.toContain("\n");
    });
  });
});
