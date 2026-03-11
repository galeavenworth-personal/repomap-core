/**
 * Tests for PR reconciliation logic.
 *
 * These tests verify the core reconciliation logic using mock gh/bd runners,
 * without requiring a real GitHub repository, gh CLI, or bd binary.
 */

import { describe, expect, it } from "vitest";
import {
  type GhRunner,
  type BdRunner,
  type ReconcileOptions,
  type ReconcileItemResult,
  reconcile,
  reconcileOne,
  queryMergedPrs,
  isGhAvailable,
  sanitizeError,
} from "../src/infra/pr-reconcile.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_MERGED_PR = [
  {
    number: 99,
    url: "https://github.com/org/repo/pull/99",
    title: "feat: implement task-abc",
    mergedAt: "2026-03-10T12:00:00Z",
  },
];

const EMPTY_PR_LIST: never[] = [];

function makeOpts(overrides: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return {
    dryRun: false,
    strict: false,
    rootDir: "/fake/repo",
    bdPath: "/fake/repo/.kilocode/tools/bd",
    ...overrides,
  };
}

// ── Mock runner factories ───────────────────────────────────────────────

/** gh runner that returns merged PRs for specific task-ids. */
function makeMockGhRunner(
  mergedMap: Record<string, unknown[]> = {},
): GhRunner {
  return (args: string[]): string => {
    // gh version check
    if (args[0] === "version") return "gh version 2.50.0\n";

    // pr list --state merged --head <taskId> -L 1 --json ...
    if (args[0] === "pr" && args[1] === "list" && args[2] === "--state" && args[3] === "merged") {
      const headIdx = args.indexOf("--head");
      const taskId = headIdx >= 0 ? args[headIdx + 1] : "";
      const prs = mergedMap[taskId] ?? [];
      return JSON.stringify(prs);
    }

    throw new Error(`Unexpected gh args: ${args.join(" ")}`);
  };
}

/** gh runner that simulates gh CLI not being available. */
function makeUnavailableGhRunner(): GhRunner {
  return (): string => {
    throw new Error("gh: command not found");
  };
}

