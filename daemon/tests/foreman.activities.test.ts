/**
 * Foreman Activities Tests
 *
 * Unit tests for the Beads CLI activity wrappers. All tests mock the bd CLI
 * execution via vi.mock of node:child_process, so no real bd binary is needed.
 *
 * Test organization:
 *   1. execBd — CLI execution helper
 *   2. parseBdJson — JSON parsing with error classification
 *   3. selectNextBead — bead selection, filtering, sorting
 *   4. getBeadDetail — bead detail fetch and validation
 *   5. updateBeadStatus — status transitions
 *   6. closeBead — bead closure
 *   7. Error classification — transient vs contract errors
 */

import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

// Mock @temporalio/activity before importing activities
vi.mock("@temporalio/activity", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  heartbeat: vi.fn(),
}));

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock mysql2/promise for Dolt health check
vi.mock("mysql2/promise", () => ({
  createConnection: vi.fn(),
}));

import { execFile } from "node:child_process";
import { createConnection } from "mysql2/promise";
import {
  execBd,
  parseBdJson,
  selectNextBead,
  getBeadDetail,
  updateBeadStatus,
  closeBead,
  checkStackHealth,
  BeadsTransientError,
  BeadsContractError,
} from "../src/temporal/foreman.activities.js";
import type {
  SelectNextBeadInput,
  CloseBeadInput,
  CheckStackHealthInput,
} from "../src/temporal/foreman.types.js";

// ── Test helpers ──

const REPO_PATH = "/fake/repo";

/**
 * Configure the mocked execFile to call the callback with given results.
 */
function mockExecFileSuccess(stdout: string, stderr = "") {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(
    ((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(null, stdout, stderr);
    }) as typeof execFile,
  );
}

function mockExecFileFailure(
  exitCode: number,
  stderr: string,
  stdout = "",
) {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(
    ((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const error = new Error(`Command failed with exit code ${exitCode}`) as Error & {
        code: number;
        killed: boolean;
      };
      error.code = exitCode;
      error.killed = false;
      callback(error, stdout, stderr);
    }) as typeof execFile,
  );
}

function mockExecFileTimeout() {
  const mock = vi.mocked(execFile);
  mock.mockImplementation(
    ((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const callback = cb as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const error = new Error("timed out") as Error & {
        killed: boolean;
        code: string;
      };
      error.killed = true;
      error.code = "ETIMEDOUT";
      callback(error, "", "");
    }) as typeof execFile,
  );
}

// ── Fixtures ──

function makeBdReadyOutput(
  items: Array<{
    id: string;
    title: string;
    priority?: string;
    labels?: string[];
    depends_on?: string[];
    estimated_complexity?: string;
  }>,
): string {
  return JSON.stringify(items);
}

function makeBdShowOutput(item: {
  id: string;
  title: string;
  priority?: string;
  labels?: string[];
  depends_on?: string[];
  description?: string;
  estimated_complexity?: string;
  status?: string;
}): string {
  return JSON.stringify(item);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. execBd ──

describe("execBd", () => {
  it("resolves with stdout/stderr/exitCode on success", async () => {
    mockExecFileSuccess("hello world\n", "some warning");
    const result = await execBd(REPO_PATH, ["ready", "--json"]);
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("some warning");
    expect(result.exitCode).toBe(0);
  });

  it("calls execFile with correct bd path and cwd", async () => {
    mockExecFileSuccess("[]");
    await execBd(REPO_PATH, ["ready", "--json"]);

    const mock = vi.mocked(execFile);
    expect(mock).toHaveBeenCalledOnce();
    const [file, args, opts] = mock.mock.calls[0] as [
      string,
      string[],
      { cwd: string },
    ];
    expect(file).toContain(".kilocode/tools/bd");
    expect(args).toEqual(["ready", "--json"]);
    expect(opts.cwd).toBe(REPO_PATH);
  });

  it("throws BeadsTransientError on non-zero exit", async () => {
    mockExecFileFailure(1, "bd: database not available");
    await expect(execBd(REPO_PATH, ["ready", "--json"])).rejects.toThrow(
      BeadsTransientError,
    );
  });

  it("throws BeadsTransientError with exit code info on failure", async () => {
    mockExecFileFailure(2, "connection refused");
    try {
      await execBd(REPO_PATH, ["ready", "--json"]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BeadsTransientError);
      const err = e as BeadsTransientError;
      expect(err.exitCode).toBe(2);
      expect(err.stderr).toBe("connection refused");
      expect(err.retryable).toBe(true);
    }
  });

  it("throws BeadsTransientError on timeout", async () => {
    mockExecFileTimeout();
    try {
      await execBd(REPO_PATH, ["ready", "--json"]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BeadsTransientError);
      const err = e as BeadsTransientError;
      expect(err.exitCode).toBeNull();
      expect(err.message).toContain("timed out");
    }
  });
});

// ── 2. parseBdJson ──

describe("parseBdJson", () => {
  it("parses valid JSON", () => {
    const result = parseBdJson<{ foo: number }>('{"foo": 42}', "test");
    expect(result).toEqual({ foo: 42 });
  });

  it("parses JSON with surrounding whitespace", () => {
    const result = parseBdJson<number[]>("  [1, 2, 3]  \n", "test");
    expect(result).toEqual([1, 2, 3]);
  });

  it("throws BeadsContractError on empty output", () => {
    expect(() => parseBdJson("", "test")).toThrow(BeadsContractError);
    expect(() => parseBdJson("  \n  ", "test")).toThrow(BeadsContractError);
  });

  it("throws BeadsContractError on invalid JSON", () => {
    expect(() => parseBdJson("not json at all", "test")).toThrow(
      BeadsContractError,
    );
  });

  it("BeadsContractError includes raw output", () => {
    try {
      parseBdJson("broken{", "test");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BeadsContractError);
      const err = e as BeadsContractError;
      expect(err.rawOutput).toBe("broken{");
      expect(err.retryable).toBe(false);
    }
  });
});

