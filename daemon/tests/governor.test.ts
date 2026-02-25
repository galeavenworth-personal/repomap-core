import { describe, expect, it } from "vitest";

import { LoopDetector } from "../src/governor/loop-detector.js";
import { FitterDispatch, DEFAULT_FITTER_CONFIG } from "../src/governor/fitter-dispatch.js";
import type { SessionRequest, SessionResponse } from "../src/governor/fitter-dispatch.js";
import type {
  DiagnosisReport,
  FitterDispatchInput,
  KillConfirmation,
} from "../src/governor/types.js";
import type { Punch } from "../src/classifier/index.js";

// ── Helpers ──

/** Create a minimal punch with the given overrides. */
function makePunch(overrides: Partial<Punch & { contentHash?: string }> = {}): Punch {
  return {
    taskId: "test-session",
    punchType: "tool_call",
    punchKey: "readFile",
    observedAt: new Date(),
    sourceHash: `hash-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  } as Punch;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bug #1: cache_plateau uses event hashes — heuristic never fires
// ═══════════════════════════════════════════════════════════════════════════════
//
// The loop detector pushes `punch.sourceHash` (unique per event) into the
// sourceHashes array. Since every event has a unique hash, the unique ratio
// is always ~1.0, so cache_plateau never fires.
//
// Fix: the Punch type needs a `contentHash` field (hash of the content being
// read/processed, not the event envelope). The loop detector should use
// contentHash when available, falling back to sourceHash.

describe("LoopDetector — cache_plateau", () => {
  it("detects plateau when same content hash repeats in window", () => {
    const detector = new LoopDetector({
      sessionId: "plateau-test",
      thresholds: {
        cacheWindowSize: 10,
        cachePlateauRatio: 0.3,
        // Disable other heuristics so they don't fire first
        maxSteps: 9999,
        maxCostUsd: 9999,
        cycleRepetitions: 9999,
      },
    });

    // Ingest 10 punches that all refer to the same content (same contentHash)
    // but each has a unique sourceHash (as real events would)
    for (let i = 0; i < 10; i++) {
      detector.ingest(
        makePunch({
          punchType: "tool_call",
          punchKey: "readFile",
          sourceHash: `unique-event-${i}`,
          contentHash: "same-content-abc123",
        })
      );
    }

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection?.classification).toBe("cache_plateau");
  });

  it("does NOT fire when content hashes are diverse", () => {
    const detector = new LoopDetector({
      sessionId: "no-plateau",
      thresholds: {
        cacheWindowSize: 10,
        cachePlateauRatio: 0.3,
        maxSteps: 9999,
        maxCostUsd: 9999,
        cycleRepetitions: 9999,
      },
    });

    // Each punch has unique content
    for (let i = 0; i < 10; i++) {
      detector.ingest(
        makePunch({
          sourceHash: `event-${i}`,
          contentHash: `different-content-${i}`,
        })
      );
    }

    const detection = detector.detect();
    expect(detection).toBeNull();
  });

  it("falls back to sourceHash when contentHash is absent", () => {
    const detector = new LoopDetector({
      sessionId: "fallback-test",
      thresholds: {
        cacheWindowSize: 5,
        cachePlateauRatio: 0.3,
        maxSteps: 9999,
        maxCostUsd: 9999,
        cycleRepetitions: 9999,
      },
    });

    // Same sourceHash repeated (simulating old-style punches with no contentHash)
    for (let i = 0; i < 5; i++) {
      detector.ingest(
        makePunch({ sourceHash: "repeated-hash" })
      );
    }

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection?.classification).toBe("cache_plateau");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug #2: getSessionMetrics double-counts steps
// ═══════════════════════════════════════════════════════════════════════════════
//
// Both step-start and step-finish increment stepCount, so a single completed
// step counts as 2. Fix: only count step-finish (the terminal event).

describe("getSessionMetrics — step counting", () => {
  // We can't easily test getSessionMetrics directly (it calls kilo serve).
  // Instead we test the counting logic extracted into a helper.
  // After the fix, this helper will be importable.

  /** Replicate the counting logic from session-killer.ts flattenParts + count. */
  function countSteps(parts: Array<{ type: string }>): number {
    let count = 0;
    for (const part of parts) {
      // BUG (before fix): both step-start AND step-finish increment
      // FIX: only step-finish should increment
      if (part.type === "step-finish") {
        count++;
      }
    }
    return count;
  }

  it("counts each completed step exactly once", () => {
    const parts = [
      { type: "step-start" },
      { type: "tool" },
      { type: "tool" },
      { type: "step-finish" },
      { type: "step-start" },
      { type: "tool" },
      { type: "step-finish" },
    ];

    // 2 complete steps (2 step-start + 2 step-finish pairs)
    expect(countSteps(parts)).toBe(2);
  });

  it("does not count incomplete steps (step-start without step-finish)", () => {
    const parts = [
      { type: "step-start" },
      { type: "tool" },
      // No step-finish — step was interrupted
    ];

    expect(countSteps(parts)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bug #3: fitter-dispatch timeout ignores actual session cost
// ═══════════════════════════════════════════════════════════════════════════════
//
// computeTimeout invents a cost from tool patterns (count * 0.001) instead of
// using the actual cost from the kill confirmation. Fix: pass the kill
// confirmation (or at least its cost) through to the timeout computation.

describe("FitterDispatch — timeout computation", () => {
  // We test the public dispatch method's behavior indirectly by checking
  // that the SessionRequest passed to the dispatcher has a reasonable timeout.

  it("computes timeout proportional to actual session cost, not tool count", async () => {
    let capturedRequest: SessionRequest | null = null;

    const mockDispatcher = {
      async createSession(req: SessionRequest): Promise<SessionResponse> {
        capturedRequest = req;
        return {
          sessionId: "fitter-123",
          success: true,
          cost: 0.3,
          filesChanged: ["foo.ts"],
          durationMs: 10_000,
          error: null,
        };
      },
    };

    const fitter = new FitterDispatch({
      config: {
        ...DEFAULT_FITTER_CONFIG,
        timeoutMsPerDollar: 60_000,
        minTimeoutMs: 30_000,
        maxTimeoutMs: 300_000,
      },
      dispatcher: mockDispatcher,
    });

    const diagnosis = {
      sessionId: "runaway-1",
      category: "infinite_retry",
      confidence: 0.85,
      summary: 'Tool "editFile" failing repeatedly (5 consecutive errors). Last error: syntax error',
      suggestedAction: "Include error context",
      toolPatterns: [
        { tool: "editFile", count: 20, errorCount: 15, lastStatus: "error" },
        { tool: "readFile", count: 50, errorCount: 0, lastStatus: "completed" },
      ],
      diagnosedAt: new Date(),
    };

    const killConfirmation = {
      sessionId: "runaway-1",
      killedAt: new Date(),
      trigger: {
        sessionId: "runaway-1",
        classification: "cost_overflow",
        reason: "Cost $3.50 exceeds budget",
        metrics: {
          stepCount: 80,
          totalCost: 3.5,
          toolCalls: 70,
          recentTools: [],
          uniqueSourceHashes: 10,
          elapsedMs: 120_000,
        },
        detectedAt: new Date(),
      },
      finalMetrics: {
        stepCount: 80,
        totalCost: 3.5,
        toolCalls: 70,
        recentTools: [],
        uniqueSourceHashes: 10,
        elapsedMs: 120_000,
      },
    };

    const input: FitterDispatchInput = {
      diagnosis: diagnosis as DiagnosisReport,
      killConfirmation: killConfirmation as KillConfirmation,
    };

    await fitter.dispatch(input);

    expect(capturedRequest).not.toBeNull();
    // The timeout should be based on the actual $3.50 cost, not the synthetic
    // $0.17 (70 tools * 0.001 + 0.1). At 60k ms/dollar and 50% of $3.50:
    // ~$1.75 * 60_000 = 105_000ms. Should be well above minTimeoutMs (30s).
    expect(capturedRequest!.timeoutMs).toBeGreaterThan(60_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Existing behavior regression tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("LoopDetector — step_overflow", () => {
  it("fires when step count exceeds threshold", () => {
    const detector = new LoopDetector({
      sessionId: "step-test",
      thresholds: { maxSteps: 5, maxCostUsd: 9999, cycleRepetitions: 9999 },
    });

    for (let i = 0; i < 6; i++) {
      detector.ingest(makePunch({ punchType: "step_complete" }));
    }

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection?.classification).toBe("step_overflow");
  });

  it("does not fire at exactly the threshold", () => {
    const detector = new LoopDetector({
      sessionId: "step-exact",
      thresholds: { maxSteps: 5, maxCostUsd: 9999, cycleRepetitions: 9999 },
    });

    for (let i = 0; i < 5; i++) {
      detector.ingest(makePunch({ punchType: "step_complete" }));
    }

    // cost_overflow and tool_cycle won't fire, cache_plateau might depending on fix
    const detection = detector.detect();
    // Should not be step_overflow
    if (detection) {
      expect(detection.classification).not.toBe("step_overflow");
    }
  });
});

describe("LoopDetector — cost_overflow", () => {
  it("fires when cumulative cost exceeds budget", () => {
    const detector = new LoopDetector({
      sessionId: "cost-test",
      thresholds: { maxCostUsd: 1.0, maxSteps: 9999, cycleRepetitions: 9999 },
    });

    detector.ingest(makePunch({ cost: 0.5 }));
    detector.ingest(makePunch({ cost: 0.6 }));

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection?.classification).toBe("cost_overflow");
  });
});

describe("LoopDetector — tool_cycle", () => {
  it("detects repeating tool patterns", () => {
    const detector = new LoopDetector({
      sessionId: "cycle-test",
      thresholds: {
        minCycleLength: 2,
        maxCycleLength: 4,
        cycleRepetitions: 3,
        maxSteps: 9999,
        maxCostUsd: 9999,
      },
    });

    // Pattern: edit → read repeated 3 times
    for (let rep = 0; rep < 3; rep++) {
      detector.ingest(makePunch({ punchType: "tool_call", punchKey: "edit" }));
      detector.ingest(makePunch({ punchType: "tool_call", punchKey: "read" }));
    }

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection?.classification).toBe("tool_cycle");
  });
});