/** gh runner that fails on PR queries but passes version check. */
function makeFailingGhRunner(): GhRunner {
  return (args: string[]): string => {
    if (args[0] === "version") return "gh version 2.50.0\n";
    throw new Error("HTTP 500: internal server error\nfailed to query PRs");
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
    it("returns true when gh version succeeds", () => {
      const run = makeMockGhRunner();
      expect(isGhAvailable(run)).toBe(true);
    });

    it("returns false when gh throws", () => {
      const run = makeUnavailableGhRunner();
      expect(isGhAvailable(run)).toBe(false);
    });
  });

  describe("queryMergedPrs", () => {
    it("returns parsed merged PR array", () => {
      const run = makeMockGhRunner({ "task-abc": MOCK_MERGED_PR });
      const result = queryMergedPrs("task-abc", "/fake/repo", run);
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(99);
      expect(result[0].url).toBe("https://github.com/org/repo/pull/99");
    });

    it("returns empty array when no merged PR", () => {
      const run = makeMockGhRunner({ "task-xyz": EMPTY_PR_LIST });
      const result = queryMergedPrs("task-xyz", "/fake/repo", run);
      expect(result).toEqual([]);
    });

    it("throws when gh command fails", () => {
      const run = makeFailingGhRunner();
      expect(() => queryMergedPrs("task-abc", "/fake/repo", run)).toThrow();
    });
  });

  describe("reconcileOne", () => {
    it("returns 'closed' when merged PR found and bd close succeeds", () => {
      const opts = makeOpts();
      const ghRun = makeMockGhRunner({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeSuccessBdRunner();
      const result = reconcileOne("task-abc", opts, ghRun, bdRun);
      expect(result.status).toBe("closed");
      expect(result.taskId).toBe("task-abc");
      expect(result.message).toContain("closed in Beads");
    });

    it("returns 'no_merged_pr' when no PR found", () => {
      const opts = makeOpts();
      const ghRun = makeMockGhRunner({ "task-none": EMPTY_PR_LIST });
      const bdRun = makeSuccessBdRunner();
      const result = reconcileOne("task-none", opts, ghRun, bdRun);
      expect(result.status).toBe("no_merged_pr");
      expect(result.message).toContain("no merged PR found");
    });

    it("returns 'dry_run' when merged PR found in dry-run mode", () => {
      const opts = makeOpts({ dryRun: true });
      const ghRun = makeMockGhRunner({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeSuccessBdRunner();
      const result = reconcileOne("task-abc", opts, ghRun, bdRun);
      expect(result.status).toBe("dry_run");
      expect(result.message).toContain("dry-run");
      expect(result.message).toContain("would close");
    });

    it("does not call bd close in dry-run mode", () => {
      const opts = makeOpts({ dryRun: true });
      const ghRun = makeMockGhRunner({ "task-abc": MOCK_MERGED_PR });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      reconcileOne("task-abc", opts, ghRun, bdRun);
      expect(closed).toEqual([]);
    });

    it("returns 'gh_error' when gh query fails (lenient)", () => {
      const opts = makeOpts({ strict: false });
      const ghRun = makeFailingGhRunner();
      const bdRun = makeSuccessBdRunner();
      const result = reconcileOne("task-abc", opts, ghRun, bdRun);
      expect(result.status).toBe("gh_error");
      expect(result.message).toContain("reconciliation skipped");
    });

    it("returns 'gh_error' when gh query fails (strict)", () => {
      const opts = makeOpts({ strict: true });
      const ghRun = makeFailingGhRunner();
      const bdRun = makeSuccessBdRunner();
      const result = reconcileOne("task-abc", opts, ghRun, bdRun);
      expect(result.status).toBe("gh_error");
      expect(result.message).toContain("gh query failed");
    });

    it("returns 'bd_error' when bd close fails (lenient)", () => {
      const opts = makeOpts({ strict: false });
      const ghRun = makeMockGhRunner({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeFailingBdRunner();
      const result = reconcileOne("task-abc", opts, ghRun, bdRun);
      expect(result.status).toBe("bd_error");
      expect(result.message).toContain("FAILED to close");
    });

    it("returns 'bd_error' when bd close fails (strict)", () => {
      const opts = makeOpts({ strict: true });
      const ghRun = makeMockGhRunner({ "task-abc": MOCK_MERGED_PR });
      const bdRun = makeFailingBdRunner();
      const result = reconcileOne("task-abc", opts, ghRun, bdRun);
      expect(result.status).toBe("bd_error");
      expect(result.message).toContain("bd close failed");
    });

    it("calls bd close with the correct task-id", () => {
      const opts = makeOpts();
      const ghRun = makeMockGhRunner({ "task-abc": MOCK_MERGED_PR });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      reconcileOne("task-abc", opts, ghRun, bdRun);
      expect(closed).toEqual(["task-abc"]);
    });
  });

  describe("reconcile", () => {
    it("processes multiple task-ids", () => {
      const opts = makeOpts();
      const ghRun = makeMockGhRunner({
        "task-a": MOCK_MERGED_PR,
        "task-b": EMPTY_PR_LIST,
        "task-c": MOCK_MERGED_PR,
      });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = reconcile(["task-a", "task-b", "task-c"], opts, ghRun, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(3);
      expect(result.items[0].status).toBe("closed");
      expect(result.items[1].status).toBe("no_merged_pr");
      expect(result.items[2].status).toBe("closed");
      expect(closed).toEqual(["task-a", "task-c"]);
    });

    it("returns gh_missing for all items when gh is unavailable (lenient)", () => {
      const opts = makeOpts({ strict: false });
      const ghRun = makeUnavailableGhRunner();
      const bdRun = makeSuccessBdRunner();
      const result = reconcile(["task-a", "task-b"], opts, ghRun, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_missing");
      expect(result.items[1].status).toBe("gh_missing");
      expect(result.items[0].message).toContain("gh missing");
    });

    it("returns gh_missing and fails when gh is unavailable (strict)", () => {
      const opts = makeOpts({ strict: true });
      const ghRun = makeUnavailableGhRunner();
      const bdRun = makeSuccessBdRunner();
      const result = reconcile(["task-a", "task-b"], opts, ghRun, bdRun);

      expect(result.success).toBe(false);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_missing");
      expect(result.items[0].message).toContain("gh CLI not found");
    });

    it("stops processing on first error in strict mode (gh_error)", () => {
      const opts = makeOpts({ strict: true });
      const ghRun = makeFailingGhRunner();
      const bdRun = makeSuccessBdRunner();
      const result = reconcile(["task-a", "task-b", "task-c"], opts, ghRun, bdRun);

      expect(result.success).toBe(false);
      // Should stop after first failure
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("gh_error");
    });

    it("stops processing on first error in strict mode (bd_error)", () => {
      const opts = makeOpts({ strict: true });
      const ghRun = makeMockGhRunner({
        "task-a": MOCK_MERGED_PR,
        "task-b": MOCK_MERGED_PR,
      });
      const bdRun = makeFailingBdRunner();
      const result = reconcile(["task-a", "task-b"], opts, ghRun, bdRun);

      expect(result.success).toBe(false);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe("bd_error");
    });

    it("continues processing on errors in lenient mode", () => {
      const opts = makeOpts({ strict: false });
      // task-a fails gh, task-b has merged PR
      const callCount = { gh: 0 };
      const ghRun: GhRunner = (args: string[]): string => {
        if (args[0] === "version") return "gh version 2.50.0\n";
        callCount.gh++;
        if (callCount.gh === 1) throw new Error("transient gh failure");
        return JSON.stringify(MOCK_MERGED_PR);
      };
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = reconcile(["task-a", "task-b"], opts, ghRun, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("gh_error");
      expect(result.items[1].status).toBe("closed");
      expect(closed).toEqual(["task-b"]);
    });

    it("handles dry-run mode for multiple task-ids", () => {
      const opts = makeOpts({ dryRun: true });
      const ghRun = makeMockGhRunner({
        "task-a": MOCK_MERGED_PR,
        "task-b": MOCK_MERGED_PR,
      });
      const { runner: bdRun, closed } = makeTrackingBdRunner();
      const result = reconcile(["task-a", "task-b"], opts, ghRun, bdRun);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].status).toBe("dry_run");
      expect(result.items[1].status).toBe("dry_run");
      expect(closed).toEqual([]); // No mutations
    });

    it("handles empty task-id list", () => {
      const opts = makeOpts();
      const ghRun = makeMockGhRunner();
      const bdRun = makeSuccessBdRunner();
      const result = reconcile([], opts, ghRun, bdRun);

      // gh availability check will fail since no tasks trigger the version check to match
      // Actually, isGhAvailable is called first with the runner
      expect(result.items).toHaveLength(0);
      expect(result.success).toBe(true);
    });

    it("sanitizes multi-line error messages from gh", () => {
      const opts = makeOpts({ strict: false });
      const ghRun: GhRunner = (args: string[]): string => {
        if (args[0] === "version") return "gh version 2.50.0\n";
        throw new Error("HTTP 500:\n  internal server error\n  request-id: abc123");
      };
      const bdRun = makeSuccessBdRunner();
      const result = reconcile(["task-a"], opts, ghRun, bdRun);

      expect(result.items[0].status).toBe("gh_error");
      // Error message should be collapsed to single line
      expect(result.items[0].message).not.toContain("\n");
    });
  });
});
