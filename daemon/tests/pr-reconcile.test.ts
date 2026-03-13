/**
 * Tests for PR reconciliation logic.
 *
 * These tests verify the core reconciliation logic using mock GitHub client
 * and mock bd runners, without requiring live GitHub API calls or bd binary.
 */

import { describe, expect, it } from "vitest";
import type { GitHubClient, MergedPr } from "../src/infra/github-client.js";
import {
  type BdRunner,
  type ReconcileOptions,
  reconcile,
  reconcileOne,
  queryMergedPrs,
  isGhAvailable,
  sanitizeError,
} from "../src/infra/pr-reconcile.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const REPO_REF = { owner: "org", repo: "repo" };

const MOCK_MERGED_PR: MergedPr[] = [
  {
    number: 99,
    url: "https://github.com/org/repo/pull/99",
    title: "feat: implement task-abc",
    mergedAt: "2026-03-10T12:00:00Z",
  },
];

const EMPTY_PR_LIST: MergedPr[] = [];

function makeOpts(overrides: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return {
    dryRun: false,
    strict: false,
    rootDir: process.cwd(),
    bdPath: "/fake/repo/.kilocode/tools/bd",
    ...overrides,
  };
}

async function withoutGitHubCredentials<T>(fn: () => Promise<T>): Promise<T> {
  const originalToken = process.env.GITHUB_TOKEN;
  const originalPath = process.env.PATH;
  delete process.env.GITHUB_TOKEN;
  process.env.PATH = "/nonexistent";
  try {
    return await fn();
  } finally {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
}

// ── Mock factories ───────────────────────────────────────────────────────

/** GitHub client that returns merged PRs for specific task-ids. */
function makeMockClient(mergedMap: Record<string, MergedPr[]> = {}): GitHubClient {
  return {
    async getPr() {
      throw new Error("getPr not implemented in test mock");
    },
    async listPrs() {
      return [];
    },
    async listReviewComments() {
      return [];
    },
    async listReviews() {
      return [];
    },
    async listFiles() {
      return [];
    },
    async listIssueComments() {
      return [];
    },
    async listMergedPrs(_owner: string, _repo: string, head: string) {
      const taskId = head.includes(":") ? head.split(":").slice(1).join(":") : head;
      return mergedMap[taskId] ?? [];
    },
  };
}

/** GitHub client that fails on merged PR queries. */
function makeFailingClient(): GitHubClient {
  return {
    ...makeMockClient(),
    async listMergedPrs() {
      throw new Error("HTTP 500: internal server error\nfailed to query PRs");
    },
  };
}

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

  describe("isGhAvailable", () => {
    it("returns true when a client is provided", () => {
      const client = makeMockClient();
      expect(isGhAvailable(client)).toBe(true);
    });

    it("returns false when no token is available", async () => {
      await withoutGitHubCredentials(async () => {
        expect(isGhAvailable()).toBe(false);
      });
    });
  });

  describe("queryMergedPrs", () => {
    it("returns merged PR array from client", async () => {
      const client = makeMockClient({ "task-abc": MOCK_MERGED_PR });
      const result = await queryMergedPrs("task-abc", client, REPO_REF);
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(99);
      expect(result[0].url).toBe("https://github.com/org/repo/pull/99");
    });

    it("returns empty array when no merged PR", async () => {
      const client = makeMockClient({ "task-xyz": EMPTY_PR_LIST });
      const result = await queryMergedPrs("task-xyz", client, REPO_REF);
      expect(result).toEqual([]);
    });

    it("throws when client query fails", async () => {
      const client = makeFailingClient();
      await expect(queryMergedPrs("task-abc", client, REPO_REF)).rejects.toThrow();
    });
  });

  describe("reconcileOne", () => {
    it("returns 'closed' when merged PR found and bd close succeeds", async () => {
      const opts = makeOpts();
      const client = makeMockClient({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-abc", opts, client, REPO_REF, bdRun);
      expect(result.status).toBe("closed");
      expect(result.taskId).toBe("task-abc");
      expect(result.message).toContain("closed in Beads");
    });

    it("returns 'no_merged_pr' when no PR found", async () => {
      const opts = makeOpts();
      const client = makeMockClient({ "task-none": EMPTY_PR_LIST });
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-none", opts, client, REPO_REF, bdRun);
      expect(result.status).toBe("no_merged_pr");
      expect(result.message).toContain("no merged PR found");
    });

    it("returns 'dry_run' when merged PR found in dry-run mode", async () => {
      const opts = makeOpts({ dryRun: true });
      const client = makeMockClient({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-abc", opts, client, REPO_REF, bdRun);
      expect(result.status).toBe("dry_run");
      expect(result.message).toContain("dry-run");
      expect(result.message).toContain("would close");
    });

    it("does not call bd close in dry-run mode", async () => {
      const opts = makeOpts({ dryRun: true });
      const client = makeMockClient({ "task-abc": MOCK_MERGED_PR });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      await reconcileOne("task-abc", opts, client, REPO_REF, bdRun);
      expect(closed).toEqual([]);
    });

    it("returns 'gh_error' when gh query fails (lenient)", async () => {
      const opts = makeOpts({ strict: false });
      const client = makeFailingClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-abc", opts, client, REPO_REF, bdRun);
      expect(result.status).toBe("gh_error");
      expect(result.message).toContain("reconciliation skipped");
    });

    it("returns 'gh_error' when gh query fails (strict)", async () => {
      const opts = makeOpts({ strict: true });
      const client = makeFailingClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcileOne("task-abc", opts, client, REPO_REF, bdRun);
      expect(result.status).toBe("gh_error");
      expect(result.message).toContain("gh query failed");
    });

    it("returns 'bd_error' when bd close fails (lenient)", async () => {
      const opts = makeOpts({ strict: false });
      const client = makeMockClient({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeFailingBdRunner();
      const result = await reconcileOne("task-abc", opts, client, REPO_REF, bdRun);
      expect(result.status).toBe("bd_error");
      expect(result.message).toContain("FAILED to close");
    });

    it("returns 'bd_error' when bd close fails (strict)", async () => {
      const opts = makeOpts({ strict: true });
      const client = makeMockClient({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeFailingBdRunner();
      const result = await reconcileOne("task-abc", opts, client, REPO_REF, bdRun);
      expect(result.status).toBe("bd_error");
      expect(result.message).toContain("bd close failed");
    });

    it("calls bd close with the correct task-id", async () => {
      const opts = makeOpts();
      const client = makeMockClient({ "task-abc": MOCK_MERGED_PR });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      await reconcileOne("task-abc", opts, client, REPO_REF, bdRun);
      expect(closed).toEqual(["task-abc"]);
    });
  });

  describe("reconcile", () => {
    it("processes multiple task-ids", async () => {
      const opts = makeOpts();
      const client = makeMockClient({
        "task-a": MOCK_MERGED_PR,
        "task-b": EMPTY_PR_LIST,
        "task-c": MOCK_MERGED_PR,
      });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = await reconcile(["task-a", "task-b", "task-c"], opts, client, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(3);
      expect(result.items[0].status).toBe("closed");
      expect(result.items[1].status).toBe("no_merged_pr");
      expect(result.items[2].status).toBe("closed");
      expect(closed).toEqual(["task-a", "task-c"]);
    });

    it("returns gh_missing for all items when gh is unavailable (lenient)", async () => {
      const opts = makeOpts({ strict: false });
      const bdRun = makeSuccessBdRunner();
      const result = await withoutGitHubCredentials(async () =>
        reconcile(["task-a", "task-b"], opts, undefined, bdRun),
      );

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_missing");
      expect(result.items[1].status).toBe("gh_missing");
      expect(result.items[0].message).toContain("GitHub client unavailable");
    });

    it("returns gh_missing and fails when gh is unavailable (strict)", async () => {
      const opts = makeOpts({ strict: true });
      const bdRun = makeSuccessBdRunner();
      const result = await withoutGitHubCredentials(async () =>
        reconcile(["task-a", "task-b"], opts, undefined, bdRun),
      );

      expect(result.success).toBe(false);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_missing");
      expect(result.items[0].message).toContain("GitHub client initialization failed");
    });

    it("stops processing on first error in strict mode (gh_error)", async () => {
      const opts = makeOpts({ strict: true });
      const client = makeFailingClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcile(["task-a", "task-b", "task-c"], opts, client, bdRun);

      expect(result.success).toBe(false);
      // Should stop after first failure
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("gh_error");
    });

    it("stops processing on first error in strict mode (bd_error)", async () => {
      const opts = makeOpts({ strict: true });
      const client = makeMockClient({
        "task-a": MOCK_MERGED_PR,
        "task-b": MOCK_MERGED_PR,
      });
      const bdRun = makeFailingBdRunner();
      const result = await reconcile(["task-a", "task-b"], opts, client, bdRun);

      expect(result.success).toBe(false);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("bd_error");
    });

    it("continues processing on errors in lenient mode", async () => {
      const opts = makeOpts({ strict: false });
      // task-a fails gh, task-b has merged PR
      const callCount = { gh: 0 };
      const client: GitHubClient = {
        ...makeMockClient(),
        async listMergedPrs() {
          callCount.gh++;
          if (callCount.gh === 1) {
            throw new Error("transient gh failure");
          }
          return MOCK_MERGED_PR;
        },
      };
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = await reconcile(["task-a", "task-b"], opts, client, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_error");
      expect(result.items[1].status).toBe("closed");
      expect(closed).toEqual(["task-b"]);
    });

    it("handles dry-run mode for multiple task-ids", async () => {
      const opts = makeOpts({ dryRun: true });
      const client = makeMockClient({
        "task-a": MOCK_MERGED_PR,
        "task-b": MOCK_MERGED_PR,
      });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = await reconcile(["task-a", "task-b"], opts, client, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("dry_run");
      expect(result.items[1].status).toBe("dry_run");
      expect(closed).toEqual([]); // No mutations
    });

    it("handles empty task-id list", async () => {
      const opts = makeOpts();
      const client = makeMockClient();
      const bdRun = makeSuccessBdRunner();
      const result = await reconcile([], opts, client, bdRun);

      expect(result.items).toHaveLength(0);
      expect(result.success).toBe(true);
    });

    it("sanitizes multi-line error messages from gh", async () => {
      const opts = makeOpts({ strict: false });
      const client: GitHubClient = {
        ...makeMockClient(),
        async listMergedPrs() {
          throw new Error("HTTP 500:\n  internal server error\n  request-id: abc123");
        },
      };
      const bdRun = makeSuccessBdRunner();
      const result = await reconcile(["task-a"], opts, client, bdRun);

      expect(result.items[0].status).toBe("gh_error");
      // Error message should be collapsed to single line
      expect(result.items[0].message).not.toContain("\n");
    });
  });
});