// ── 3. selectNextBead ──

describe("selectNextBead", () => {
  const baseInput: SelectNextBeadInput = {
    repoPath: REPO_PATH,
    retryLedger: [],
    skipList: [],
  };

  it("returns null when no beads are ready", async () => {
    mockExecFileSuccess("[]");
    const result = await selectNextBead(baseInput);
    expect(result).toBeNull();
  });

  it("returns the only available bead", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-1", title: "Fix bug", priority: "P1" },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead(baseInput);
    expect(result).not.toBeNull();
    expect(result!.beadId).toBe("bead-1");
    expect(result!.title).toBe("Fix bug");
    expect(result!.priority).toBe("P1");
  });

  it("selects highest-priority bead", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-low", title: "Low pri", priority: "P3" },
      { id: "bead-high", title: "High pri", priority: "P0" },
      { id: "bead-mid", title: "Mid pri", priority: "P1" },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead(baseInput);
    expect(result!.beadId).toBe("bead-high");
  });

  it("filters out beads in skipList", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-skip", title: "Skip me", priority: "P0" },
      { id: "bead-keep", title: "Keep me", priority: "P2" },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead({
      ...baseInput,
      skipList: ["bead-skip"],
    });
    expect(result!.beadId).toBe("bead-keep");
  });

  it("filters out beads with exhausted retries", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-exhausted", title: "Exhausted", priority: "P0" },
      { id: "bead-ok", title: "OK", priority: "P2" },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead({
      ...baseInput,
      retryLedger: [
        {
          beadId: "bead-exhausted",
          attempts: 3,
          maxAttempts: 3,
          lastAttemptAt: new Date().toISOString(),
          lastError: "failed",
          lastResult: { kind: "failed", error: "failed", retryable: false },
          nextRetryAfter: new Date().toISOString(),
          exhausted: true,
        },
      ],
    });
    expect(result!.beadId).toBe("bead-ok");
  });

  it("defers beads whose nextRetryAfter is in the future", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-backoff", title: "Backoff", priority: "P0" },
      { id: "bead-ok", title: "OK", priority: "P1" },
    ]);
    mockExecFileSuccess(output);

    const futureRetry = new Date(Date.now() + 60_000).toISOString();

    const result = await selectNextBead({
      ...baseInput,
      retryLedger: [
        {
          beadId: "bead-backoff",
          attempts: 1,
          maxAttempts: 3,
          lastAttemptAt: new Date().toISOString(),
          lastError: "temporary-failure",
          lastResult: { kind: "failed", error: "temporary-failure", retryable: true },
          nextRetryAfter: futureRetry,
          exhausted: false,
        },
      ],
    });

    expect(result!.beadId).toBe("bead-ok");
  });

  it("selects beads whose nextRetryAfter has passed", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-ready-again", title: "Ready Again", priority: "P0" },
      { id: "bead-lower", title: "Lower priority", priority: "P1" },
    ]);
    mockExecFileSuccess(output);

    const pastRetry = new Date(Date.now() - 60_000).toISOString();

    const result = await selectNextBead({
      ...baseInput,
      retryLedger: [
        {
          beadId: "bead-ready-again",
          attempts: 1,
          maxAttempts: 3,
          lastAttemptAt: new Date().toISOString(),
          lastError: "temporary-failure",
          lastResult: { kind: "failed", error: "temporary-failure", retryable: true },
          nextRetryAfter: pastRetry,
          exhausted: false,
        },
      ],
    });

    expect(result!.beadId).toBe("bead-ready-again");
  });

  it("returns null when all beads are filtered out", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-1", title: "Skip", priority: "P0" },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead({
      ...baseInput,
      skipList: ["bead-1"],
    });
    expect(result).toBeNull();
  });

  it("defaults priority to P3 for unknown priority values", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-1", title: "Unknown pri", priority: "urgent" },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead(baseInput);
    expect(result!.priority).toBe("P3");
  });

  it("defaults estimatedComplexity to unknown for invalid values", async () => {
    const output = makeBdReadyOutput([
      { id: "bead-1", title: "Test", estimated_complexity: "huge" },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead(baseInput);
    expect(result!.estimatedComplexity).toBe("unknown");
  });

  it("populates labels and dependsOn from bd output", async () => {
    const output = makeBdReadyOutput([
      {
        id: "bead-1",
        title: "Rich bead",
        priority: "P1",
        labels: ["feature", "frontend"],
        depends_on: ["bead-0"],
        estimated_complexity: "medium",
      },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead(baseInput);
    expect(result!.labels).toEqual(["feature", "frontend"]);
    expect(result!.dependsOn).toEqual(["bead-0"]);
    expect(result!.estimatedComplexity).toBe("medium");
  });

  it("skips items with missing id or title", async () => {
    const output = JSON.stringify([
      { title: "No ID" },
      { id: "bead-2" },
      { id: "bead-3", title: "Good" },
    ]);
    mockExecFileSuccess(output);

    const result = await selectNextBead(baseInput);
    expect(result!.beadId).toBe("bead-3");
  });

  it("throws BeadsContractError when output is not an array", async () => {
    mockExecFileSuccess('{"id": "not-an-array"}');
    await expect(selectNextBead(baseInput)).rejects.toThrow(
      BeadsContractError,
    );
  });

  it("throws BeadsTransientError when bd CLI fails", async () => {
    mockExecFileFailure(1, "database not running");
    await expect(selectNextBead(baseInput)).rejects.toThrow(
      BeadsTransientError,
    );
  });
});

// ── 4. getBeadDetail ──

describe("getBeadDetail", () => {
  it("returns structured detail for a valid bead", async () => {
    const output = makeBdShowOutput({
      id: "bead-42",
      title: "Implement foreman",
      priority: "P1",
      labels: ["epic:foreman"],
      depends_on: ["bead-10"],
      description: "Implement the foreman control loop",
      estimated_complexity: "large",
      status: "ready",
    });
    mockExecFileSuccess(output);

    const detail = await getBeadDetail(REPO_PATH, "bead-42");
    expect(detail.beadId).toBe("bead-42");
    expect(detail.title).toBe("Implement foreman");
    expect(detail.priority).toBe("P1");
    expect(detail.labels).toEqual(["epic:foreman"]);
    expect(detail.dependsOn).toEqual(["bead-10"]);
    expect(detail.description).toBe("Implement the foreman control loop");
    expect(detail.estimatedComplexity).toBe("large");
    expect(detail.status).toBe("ready");
  });

  it("defaults missing optional fields", async () => {
    const output = makeBdShowOutput({
      id: "bead-minimal",
      title: "Minimal bead",
    });
    mockExecFileSuccess(output);

    const detail = await getBeadDetail(REPO_PATH, "bead-minimal");
    expect(detail.beadId).toBe("bead-minimal");
    expect(detail.labels).toEqual([]);
    expect(detail.dependsOn).toEqual([]);
    expect(detail.description).toBe("");
    expect(detail.estimatedComplexity).toBe("unknown");
    expect(detail.status).toBe("unknown");
    expect(detail.priority).toBe("P3");
  });

  it("throws BeadsContractError when id is missing", async () => {
    mockExecFileSuccess(JSON.stringify({ title: "No ID" }));
    await expect(getBeadDetail(REPO_PATH, "bead-x")).rejects.toThrow(
      BeadsContractError,
    );
  });

  it("throws BeadsContractError when output is not an object", async () => {
    mockExecFileSuccess('"just a string"');
    await expect(getBeadDetail(REPO_PATH, "bead-x")).rejects.toThrow(
      BeadsContractError,
    );
  });

  it("throws BeadsTransientError when bd CLI fails", async () => {
    mockExecFileFailure(1, "bead not found");
    await expect(getBeadDetail(REPO_PATH, "bead-x")).rejects.toThrow(
      BeadsTransientError,
    );
  });
});

// ── 5. updateBeadStatus ──

describe("updateBeadStatus", () => {
  it("returns updated=true on success", async () => {
    mockExecFileSuccess("Status updated\n");
    const result = await updateBeadStatus(REPO_PATH, "bead-1", "in_progress");
    expect(result.updated).toBe(true);
    expect(result.error).toBeNull();
  });

  it("passes correct args to bd", async () => {
    mockExecFileSuccess("");
    await updateBeadStatus(REPO_PATH, "bead-42", "in_progress");

    const mock = vi.mocked(execFile);
    const [, args] = mock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(["update", "bead-42", "--status", "in_progress"]);
  });

  it("throws BeadsTransientError on CLI failure (for Temporal retry)", async () => {
    mockExecFileFailure(1, "db locked");
    await expect(
      updateBeadStatus(REPO_PATH, "bead-1", "in_progress"),
    ).rejects.toThrow(BeadsTransientError);
  });

  it("wraps non-transient errors as BeadsTransientError for retry safety", async () => {
    // Simulate an unexpected error type (not BeadsTransientError)
    vi.mocked(execFile).mockImplementation(
      ((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        throw new TypeError("unexpected internal error");
      }) as typeof execFile,
    );

    await expect(
      updateBeadStatus(REPO_PATH, "bead-1", "in_progress"),
    ).rejects.toThrow(BeadsTransientError);

    try {
      await updateBeadStatus(REPO_PATH, "bead-1", "in_progress");
    } catch (e) {
      expect(e).toBeInstanceOf(BeadsTransientError);
      expect((e as BeadsTransientError).exitCode).toBeNull();
    }
  });
});

// ── 6. closeBead ──

describe("closeBead", () => {
  const baseInput: CloseBeadInput = {
    repoPath: REPO_PATH,
    beadId: "bead-done",
    outcome: {
      beadId: "bead-done",
      workflowId: "wf-1",
      sessionId: "sess-1",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 5000,
      totalCost: 0.5,
      tokensInput: 1000,
      tokensOutput: 500,
      result: { kind: "completed" },
      audit: null,
      attempt: 1,
    },
  };

  it("returns closed=true on success", async () => {
    mockExecFileSuccess("Closed bead-done\n");
    const result = await closeBead(baseInput);
    expect(result.closed).toBe(true);
    expect(result.error).toBeNull();
  });

  it("passes correct args to bd", async () => {
    mockExecFileSuccess("");
    await closeBead(baseInput);

    const mock = vi.mocked(execFile);
    const [, args] = mock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(["close", "bead-done"]);
  });

  it("throws BeadsTransientError on CLI failure (for Temporal retry)", async () => {
    mockExecFileFailure(1, "cannot close");
    await expect(closeBead(baseInput)).rejects.toThrow(BeadsTransientError);
  });
});

// ── 7. Error classification ──

describe("error classification", () => {
  it("BeadsTransientError is retryable", () => {
    const err = new BeadsTransientError("test", 1, "stderr");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("BeadsTransientError");
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe("stderr");
  });

  it("BeadsContractError is not retryable", () => {
    const err = new BeadsContractError("test", "raw output");
    expect(err.retryable).toBe(false);
    expect(err.name).toBe("BeadsContractError");
    expect(err.rawOutput).toBe("raw output");
  });

  it("both error types extend Error", () => {
    expect(new BeadsTransientError("t", 1, "")).toBeInstanceOf(Error);
    expect(new BeadsContractError("c", "")).toBeInstanceOf(Error);
  });
});

// ── 8. checkStackHealth ──

// Helper: mock fetch globally
function mockFetchSuccess(status = 200, statusText = "OK") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText,
    }),
  );
}

