import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KillConfirmation, LoopClassification } from "../src/governor/types.js";

// ── Mock SDK ──

const messagesMock = vi.hoisted(() => vi.fn());

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: () => ({
    session: {
      messages: messagesMock,
    },
  }),
}));

import { diagnoseSession } from "../src/governor/diagnosis-engine.js";

// ── Helpers ──

/** Build a tool part (as returned by kilo serve message API). */
function toolPart(tool: string, status = "completed", error?: string) {
  return {
    type: "tool",
    tool,
    state: { status, ...(error ? { error } : {}) },
  };
}

/** Build a text part. */
function textPart(content = "Some text") {
  return { type: "text", content };
}

/** Build a step-start or step-finish part. */
function stepPart(kind: "step-start" | "step-finish") {
  return { type: kind };
}

/**
 * Wrap parts into the kilo serve message response structure.
 * fetchSessionParts expects: messages[] → group[] → msg → { parts: [] }
 */
function wrapMessages(parts: Array<Record<string, unknown>>) {
  return { data: [[{ parts }]] };
}

function makeKill(overrides: Partial<KillConfirmation> = {}): KillConfirmation {
  return {
    sessionId: "diag-session-001",
    killedAt: new Date("2026-02-24T01:00:00Z"),
    trigger: {
      sessionId: "diag-session-001",
      classification: "step_overflow" as LoopClassification,
      reason: "Step count 120 exceeds threshold 100",
      metrics: {
        stepCount: 120,
        totalCost: 1.8,
        toolCalls: 200,
        recentTools: [],
        uniqueSourceHashes: 15,
        elapsedMs: 180_000,
      },
      detectedAt: new Date("2026-02-24T00:59:00Z"),
    },
    finalMetrics: {
      stepCount: 120,
      totalCost: 1.8,
      toolCalls: 200,
      recentTools: [],
      uniqueSourceHashes: 15,
      elapsedMs: 180_000,
    },
    ...overrides,
  };
}

const defaultConfig = { kiloHost: "localhost", kiloPort: 4096 };

// ═══════════════════════════════════════════════════════════════════════════════
// Diagnosis Accuracy Tests (7xo.5 scenario 5)
// ═══════════════════════════════════════════════════════════════════════════════

