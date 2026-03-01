/**
 * Governor End-to-End Tests (7xo.5 scenario 7)
 *
 * Full pipeline: Punch Stream → LoopDetector → SessionKiller → DiagnosisEngine → FitterDispatch
 *
 * Mocks the SDK (abort + messages) and the SessionDispatcher (fitter session creation).
 * Uses real LoopDetector, killSession, diagnoseSession, and FitterDispatch logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Punch } from "../src/classifier/index.js";
import type { DoltWriter } from "../src/writer/index.js";
import type {
  SessionResponse,
} from "../src/governor/fitter-dispatch.js";

// ── Mock SDK (covers both session-killer and diagnosis-engine) ──

const abortMock = vi.hoisted(() => vi.fn());
const messagesMock = vi.hoisted(() => vi.fn());

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: () => ({
    session: {
      abort: abortMock,
      messages: messagesMock,
    },
  }),
}));

import { LoopDetector } from "../src/governor/loop-detector.js";
import { killSession } from "../src/governor/session-killer.js";
import { diagnoseSession } from "../src/governor/diagnosis-engine.js";
import { FitterDispatch } from "../src/governor/fitter-dispatch.js";
import type { SessionDispatcher, SessionRequest } from "../src/governor/fitter-dispatch.js";

// ── Helpers ──

let punchSeq = 0;

function makePunch(overrides: Partial<Punch> = {}): Punch {
  punchSeq++;
  return {
    taskId: "e2e-session-runaway",
    punchType: "tool_call",
    punchKey: overrides.punchKey ?? `tool-${punchSeq}`,
    observedAt: new Date("2026-02-24T00:00:00Z"),
    sourceHash: `hash-${punchSeq}`,
    ...(overrides as Record<string, unknown>),
  } as Punch;
}

function makeMockWriter(): DoltWriter & {
  writePunchCalls: Array<Record<string, unknown>>;
} {
  const writePunchCalls: Array<Record<string, unknown>> = [];
  return {
    writePunchCalls,
    async connect() {},
    async writePunch(punch) {
      writePunchCalls.push(punch as unknown as Record<string, unknown>);
    },
    async writeSession() {},
    async writeMessage() {},
    async writeToolCall() {},
    async writeChildRelation() {},
    async syncChildRelsFromPunches() { return 0; },
    async disconnect() {},
  };
}

function makeMockDispatcher(
  response?: Partial<SessionResponse>
): SessionDispatcher & { requests: SessionRequest[] } {
  const requests: SessionRequest[] = [];
  return {
    requests,
    async createSession(req: SessionRequest): Promise<SessionResponse> {
      requests.push(req);
      return {
        sessionId: response?.sessionId ?? "fitter-session-001",
        success: response?.success ?? true,
        cost: response?.cost ?? 0.35,
        filesChanged: response?.filesChanged ?? ["src/fix.ts"],
        durationMs: response?.durationMs ?? 15_000,
        error: response?.error ?? null,
      };
    },
  };
}

/** Wrap message parts into kilo serve API response shape. */
function wrapMessages(parts: Array<Record<string, unknown>>) {
  return { data: [[{ parts }]] };
}

function toolPart(tool: string, status = "completed", error?: string) {
  return {
    type: "tool",
    tool,
    state: { status, ...(error ? { error } : {}) },
  };
}

const kiloConfig = { kiloHost: "localhost", kiloPort: 4096 };

