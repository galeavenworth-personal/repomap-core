import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoopDetection } from "../src/governor/types.js";
import type { DoltWriter } from "../src/writer/index.js";

// ── Mock SDK ──

const abortMock = vi.hoisted(() => vi.fn());

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: () => ({
    session: {
      abort: abortMock,
    },
  }),
}));

import { killSession } from "../src/governor/session-killer.js";
import type { SessionKillerDeps } from "../src/governor/session-killer.js";

// ── Helpers ──

function makeDetection(overrides: Partial<LoopDetection> = {}): LoopDetection {
  return {
    sessionId: "test-session-abc",
    classification: "cost_overflow",
    reason: "Cost $2.50 exceeds $2.00 budget",
    metrics: {
      stepCount: 45,
      totalCost: 2.5,
      toolCalls: 120,
      recentTools: ["readFile", "editFile", "readFile"],
      uniqueSourceHashes: 8,
      elapsedMs: 90_000,
    },
    detectedAt: new Date("2026-02-24T00:00:00Z"),
    ...overrides,
  };
}

function makeMockWriter(): DoltWriter & {
  writePunchCalls: Array<Record<string, unknown>>;
  writeChildCalls: Array<[string, string]>;
} {
  const writePunchCalls: Array<Record<string, unknown>> = [];
  const writeChildCalls: Array<[string, string]> = [];

  return {
    writePunchCalls,
    writeChildCalls,
    async connect() {},
    async writePunch(punch) {
      writePunchCalls.push(punch as unknown as Record<string, unknown>);
    },
    async writeChildRelation(parentId, childId) {
      writeChildCalls.push([parentId, childId]);
    },
    async disconnect() {},
  };
}

const defaultConfig = { kiloHost: "localhost", kiloPort: 4096 };

// ═══════════════════════════════════════════════════════════════════════════════
// Kill Confirmation Tests (7xo.5 scenario 4)
// ═══════════════════════════════════════════════════════════════════════════════

describe("killSession — kill confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts session and records governor_kill punch in Dolt", async () => {
    abortMock.mockResolvedValue({ data: {}, error: null });
    const writer = makeMockWriter();
    const detection = makeDetection();

    const result = await killSession(
      { config: defaultConfig, writer },
      detection
    );

    // Verify SDK abort was called with correct session ID
    expect(abortMock).toHaveBeenCalledOnce();
    expect(abortMock).toHaveBeenCalledWith({
      path: { id: "test-session-abc" },
    });

    // Verify kill punch was written to Dolt
    expect(writer.writePunchCalls).toHaveLength(1);
    const punch = writer.writePunchCalls[0];
    expect(punch.taskId).toBe("test-session-abc");
    expect(punch.punchType).toBe("governor_kill");
    expect(punch.punchKey).toBe("cost_overflow");
    expect(punch.cost).toBe(2.5);
    expect(punch.observedAt).toBeInstanceOf(Date);
    // sourceHash should be a deterministic SHA-256 hex string
    expect(punch.sourceHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify KillConfirmation shape
    expect(result.sessionId).toBe("test-session-abc");
    expect(result.killedAt).toBeInstanceOf(Date);
    expect(result.trigger.classification).toBe("cost_overflow");
    expect(result.trigger.reason).toBe("Cost $2.50 exceeds $2.00 budget");
    expect(result.finalMetrics.totalCost).toBe(2.5);
    expect(result.finalMetrics.stepCount).toBe(45);
  });

  it("sourceHash is deterministic for same detection input", async () => {
    abortMock.mockResolvedValue({ data: {}, error: null });
    const writer1 = makeMockWriter();
    const writer2 = makeMockWriter();
    const detection = makeDetection();

    await killSession({ config: defaultConfig, writer: writer1 }, detection);
    await killSession({ config: defaultConfig, writer: writer2 }, detection);

    expect(writer1.writePunchCalls[0].sourceHash).toBe(
      writer2.writePunchCalls[0].sourceHash
    );
  });

  it("treats 404 as already-dead session (idempotent)", async () => {
    abortMock.mockResolvedValue({
      data: null,
      error: { status: 404, message: "Not Found" },
    });
    const writer = makeMockWriter();
    const detection = makeDetection();

    const result = await killSession(
      { config: defaultConfig, writer },
      detection
    );

    // Should still succeed — no throw
    expect(result.sessionId).toBe("test-session-abc");
    // Reason should note it was already terminated
    expect(result.trigger.reason).toContain("already terminated");
    // Kill punch should still be recorded
    expect(writer.writePunchCalls).toHaveLength(1);
  });

  it("treats network error containing '404' as already-dead", async () => {
    abortMock.mockRejectedValue(new Error("fetch failed: 404 not found"));
    const writer = makeMockWriter();
    const detection = makeDetection();

    const result = await killSession(
      { config: defaultConfig, writer },
      detection
    );

    expect(result.sessionId).toBe("test-session-abc");
    expect(result.trigger.reason).toContain("already terminated");
    expect(writer.writePunchCalls).toHaveLength(1);
  });

  it("rethrows non-404 errors from abort", async () => {
    abortMock.mockRejectedValue(new Error("Connection refused"));
    const writer = makeMockWriter();
    const detection = makeDetection();

    await expect(
      killSession({ config: defaultConfig, writer }, detection)
    ).rejects.toThrow("Connection refused");

    // No punch should be written since kill didn't succeed
    expect(writer.writePunchCalls).toHaveLength(0);
  });

  it("still returns confirmation if writer.writePunch fails", async () => {
    abortMock.mockResolvedValue({ data: {}, error: null });

    const failingWriter: DoltWriter = {
      async connect() {},
      async writePunch() {
        throw new Error("Dolt connection lost");
      },
      async writeChildRelation() {},
      async disconnect() {},
    };

    const detection = makeDetection();
    const result = await killSession(
      { config: defaultConfig, writer: failingWriter },
      detection
    );

    // Kill succeeded even though punch write failed
    expect(result.sessionId).toBe("test-session-abc");
    expect(result.trigger.classification).toBe("cost_overflow");
  });

  it("works without a writer (no Dolt configured)", async () => {
    abortMock.mockResolvedValue({ data: {}, error: null });
    const detection = makeDetection();

    const result = await killSession(
      { config: defaultConfig },
      detection
    );

    expect(result.sessionId).toBe("test-session-abc");
    expect(result.trigger.reason).toBe("Cost $2.50 exceeds $2.00 budget");
  });

  it("records different classifications correctly", async () => {
    abortMock.mockResolvedValue({ data: {}, error: null });

    for (const classification of [
      "step_overflow",
      "cost_overflow",
      "tool_cycle",
      "cache_plateau",
    ] as const) {
      const writer = makeMockWriter();
      const detection = makeDetection({
        classification,
        reason: `Detected ${classification}`,
      });

      const result = await killSession(
        { config: defaultConfig, writer },
        detection
      );

      expect(result.trigger.classification).toBe(classification);
      expect(writer.writePunchCalls[0].punchKey).toBe(classification);
    }
  });
});