describe("diagnoseSession — classification accuracy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── stuck_on_approval ──

  it("detects stuck_on_approval when tail is all text (no tools)", async () => {
    const parts = [
      toolPart("readFile"),
      toolPart("edit"),
      toolPart("readFile"),
      // Then 8 text-only parts at the tail
      ...Array.from({ length: 8 }, () => textPart("Waiting for confirmation...")),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("stuck_on_approval");
    expect(report.confidence).toBeGreaterThanOrEqual(0.65);
    expect(report.sessionId).toBe("diag-session-001");
  });

  it("detects stuck_on_approval via approval keywords in text", async () => {
    const parts = [
      // Early tool activity (outside the last-10 tail window)
      toolPart("readFile"),
      toolPart("readFile"),
      toolPart("edit"),
      toolPart("readFile"),
      toolPart("edit"),
      // Tail: 10 parts with approval keywords and ≤2 tools
      textPart("I need your permission to proceed with the edit"),
      textPart("Please approve the file changes"),
      textPart("Waiting for confirmation..."),
      textPart("Still waiting"),
      textPart("Are you there?"),
      toolPart("readFile"),  // 1 tool in tail
      textPart("Please confirm to proceed"),
      textPart("Waiting..."),
      textPart("Hello?"),
      textPart("Need approval to continue"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("stuck_on_approval");
    expect(report.confidence).toBeGreaterThanOrEqual(0.6);
  });

  // ── infinite_retry ──

  it("detects infinite_retry with consecutive errors on same tool", async () => {
    const parts = [
      toolPart("readFile"),
      toolPart("edit"),
      // 5 consecutive errors on bash
      toolPart("bash", "error", "Command not found: xyz"),
      toolPart("bash", "error", "Command not found: xyz"),
      toolPart("bash", "error", "Command not found: xyz"),
      toolPart("bash", "error", "Command not found: xyz"),
      toolPart("bash", "error", "Command not found: xyz"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("infinite_retry");
    expect(report.confidence).toBeGreaterThanOrEqual(0.8);
    expect(report.summary).toContain("bash");
    expect(report.summary).toContain("consecutive errors");
  });

  it("detects infinite_retry with high error rate (non-consecutive)", async () => {
    const parts = [
      toolPart("readFile"),
      toolPart("edit"),
      toolPart("grep", "error", "No matches"),
      toolPart("readFile"),
      toolPart("grep", "error", "No matches"),
      toolPart("readFile"),
      toolPart("grep", "error", "No matches"),
      toolPart("grep", "completed"),
      // Tail doesn't end with errors, but grep has 75% error rate
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("infinite_retry");
    expect(report.confidence).toBeGreaterThanOrEqual(0.5);
    expect(report.summary).toContain("grep");
  });

  // ── context_exhaustion ──

  it("detects context_exhaustion from cache_plateau trigger", async () => {
    // Minimal parts — the cache_plateau classification on the kill is enough
    const parts = [
      toolPart("readFile"),
      toolPart("readFile"),
      toolPart("readFile"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const kill = makeKill({
      trigger: {
        sessionId: "diag-session-001",
        classification: "cache_plateau",
        reason: "Cache plateau: 3/20 unique hashes",
        metrics: makeKill().finalMetrics,
        detectedAt: new Date(),
      },
    });

    const report = await diagnoseSession(defaultConfig, kill);

    expect(report.category).toBe("context_exhaustion");
    expect(report.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("detects context_exhaustion from high read ratio (>70%)", async () => {
    // 12 reads + 2 edits = 86% read ratio
    const parts = [
      ...Array.from({ length: 12 }, () => toolPart("readFile")),
      toolPart("edit"),
      toolPart("edit"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("context_exhaustion");
    expect(report.confidence).toBeGreaterThanOrEqual(0.65);
    expect(report.summary).toContain("reads");
  });

  // ── scope_creep ──

  it("detects scope_creep with many edit operations (>15)", async () => {
    const parts = [
      toolPart("readFile"),
      ...Array.from({ length: 18 }, () => toolPart("edit")),
      toolPart("readFile"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("scope_creep");
    expect(report.confidence).toBeGreaterThanOrEqual(0.7);
    expect(report.summary).toContain("18 edit");
  });

  it("detects scope_creep at lower confidence with 8-15 edits", async () => {
    const parts = [
      toolPart("readFile"),
      ...Array.from({ length: 10 }, () => toolPart("edit")),
      toolPart("readFile"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("scope_creep");
    expect(report.confidence).toBeGreaterThanOrEqual(0.45);
    expect(report.confidence).toBeLessThan(0.75);
  });

  // ── model_confusion ──

  it("detects model_confusion from edit→revert→edit flip-flop cycles", async () => {
    const parts = [
      toolPart("readFile"),
      // 3 flip-flop cycles
      toolPart("edit"), toolPart("undo"), toolPart("edit"),
      toolPart("edit"), toolPart("revert"), toolPart("edit"),
      toolPart("edit"), toolPart("undo"), toolPart("edit"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("model_confusion");
    expect(report.confidence).toBeGreaterThanOrEqual(0.75);
    expect(report.summary).toContain("flip-flop");
  });

  it("detects model_confusion from errors across many diverse tools", async () => {
    const parts = [
      toolPart("readFile", "error", "File not found"),
      toolPart("bash", "error", "Command not found"),
      toolPart("grep", "error", "Invalid regex"),
      toolPart("edit", "error", "No match found"),
      toolPart("readFile"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("model_confusion");
    expect(report.confidence).toBeGreaterThanOrEqual(0.55);
    expect(report.summary).toContain("different tools produced errors");
  });

  // ── Fallback ──

  it("falls back to model_confusion with low confidence when no classifier matches", async () => {
    // 3 normal parts — too few to trigger anything
    const parts = [
      toolPart("readFile"),
      toolPart("edit"),
      textPart("Done"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("model_confusion");
    expect(report.confidence).toBeLessThanOrEqual(0.3);
    expect(report.summary).toContain("Unable to classify");
  });

  it("falls back gracefully when fetchSessionParts returns empty (API error)", async () => {
    messagesMock.mockRejectedValue(new Error("Connection refused"));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.category).toBe("model_confusion");
    expect(report.confidence).toBeLessThanOrEqual(0.3);
  });

  // ── Priority ──

  it("highest confidence classifier wins when multiple match", async () => {
    // Scenario: cache_plateau trigger (context_exhaustion: 0.9)
    // PLUS 18 edits (scope_creep: 0.75)
    // context_exhaustion should win because 0.9 > 0.75
    const parts = [
      ...Array.from({ length: 18 }, () => toolPart("edit")),
      ...Array.from({ length: 5 }, () => toolPart("readFile")),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const kill = makeKill({
      trigger: {
        sessionId: "diag-session-001",
        classification: "cache_plateau",
        reason: "Cache plateau",
        metrics: makeKill().finalMetrics,
        detectedAt: new Date(),
      },
    });

    const report = await diagnoseSession(defaultConfig, kill);

    expect(report.category).toBe("context_exhaustion");
    expect(report.confidence).toBe(0.9);
  });

  // ── Report shape ──

  it("report includes toolPatterns with correct counts", async () => {
    const parts = [
      toolPart("readFile"),
      toolPart("readFile"),
      toolPart("readFile"),
      toolPart("edit"),
      toolPart("bash", "error", "fail"),
    ];
    messagesMock.mockResolvedValue(wrapMessages(parts));

    const report = await diagnoseSession(defaultConfig, makeKill());

    expect(report.toolPatterns).toBeDefined();
    const readPattern = report.toolPatterns.find((p) => p.tool === "readFile");
    expect(readPattern?.count).toBe(3);
    expect(readPattern?.errorCount).toBe(0);

    const bashPattern = report.toolPatterns.find((p) => p.tool === "bash");
    expect(bashPattern?.count).toBe(1);
    expect(bashPattern?.errorCount).toBe(1);

    expect(report.diagnosedAt).toBeInstanceOf(Date);
    expect(report.sessionId).toBe("diag-session-001");
  });
});