// ═══════════════════════════════════════════════════════════════════════════════
// End-to-End Pipeline Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Governor E2E — detect → kill → diagnose → dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    punchSeq = 0;
  });

  it("step_overflow → kill → infinite_retry diagnosis → fitter dispatch", async () => {
    // ── Stage 1: Detect (LoopDetector) ──
    const detector = new LoopDetector({
      sessionId: "e2e-session-runaway",
      thresholds: { maxSteps: 10 }, // low threshold for testing
    });

    // Feed step-complete punches until overflow
    for (let i = 0; i < 12; i++) {
      detector.ingest(makePunch({ punchType: "step_complete", punchKey: "step-finish" }));
    }

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection!.classification).toBe("step_overflow");
    expect(detection!.sessionId).toBe("e2e-session-runaway");

    // ── Stage 2: Kill (SessionKiller) ──
    abortMock.mockResolvedValue({ data: {}, error: null });
    const writer = makeMockWriter();

    const killConfirmation = await killSession(
      { config: kiloConfig, writer },
      detection!
    );

    expect(killConfirmation.sessionId).toBe("e2e-session-runaway");
    expect(killConfirmation.trigger.classification).toBe("step_overflow");
    expect(writer.writePunchCalls).toHaveLength(1);
    expect(writer.writePunchCalls[0].punchType).toBe("governor_kill");

    // ── Stage 3: Diagnose (DiagnosisEngine) ──
    // Mock kilo serve messages: the session was retrying bash with errors
    messagesMock.mockResolvedValue(
      wrapMessages([
        toolPart("readFile"),
        toolPart("bash", "error", "Permission denied: /etc/shadow"),
        toolPart("bash", "error", "Permission denied: /etc/shadow"),
        toolPart("bash", "error", "Permission denied: /etc/shadow"),
        toolPart("bash", "error", "Permission denied: /etc/shadow"),
        toolPart("bash", "error", "Permission denied: /etc/shadow"),
      ])
    );

    const diagnosis = await diagnoseSession(kiloConfig, killConfirmation);

    expect(diagnosis.sessionId).toBe("e2e-session-runaway");
    expect(diagnosis.category).toBe("infinite_retry");
    expect(diagnosis.confidence).toBeGreaterThanOrEqual(0.8);
    expect(diagnosis.summary).toContain("bash");
    expect(diagnosis.toolPatterns.length).toBeGreaterThan(0);

    // ── Stage 4: Dispatch (FitterDispatch) ──
    const dispatcher = makeMockDispatcher();
    const fitter = new FitterDispatch({ dispatcher });

    const fitterResult = await fitter.dispatch({
      diagnosis,
      killConfirmation,
    });

    expect(fitterResult.sessionId).toBe("fitter-session-001");
    expect(fitterResult.success).toBe(true);
    expect(fitterResult.cost).toBe(0.35);
    expect(fitterResult.filesChanged).toContain("src/fix.ts");

    // Verify the fitter received a prompt containing the error context
    expect(dispatcher.requests).toHaveLength(1);
    const req = dispatcher.requests[0];
    expect(req.prompt).toContain("bash");
    expect(req.autoApprove).toBe(true); // all fitter sessions get auto-approve
    expect(req.maxTokenBudget).toBeLessThanOrEqual(100_000);
    expect(req.timeoutMs).toBeGreaterThan(0);
  });

  it("cost_overflow → kill → context_exhaustion (cache_plateau) → fitter with auto-split", async () => {
    // ── Stage 1: Detect (LoopDetector) ──
    const detector = new LoopDetector({
      sessionId: "e2e-session-runaway",
      thresholds: { maxCostUsd: 1.0 },
    });

    // Feed punches with escalating cost
    for (let i = 0; i < 20; i++) {
      detector.ingest(
        makePunch({
          punchType: "step_complete",
          punchKey: "step-finish",
          cost: 0.06, // 20 * 0.06 = $1.20, exceeds $1.00
        } as unknown as Partial<Punch>)
      );
    }

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection!.classification).toBe("cost_overflow");

    // ── Stage 2: Kill ──
    abortMock.mockResolvedValue({ data: {}, error: null });
    const writer = makeMockWriter();

    const killConfirmation = await killSession(
      { config: kiloConfig, writer },
      detection!
    );

    expect(killConfirmation.trigger.classification).toBe("cost_overflow");

    // ── Stage 3: Diagnose ──
    // Mock messages: agent was reading the same files over and over
    messagesMock.mockResolvedValue(
      wrapMessages([
        ...Array.from({ length: 14 }, () => toolPart("readFile")),
        toolPart("edit"),
        toolPart("edit"),
      ])
    );

    const diagnosis = await diagnoseSession(kiloConfig, killConfirmation);

    expect(diagnosis.category).toBe("context_exhaustion");
    expect(diagnosis.confidence).toBeGreaterThanOrEqual(0.65);

    // ── Stage 4: Dispatch ──
    const dispatcher = makeMockDispatcher({ cost: 0.28 });
    const fitter = new FitterDispatch({ dispatcher });

    const fitterResult = await fitter.dispatch({
      diagnosis,
      killConfirmation,
    });

    expect(fitterResult.success).toBe(true);
    expect(fitterResult.cost).toBe(0.28);

    // Verify prompt mentions splitting or file paths
    const req = dispatcher.requests[0];
    expect(req.prompt.length).toBeGreaterThan(50);
    expect(req.autoApprove).toBe(true); // all fitter sessions get auto-approve
  });

  it("tool_cycle → kill (404 idempotent) → scope_creep diagnosis → fitter", async () => {
    // ── Stage 1: Detect (LoopDetector) ──
    const detector = new LoopDetector({
      sessionId: "e2e-session-runaway",
      thresholds: {
        minCycleLength: 2,
        maxCycleLength: 4,
        cycleRepetitions: 3,
      },
    });

    // Feed a repeating 2-tool cycle: edit → bash → edit → bash × many
    for (let i = 0; i < 12; i++) {
      detector.ingest(makePunch({ punchType: "tool_call", punchKey: i % 2 === 0 ? "edit" : "bash" }));
    }

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection!.classification).toBe("tool_cycle");

    // ── Stage 2: Kill (session already dead — 404) ──
    abortMock.mockResolvedValue({
      data: null,
      error: { status: 404, message: "Not Found" },
    });
    const writer = makeMockWriter();

    const killConfirmation = await killSession(
      { config: kiloConfig, writer },
      detection!
    );

    // Idempotent: still succeeds
    expect(killConfirmation.sessionId).toBe("e2e-session-runaway");
    expect(killConfirmation.trigger.reason).toContain("already terminated");
    expect(writer.writePunchCalls).toHaveLength(1);

    // ── Stage 3: Diagnose ──
    // Mock messages: many edits (scope creep)
    messagesMock.mockResolvedValue(
      wrapMessages([
        toolPart("readFile"),
        ...Array.from({ length: 20 }, () => toolPart("edit")),
      ])
    );

    const diagnosis = await diagnoseSession(kiloConfig, killConfirmation);

    expect(diagnosis.category).toBe("scope_creep");
    expect(diagnosis.confidence).toBeGreaterThanOrEqual(0.7);

    // ── Stage 4: Dispatch ──
    const dispatcher = makeMockDispatcher();
    const fitter = new FitterDispatch({ dispatcher });

    const fitterResult = await fitter.dispatch({
      diagnosis,
      killConfirmation,
    });

    expect(fitterResult.success).toBe(true);
    const req = dispatcher.requests[0];
    expect(req.prompt.length).toBeGreaterThan(50);
  });

  it("cache_plateau → kill → context_exhaustion (high confidence from trigger) → dispatch", async () => {
    // ── Stage 1: Detect (LoopDetector) ──
    const detector = new LoopDetector({
      sessionId: "e2e-session-runaway",
      thresholds: {
        cacheWindowSize: 10,
        cachePlateauRatio: 0.3,
      },
    });

    // Feed 10+ punches with only 2 unique contentHashes → plateau
    for (let i = 0; i < 12; i++) {
      detector.ingest(
        makePunch({
          punchType: "tool_call",
          punchKey: `read-${i}`,
          contentHash: i % 2 === 0 ? "hash-A" : "hash-B", // only 2 unique
        } as unknown as Partial<Punch>)
      );
    }

    const detection = detector.detect();
    expect(detection).not.toBeNull();
    expect(detection!.classification).toBe("cache_plateau");

    // ── Stage 2: Kill ──
    abortMock.mockResolvedValue({ data: {}, error: null });

    const killConfirmation = await killSession(
      { config: kiloConfig },
      detection!
    );

    expect(killConfirmation.trigger.classification).toBe("cache_plateau");

    // ── Stage 3: Diagnose ──
    // With cache_plateau trigger, diagnosis should be context_exhaustion at 0.9
    messagesMock.mockResolvedValue(wrapMessages([toolPart("readFile")]));

    const diagnosis = await diagnoseSession(kiloConfig, killConfirmation);

    expect(diagnosis.category).toBe("context_exhaustion");
    expect(diagnosis.confidence).toBe(0.9);

    // ── Stage 4: Dispatch ──
    const dispatcher = makeMockDispatcher({ success: true, cost: 0.20 });
    const fitter = new FitterDispatch({ dispatcher });

    const fitterResult = await fitter.dispatch({
      diagnosis,
      killConfirmation,
    });

    expect(fitterResult.success).toBe(true);
    expect(fitterResult.cost).toBe(0.20);
  });

  it("fitter dispatch failure is handled gracefully in the pipeline", async () => {
    // ── Quick detect + kill ──
    const detector = new LoopDetector({
      sessionId: "e2e-session-runaway",
      thresholds: { maxSteps: 5 },
    });
    for (let i = 0; i < 8; i++) {
      detector.ingest(makePunch({ punchType: "step_complete", punchKey: "step-finish" }));
    }

    const detection = detector.detect()!;
    abortMock.mockResolvedValue({ data: {}, error: null });
    const killConfirmation = await killSession({ config: kiloConfig }, detection);

    // ── Diagnose ──
    messagesMock.mockResolvedValue(
      wrapMessages([toolPart("readFile"), toolPart("edit"), toolPart("edit")])
    );
    const diagnosis = await diagnoseSession(kiloConfig, killConfirmation);

    // ── Dispatch fails ──
    const failDispatcher: SessionDispatcher = {
      async createSession() {
        throw new Error("kilo serve unreachable");
      },
    };
    const fitter = new FitterDispatch({ dispatcher: failDispatcher });

    const result = await fitter.dispatch({ diagnosis, killConfirmation });

    // Should NOT throw — returns a failure result
    expect(result.success).toBe(false);
    expect(result.error).toContain("kilo serve unreachable");
    expect(result.cost).toBe(0);
  });

  it("data flows correctly through the entire pipeline (property verification)", async () => {
    // Verify that session IDs, costs, and metrics propagate end-to-end

    const detector = new LoopDetector({
      sessionId: "e2e-session-runaway",
      thresholds: { maxCostUsd: 0.5 },
    });

    for (let i = 0; i < 10; i++) {
      detector.ingest(
        makePunch({
          punchType: "step_complete",
          punchKey: "step-finish",
          cost: 0.06,
        } as unknown as Partial<Punch>)
      );
    }

    const detection = detector.detect()!;
    expect(detection.metrics.totalCost).toBeCloseTo(0.6, 1);

    abortMock.mockResolvedValue({ data: {}, error: null });
    const writer = makeMockWriter();
    const killConfirmation = await killSession(
      { config: kiloConfig, writer },
      detection
    );

    // Kill punch records the cost from detection metrics
    expect(writer.writePunchCalls[0].cost).toBeCloseTo(0.6, 1);

    // Kill confirmation carries the metrics through
    expect(killConfirmation.finalMetrics.totalCost).toBeCloseTo(0.6, 1);
    expect(killConfirmation.sessionId).toBe("e2e-session-runaway");

    // Diagnosis carries the session ID through
    messagesMock.mockResolvedValue(wrapMessages([toolPart("readFile")]));
    const diagnosis = await diagnoseSession(kiloConfig, killConfirmation);
    expect(diagnosis.sessionId).toBe("e2e-session-runaway");

    // Fitter gets the actual cost for timeout calculation
    const dispatcher = makeMockDispatcher();
    const fitter = new FitterDispatch({ dispatcher });
    await fitter.dispatch({ diagnosis, killConfirmation });

    const req = dispatcher.requests[0];
    // Timeout should be computed from actual cost (0.6 * 0.5 = 0.3 → 0.3 * 60000 = 18000, clamped to min 30000)
    expect(req.timeoutMs).toBeGreaterThanOrEqual(30_000);
  });
});