function mockFetchFailure(errorMessage = "Connection refused") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error(errorMessage)),
  );
}

// Helper: mock mysql2/promise createConnection for Dolt health check
function mockMysqlSuccess() {
  const mockConn = {
    query: vi.fn().mockResolvedValue([[], []]),
    end: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(createConnection).mockResolvedValue(mockConn as any);
}

function mockMysqlFailure(errorMessage = "ECONNREFUSED") {
  vi.mocked(createConnection).mockRejectedValue(new Error(errorMessage));
}

// Helper: mock execFile for git and bd checks
// The mock needs to handle multiple sequential calls (git status + bd ready)
function mockExecFileSequence(
  calls: Array<{
    stdout: string;
    stderr?: string;
    error?: Error | null;
  }>,
) {
  const mock = vi.mocked(execFile);
  let callIndex = 0;
  mock.mockImplementation(
    ((_file: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      const call = calls[callIndex] ?? calls.at(-1);
      callIndex++;
      const callback = cb as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      if (call.error) {
        callback(call.error, "", call.stderr ?? "");
      } else {
        callback(null, call.stdout, call.stderr ?? "");
      }
    }) as typeof execFile,
  );
}

describe("checkStackHealth", () => {
  const baseInput: CheckStackHealthInput = {
    repoPath: REPO_PATH,
    doltHost: "127.0.0.1",
    doltPort: 3307,
    doltDatabase: "beads_test",
    kiloHost: "127.0.0.1",
    kiloPort: 4096,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 'pass' when all subsystems are healthy", async () => {
    mockFetchSuccess();
    mockMysqlSuccess();
    // execFile is called for: git status (clean) and bd ready (valid JSON array)
    mockExecFileSequence([
      { stdout: "" },              // git status --porcelain: clean
      { stdout: '[{"id":"b1"}]' }, // bd ready --json: valid
    ]);

    const result = await checkStackHealth(baseInput);

    expect(result.overall).toBe("pass");
    expect(result.subsystems.kiloServe.status).toBe("up");
    expect(result.subsystems.dolt.status).toBe("up");
    expect(result.subsystems.git.status).toBe("up");
    expect(result.subsystems.temporal.status).toBe("up");
    expect(result.subsystems.beads.status).toBe("up");
    expect(result.checkedAt).toBeTruthy();
  });

  it("returns 'fail' when kilo serve is down", async () => {
    mockFetchFailure("Connection refused");
    mockMysqlSuccess();
    mockExecFileSequence([
      { stdout: "" },
      { stdout: "[]" },
    ]);

    const result = await checkStackHealth(baseInput);

    expect(result.overall).toBe("fail");
    expect(result.subsystems.kiloServe.status).toBe("down");
    expect(result.subsystems.kiloServe.message).toContain("unreachable");
  });

  it("returns 'fail' when Dolt is down", async () => {
    mockFetchSuccess();
    mockMysqlFailure("ECONNREFUSED");
    mockExecFileSequence([
      { stdout: "" },
      { stdout: "[]" },
    ]);

    const result = await checkStackHealth(baseInput);

    expect(result.overall).toBe("fail");
    expect(result.subsystems.dolt.status).toBe("down");
    expect(result.subsystems.dolt.message).toContain("ECONNREFUSED");
  });

  it("returns 'fail' when git has merge conflicts", async () => {
    mockFetchSuccess();
    mockMysqlSuccess();
    mockExecFileSequence([
      { stdout: "UU conflicted-file.ts\n" }, // merge conflict
      { stdout: "[]" },
    ]);

    const result = await checkStackHealth(baseInput);

    expect(result.overall).toBe("fail");
    expect(result.subsystems.git.status).toBe("down");
    expect(result.subsystems.git.message).toContain("merge conflicts");
  });

  it("returns 'degraded' with git uncommitted changes (not conflicts)", async () => {
    mockFetchSuccess();
    mockMysqlSuccess();
    mockExecFileSequence([
      { stdout: " M src/changed.ts\n" }, // modified file, no conflict
      { stdout: "[]" },
    ]);

    const result = await checkStackHealth(baseInput);

    // git is "degraded" per health gate contract, overall is "degraded"
    expect(result.subsystems.git.status).toBe("degraded");
    expect(result.subsystems.git.message).toContain("uncommitted changes");
    expect(result.overall).toBe("degraded");
  });

  it("returns 'fail' when beads CLI fails", async () => {
    mockFetchSuccess();
    mockMysqlSuccess();

    // git succeeds, then bd fails
    const gitError = null;
    const bdError = new Error("bd: database not available") as Error & {
      code: number;
      killed: boolean;
    };
    bdError.code = 1;
    bdError.killed = false;

    mockExecFileSequence([
      { stdout: "" },                                          // git: clean
      { stdout: "", stderr: "database not available", error: bdError }, // bd: fails
    ]);

    const result = await checkStackHealth(baseInput);

    expect(result.overall).toBe("fail");
    expect(result.subsystems.beads.status).toBe("down");
  });

  it("temporal is always 'up' (implicit check)", async () => {
    mockFetchSuccess();
    mockMysqlSuccess();
    mockExecFileSequence([
      { stdout: "" },
      { stdout: "[]" },
    ]);

    const result = await checkStackHealth(baseInput);

    expect(result.subsystems.temporal.status).toBe("up");
    expect(result.subsystems.temporal.message).toContain("implicit");
  });

  it("never throws — returns fail result instead", async () => {
    // All subsystems fail
    mockFetchFailure("ECONNREFUSED");
    mockMysqlFailure("ECONNREFUSED");

    const gitError = new Error("not a git repo") as Error & {
      code: number;
      killed: boolean;
    };
    gitError.code = 128;
    gitError.killed = false;

    const bdError = new Error("bd not found") as Error & {
      code: number;
      killed: boolean;
    };
    bdError.code = 127;
    bdError.killed = false;

    mockExecFileSequence([
      { stdout: "", stderr: "not a git repo", error: gitError },
      { stdout: "", stderr: "bd not found", error: bdError },
    ]);

    // Should NOT throw
    const result = await checkStackHealth(baseInput);

    expect(result.overall).toBe("fail");
    // At minimum kilo, dolt, git, beads are down; temporal is always up
    expect(result.subsystems.kiloServe.status).toBe("down");
    expect(result.subsystems.dolt.status).toBe("down");
    expect(result.subsystems.git.status).toBe("down");
    expect(result.subsystems.temporal.status).toBe("up");
    expect(result.subsystems.beads.status).toBe("down");
  });

  it("returns correct ISO 8601 checkedAt timestamp", async () => {
    mockFetchSuccess();
    mockMysqlSuccess();
    mockExecFileSequence([
      { stdout: "" },
      { stdout: "[]" },
    ]);

    const before = new Date().toISOString();
    const result = await checkStackHealth(baseInput);
    const after = new Date().toISOString();

    expect(result.checkedAt >= before).toBe(true);
    expect(result.checkedAt <= after).toBe(true);
  });

  it("classifies HTTP non-200 as down", async () => {
    mockFetchSuccess(503, "Service Unavailable");
    mockMysqlSuccess();
    mockExecFileSequence([
      { stdout: "" },
      { stdout: "[]" },
    ]);

    const result = await checkStackHealth(baseInput);

    expect(result.subsystems.kiloServe.status).toBe("down");
    expect(result.subsystems.kiloServe.message).toContain("503");
  });

  it("reports latencyMs for successful checks", async () => {
    mockFetchSuccess();
    mockMysqlSuccess();
    mockExecFileSequence([
      { stdout: "" },
      { stdout: "[]" },
    ]);

    const result = await checkStackHealth(baseInput);

    // All successful checks should have latencyMs >= 0
    expect(result.subsystems.kiloServe.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.subsystems.dolt.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.subsystems.git.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.subsystems.temporal.latencyMs).toBe(0);
    expect(result.subsystems.beads.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports null latencyMs for failed checks", async () => {
    mockFetchFailure("ECONNREFUSED");
    mockMysqlFailure("ECONNREFUSED");

    const error = new Error("fail") as Error & { code: number; killed: boolean };
    error.code = 1;
    error.killed = false;

    mockExecFileSequence([
      { stdout: "", error },
      { stdout: "", error },
    ]);

    const result = await checkStackHealth(baseInput);

    expect(result.subsystems.kiloServe.latencyMs).toBeNull();
    expect(result.subsystems.dolt.latencyMs).toBeNull();
    expect(result.subsystems.git.latencyMs).toBeNull();
    expect(result.subsystems.beads.latencyMs).toBeNull();
  });
});
