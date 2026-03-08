/**
 * Session Audit Tests
 *
 * Tests for the governor's post-workflow session audit module that queries
 * Dolt punch data after workflow completion and flags anomalies across
 * six detectors:
 *   1. Missing quality gates
 *   2. Cost anomalies
 *   3. Loop signatures
 *   4. Tool adherence deviation
 *   5. Incomplete subtask trees
 *   6. Stall detection
 *
 * Tests are organized by concern:
 *   1. Configuration loading (env vars + defaults + overrides)
 *   2. Detector: detectMissingQualityGates
 *   3. Detector: detectCostAnomalies
 *   4. Detector: detectLoopSignatures
 *   5. Detector: detectToolAdherenceDeviation
 *   6. Detector: detectIncompleteSubtaskTree
 *   7. Detector: detectStalls
 *   8. Integration: runAudit verdict logic
 *   9. Edge cases: empty results, zero tokens, no punches
 *  10. Connection lifecycle
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  SessionAudit,
  loadAuditConfig,
  DEFAULT_AUDIT_CONFIG,
} from "../src/governor/session-audit.js";
import type {
  AuditFinding,
  SessionAuditConfig,
  SessionAuditReport,
} from "../src/governor/types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Mock helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a SessionAudit instance with a mocked MySQL connection.
 * The queryHandler is called for every `execute()` with (sql, params) and
 * should return a rows array (the first element of the mysql2 tuple).
 */
function createMockAudit(
  queryHandler: (sql: string, params?: unknown[]) => unknown[],
  auditConfig?: Partial<SessionAuditConfig>,
) {
  const mockConn = {
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      return [queryHandler(sql, params)];
    }),
    end: vi.fn(async () => {}),
  };
  const audit = new SessionAudit(
    { host: "127.0.0.1", port: 3307, database: "test_db" },
    auditConfig,
  );
  // Inject mock connection
  (audit as unknown as { connection: unknown }).connection = mockConn;
  return { audit, mockConn };
}

/** Default zero-cost aggregate row for session metrics queries. */
function zeroCostRow() {
  return {
    total_cost: "0",
    step_count: "0",
    tokens_input: "0",
    tokens_output: "0",
    tokens_reasoning: "0",
    punch_count: "0",
  };
}

/** Default zero-timestamp row for duration queries. */
function zeroTimestampRow() {
  return { min_at: null, max_at: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Configuration Loading
// ═══════════════════════════════════════════════════════════════════════════════

describe("loadAuditConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns defaults when no env vars or overrides provided", () => {
    const config = loadAuditConfig();
    expect(config).toEqual(DEFAULT_AUDIT_CONFIG);
  });

  it("reads env vars when set", () => {
    process.env.AUDIT_CHEAP_ZONE_USD = "0.55";
    process.env.AUDIT_COST_ANOMALY_USD = "2.00";
    process.env.AUDIT_MAX_EXPECTED_STEPS = "100";
    process.env.AUDIT_MAX_PUNCH_GAP_SECONDS = "120";

    const config = loadAuditConfig();
    expect(config.cheapZonePercentileUsd).toBe(0.55);
    expect(config.costAnomalyThresholdUsd).toBe(2.0);
    expect(config.maxExpectedSteps).toBe(100);
    expect(config.maxPunchGapSeconds).toBe(120);
  });

  it("overrides take precedence over env vars", () => {
    process.env.AUDIT_CHEAP_ZONE_USD = "0.55";

    const config = loadAuditConfig({ cheapZonePercentileUsd: 0.80 });
    expect(config.cheapZonePercentileUsd).toBe(0.80);
  });

  it("ignores invalid env values and uses defaults", () => {
    process.env.AUDIT_CHEAP_ZONE_USD = "not-a-number";
    process.env.AUDIT_MAX_EXPECTED_STEPS = "-5";
    process.env.AUDIT_COST_ANOMALY_USD = "";
    process.env.AUDIT_MAX_PUNCH_GAP_SECONDS = "0";

    const config = loadAuditConfig();
    expect(config.cheapZonePercentileUsd).toBe(DEFAULT_AUDIT_CONFIG.cheapZonePercentileUsd);
    expect(config.maxExpectedSteps).toBe(DEFAULT_AUDIT_CONFIG.maxExpectedSteps);
    expect(config.costAnomalyThresholdUsd).toBe(DEFAULT_AUDIT_CONFIG.costAnomalyThresholdUsd);
    expect(config.maxPunchGapSeconds).toBe(DEFAULT_AUDIT_CONFIG.maxPunchGapSeconds);
  });

  it("default cheap zone target is $0.42", () => {
    expect(DEFAULT_AUDIT_CONFIG.cheapZonePercentileUsd).toBe(0.42);
  });

  it("default cost anomaly threshold is $1.00", () => {
    expect(DEFAULT_AUDIT_CONFIG.costAnomalyThresholdUsd).toBe(1.0);
  });

  it("default max expected steps is 50", () => {
    expect(DEFAULT_AUDIT_CONFIG.maxExpectedSteps).toBe(50);
  });

  it("default max punch gap is 60 seconds", () => {
    expect(DEFAULT_AUDIT_CONFIG.maxPunchGapSeconds).toBe(60);
  });

  it("default required quality gates include typecheck, lint, test, build", () => {
    expect(DEFAULT_AUDIT_CONFIG.requiredQualityGates).toEqual([
      "quality_gate:typecheck",
      "quality_gate:lint",
      "quality_gate:test",
      "quality_gate:build",
    ]);
  });

  it("preserves non-env-configurable fields from defaults when no override", () => {
    const config = loadAuditConfig();
    expect(config.loopMinPatternLength).toBe(DEFAULT_AUDIT_CONFIG.loopMinPatternLength);
    expect(config.loopMaxPatternLength).toBe(DEFAULT_AUDIT_CONFIG.loopMaxPatternLength);
    expect(config.loopMinRepetitions).toBe(DEFAULT_AUDIT_CONFIG.loopMinRepetitions);
    expect(config.expectedEditRange).toEqual(DEFAULT_AUDIT_CONFIG.expectedEditRange);
    expect(config.requiredQualityGates).toEqual(DEFAULT_AUDIT_CONFIG.requiredQualityGates);
  });

  it("overrides non-env-configurable fields", () => {
    const config = loadAuditConfig({
      loopMinPatternLength: 3,
      loopMaxPatternLength: 8,
      loopMinRepetitions: 5,
      expectedEditRange: [2, 50],
      requiredQualityGates: ["quality_gate:typecheck"],
    });
    expect(config.loopMinPatternLength).toBe(3);
    expect(config.loopMaxPatternLength).toBe(8);
    expect(config.loopMinRepetitions).toBe(5);
    expect(config.expectedEditRange).toEqual([2, 50]);
    expect(config.requiredQualityGates).toEqual(["quality_gate:typecheck"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Detector: detectMissingQualityGates
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — detectMissingQualityGates", () => {
  it("returns critical finding for each missing quality gate", async () => {
    // All gates return count=0 → all missing
    const { audit } = createMockAudit((sql) => {
      if (sql.includes("COUNT(*)")) return [{ count: "0" }];
      return [];
    });

    const findings = await audit.detectMissingQualityGates("session-1");

    expect(findings).toHaveLength(4);
    for (const f of findings) {
      expect(f.type).toBe("missing_quality_gate");
      expect(f.severity).toBe("critical");
      expect(f.evidence).toHaveProperty("gate");
      expect(f.evidence).toHaveProperty("count", 0);
    }
  });

  it("returns no findings when all quality gates are present", async () => {
    const { audit } = createMockAudit((sql) => {
      if (sql.includes("COUNT(*)")) return [{ count: "1" }];
      return [];
    });

    const findings = await audit.detectMissingQualityGates("session-1");
    expect(findings).toHaveLength(0);
  });

  it("returns findings only for the gates that are missing", async () => {
    let callCount = 0;
    const { audit } = createMockAudit((sql) => {
      if (sql.includes("COUNT(*)")) {
        callCount++;
        // First two gates present, last two missing
        return [{ count: callCount <= 2 ? "1" : "0" }];
      }
      return [];
    });

    const findings = await audit.detectMissingQualityGates("session-1");
    expect(findings).toHaveLength(2);
    expect(findings[0].message).toContain("quality_gate:test");
    expect(findings[1].message).toContain("quality_gate:build");
  });

  it("respects custom requiredQualityGates config", async () => {
    const { audit } = createMockAudit(
      (sql) => {
        if (sql.includes("COUNT(*)")) return [{ count: "0" }];
        return [];
      },
      { requiredQualityGates: ["quality_gate:typecheck"] },
    );

    const findings = await audit.detectMissingQualityGates("session-1");
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("quality_gate:typecheck");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Detector: detectCostAnomalies
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — detectCostAnomalies", () => {
  it("returns critical finding when total cost exceeds anomaly threshold", async () => {
    const { audit } = createMockAudit(() => []);

    const findings = await audit.detectCostAnomalies("session-1", {
      totalCost: 1.50,
      stepCount: 10,
      tokensInput: 50000,
      tokensOutput: 25000,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("cost_anomaly");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("$1.50");
    expect(findings[0].message).toContain("$1.00");
  });

  it("returns warning when cost per 100k tokens exceeds cheap zone with sufficient volume", async () => {
    // Total cost $0.50 for 75k tokens → costPer100k = $0.667 > $0.42 cheap zone
    // But total cost $0.50 < $1.00 threshold (not critical)
    const { audit } = createMockAudit(() => []);

    const findings = await audit.detectCostAnomalies("session-1", {
      totalCost: 0.50,
      stepCount: 10,
      tokensInput: 50000,
      tokensOutput: 25000,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("cost_anomaly");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("cheap zone");
  });

  it("does not flag cheap zone deviation with low token volume", async () => {
    // costPer100k would be high but total tokens < 50k, so no flag
    const { audit } = createMockAudit(() => []);

    const findings = await audit.detectCostAnomalies("session-1", {
      totalCost: 0.30,
      stepCount: 5,
      tokensInput: 20000,
      tokensOutput: 10000,
    });

    expect(findings).toHaveLength(0);
  });

  it("returns no findings when cost is within budget", async () => {
    const { audit } = createMockAudit(() => []);

    const findings = await audit.detectCostAnomalies("session-1", {
      totalCost: 0.20,
      stepCount: 10,
      tokensInput: 50000,
      tokensOutput: 25000,
    });

    // costPer100k = ($0.20 / 75000) * 100000 = $0.267 < $0.42
    expect(findings).toHaveLength(0);
  });

  it("handles zero tokens gracefully (no division by zero)", async () => {
    const { audit } = createMockAudit(() => []);

    const findings = await audit.detectCostAnomalies("session-1", {
      totalCost: 0.0,
      stepCount: 0,
      tokensInput: 0,
      tokensOutput: 0,
    });

    expect(findings).toHaveLength(0);
  });

  it("respects custom thresholds", async () => {
    const { audit } = createMockAudit(
      () => [],
      { costAnomalyThresholdUsd: 0.50 },
    );

    const findings = await audit.detectCostAnomalies("session-1", {
      totalCost: 0.75,
      stepCount: 10,
      tokensInput: 50000,
      tokensOutput: 25000,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("$0.50");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Detector: detectLoopSignatures
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — detectLoopSignatures", () => {
  it("returns critical finding when step count exceeds max expected", async () => {
    // 60 step_complete punches > default 50 max
    const stepPunches = Array.from({ length: 60 }, (_, i) => ({
      punch_type: "step_complete",
      punch_key: "step_finished",
      observed_at: new Date(Date.now() + i * 1000).toISOString(),
      cost: "0.01",
    }));

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return stepPunches;
      return [];
    });

    const findings = await audit.detectLoopSignatures("session-1");

    const stepFinding = findings.find(
      (f) => f.type === "loop_signature" && f.severity === "critical",
    );
    expect(stepFinding).toBeDefined();
    expect(stepFinding!.message).toContain("60");
    expect(stepFinding!.message).toContain("50");
  });

  it("returns warning when a repeating tool pattern is detected", async () => {
    // Pattern: [edit, read, edit, read, edit, read] — 3 repetitions of length 2
    const toolPunches = Array.from({ length: 6 }, (_, i) => ({
      punch_type: "tool_call",
      punch_key: i % 2 === 0 ? "edit_file" : "read_file",
      observed_at: new Date(Date.now() + i * 1000).toISOString(),
      cost: "0",
    }));

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return toolPunches;
      return [];
    });

    const findings = await audit.detectLoopSignatures("session-1");

    const loopFinding = findings.find(
      (f) => f.type === "loop_signature" && f.severity === "warning",
    );
    expect(loopFinding).toBeDefined();
    expect(loopFinding!.message).toContain("Repeating tool pattern");
    expect(loopFinding!.evidence).toHaveProperty("pattern");
    expect(loopFinding!.evidence).toHaveProperty("repetitions");
  });

  it("does not flag when steps are within limit and no repeated patterns", async () => {
    const punches = [
      { punch_type: "step_complete", punch_key: "step_finished", observed_at: "2025-01-01T00:00:00Z", cost: "0.01" },
      { punch_type: "tool_call", punch_key: "edit_file", observed_at: "2025-01-01T00:00:01Z", cost: "0" },
      { punch_type: "tool_call", punch_key: "read_file", observed_at: "2025-01-01T00:00:02Z", cost: "0" },
      { punch_type: "tool_call", punch_key: "bash", observed_at: "2025-01-01T00:00:03Z", cost: "0" },
      { punch_type: "tool_call", punch_key: "write_to_file", observed_at: "2025-01-01T00:00:04Z", cost: "0" },
    ];

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return punches;
      return [];
    });

    const findings = await audit.detectLoopSignatures("session-1");
    expect(findings).toHaveLength(0);
  });

  it("returns no findings for empty punch sequence", async () => {
    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return [];
      return [];
    });

    const findings = await audit.detectLoopSignatures("session-1");
    expect(findings).toHaveLength(0);
  });

  it("detects longer repeating patterns (length 3)", async () => {
    // Pattern: [a, b, c, a, b, c, a, b, c] — 3 reps of length 3
    const tools = ["edit_file", "read_file", "bash"];
    const toolPunches = Array.from({ length: 9 }, (_, i) => ({
      punch_type: "tool_call",
      punch_key: tools[i % 3],
      observed_at: new Date(Date.now() + i * 1000).toISOString(),
      cost: "0",
    }));

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return toolPunches;
      return [];
    });

    const findings = await audit.detectLoopSignatures("session-1");

    const loopFinding = findings.find((f) => f.severity === "warning");
    expect(loopFinding).toBeDefined();
    expect((loopFinding!.evidence as Record<string, unknown>).patternLength).toBe(3);
  });

  it("does not flag patterns with insufficient repetitions", async () => {
    // Pattern: [a, b, a, b] — only 2 repetitions, below default 3 minimum
    const toolPunches = Array.from({ length: 4 }, (_, i) => ({
      punch_type: "tool_call",
      punch_key: i % 2 === 0 ? "edit_file" : "read_file",
      observed_at: new Date(Date.now() + i * 1000).toISOString(),
      cost: "0",
    }));

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return toolPunches;
      return [];
    });

    const findings = await audit.detectLoopSignatures("session-1");

    const loopFinding = findings.find(
      (f) => f.type === "loop_signature" && f.severity === "warning",
    );
    expect(loopFinding).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Detector: detectToolAdherenceDeviation
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — detectToolAdherenceDeviation", () => {
  it("returns warning when edit count is below minimum", async () => {
    const { audit } = createMockAudit((sql) => {
      if (sql.includes("COUNT(*)")) return [{ count: "0" }];
      return [];
    });

    const findings = await audit.detectToolAdherenceDeviation("session-1");

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("tool_adherence_deviation");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("below expected minimum");
    expect(findings[0].evidence).toHaveProperty("deviation", "below_minimum");
  });

  it("returns warning when edit count exceeds maximum", async () => {
    const { audit } = createMockAudit((sql) => {
      if (sql.includes("COUNT(*)")) return [{ count: "50" }];
      return [];
    });

    const findings = await audit.detectToolAdherenceDeviation("session-1");

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("tool_adherence_deviation");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("exceeds expected maximum");
    expect(findings[0].evidence).toHaveProperty("deviation", "above_maximum");
  });

  it("returns no findings when edit count is within range", async () => {
    const { audit } = createMockAudit((sql) => {
      if (sql.includes("COUNT(*)")) return [{ count: "10" }];
      return [];
    });

    const findings = await audit.detectToolAdherenceDeviation("session-1");
    expect(findings).toHaveLength(0);
  });

  it("returns no findings at exact boundaries", async () => {
    // editCount = 1 (min) → within range
    const { audit: auditMin } = createMockAudit((sql) => {
      if (sql.includes("COUNT(*)")) return [{ count: "1" }];
      return [];
    });
    expect(await auditMin.detectToolAdherenceDeviation("session-1")).toHaveLength(0);

    // editCount = 30 (max) → within range
    const { audit: auditMax } = createMockAudit((sql) => {
      if (sql.includes("COUNT(*)")) return [{ count: "30" }];
      return [];
    });
    expect(await auditMax.detectToolAdherenceDeviation("session-1")).toHaveLength(0);
  });

  it("respects custom expectedEditRange", async () => {
    const { audit } = createMockAudit(
      (sql) => {
        if (sql.includes("COUNT(*)")) return [{ count: "5" }];
        return [];
      },
      { expectedEditRange: [10, 20] },
    );

    const findings = await audit.detectToolAdherenceDeviation("session-1");
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toHaveProperty("deviation", "below_minimum");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Detector: detectIncompleteSubtaskTree
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — detectIncompleteSubtaskTree", () => {
  it("returns no findings when session has no children", async () => {
    const { audit } = createMockAudit((sql) => {
      if (sql.includes("child_rels")) return [];
      return [];
    });

    const findings = await audit.detectIncompleteSubtaskTree("session-1");
    expect(findings).toHaveLength(0);
  });

  it("returns critical finding for child with zero punches", async () => {
    const { audit } = createMockAudit((sql, params) => {
      if (sql.includes("child_rels")) return [{ child_id: "child-1" }];
      if (sql.includes("COUNT(*)") && params?.[0] === "child-1") {
        return [{ punch_count: "0", has_quality_gate: "0" }];
      }
      return [];
    });

    const findings = await audit.detectIncompleteSubtaskTree("session-1");

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("incomplete_subtask_tree");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("child-1");
    expect(findings[0].message).toContain("no punches");
  });

  it("returns warning for child with punches but no quality gate", async () => {
    const { audit } = createMockAudit((sql, params) => {
      if (sql.includes("child_rels")) return [{ child_id: "child-1" }];
      if (sql.includes("COUNT(*)") && params?.[0] === "child-1") {
        return [{ punch_count: "10", has_quality_gate: "0" }];
      }
      return [];
    });

    const findings = await audit.detectIncompleteSubtaskTree("session-1");

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("incomplete_subtask_tree");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("no quality gate");
  });

  it("returns no findings when children are healthy", async () => {
    const { audit } = createMockAudit((sql, params) => {
      if (sql.includes("child_rels")) return [{ child_id: "child-1" }];
      if (sql.includes("COUNT(*)") && params?.[0] === "child-1") {
        return [{ punch_count: "15", has_quality_gate: "2" }];
      }
      return [];
    });

    const findings = await audit.detectIncompleteSubtaskTree("session-1");
    expect(findings).toHaveLength(0);
  });

  it("evaluates multiple children independently", async () => {
    const { audit } = createMockAudit((sql, params) => {
      if (sql.includes("child_rels")) {
        return [{ child_id: "child-1" }, { child_id: "child-2" }, { child_id: "child-3" }];
      }
      if (sql.includes("COUNT(*)")) {
        const taskId = params?.[0] as string;
        if (taskId === "child-1") return [{ punch_count: "10", has_quality_gate: "1" }]; // healthy
        if (taskId === "child-2") return [{ punch_count: "0", has_quality_gate: "0" }];  // critical
        if (taskId === "child-3") return [{ punch_count: "5", has_quality_gate: "0" }];   // warning
      }
      return [];
    });

    const findings = await audit.detectIncompleteSubtaskTree("session-1");

    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].evidence).toHaveProperty("childId", "child-2");
    expect(findings[1].severity).toBe("warning");
    expect(findings[1].evidence).toHaveProperty("childId", "child-3");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Detector: detectStalls
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — detectStalls", () => {
  it("returns warning when gap exceeds threshold", async () => {
    const now = Date.now();
    const punches = [
      { punch_type: "step_complete", punch_key: "step_finished", observed_at: new Date(now).toISOString(), cost: "0.01" },
      { punch_type: "tool_call", punch_key: "edit_file", observed_at: new Date(now + 90_000).toISOString(), cost: "0" }, // 90s gap > 60s threshold
    ];

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return punches;
      return [];
    });

    const findings = await audit.detectStalls("session-1");

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("stall_detected");
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("1 stall");
    expect(findings[0].evidence).toHaveProperty("stallCount", 1);
    expect(findings[0].evidence).toHaveProperty("maxGapSeconds", 90);
  });

  it("returns critical when longest gap exceeds 3x threshold", async () => {
    const now = Date.now();
    const punches = [
      { punch_type: "step_complete", punch_key: "step_finished", observed_at: new Date(now).toISOString(), cost: "0.01" },
      { punch_type: "tool_call", punch_key: "edit_file", observed_at: new Date(now + 200_000).toISOString(), cost: "0" }, // 200s > 180s (3x60s)
    ];

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return punches;
      return [];
    });

    const findings = await audit.detectStalls("session-1");

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("returns no findings when all gaps are within threshold", async () => {
    const now = Date.now();
    const punches = [
      { punch_type: "step_complete", punch_key: "step_finished", observed_at: new Date(now).toISOString(), cost: "0.01" },
      { punch_type: "tool_call", punch_key: "edit_file", observed_at: new Date(now + 30_000).toISOString(), cost: "0" }, // 30s < 60s
      { punch_type: "tool_call", punch_key: "read_file", observed_at: new Date(now + 50_000).toISOString(), cost: "0" }, // 20s < 60s
    ];

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return punches;
      return [];
    });

    const findings = await audit.detectStalls("session-1");
    expect(findings).toHaveLength(0);
  });

  it("returns no findings with fewer than 2 punches", async () => {
    const { audit: audit0 } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return [];
      return [];
    });
    expect(await audit0.detectStalls("session-1")).toHaveLength(0);

    const { audit: audit1 } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return [{
        punch_type: "step_complete",
        punch_key: "step_finished",
        observed_at: new Date().toISOString(),
        cost: "0.01",
      }];
      return [];
    });
    expect(await audit1.detectStalls("session-1")).toHaveLength(0);
  });

  it("counts multiple stalls and reports the longest", async () => {
    const now = Date.now();
    const punches = [
      { punch_type: "tool_call", punch_key: "a", observed_at: new Date(now).toISOString(), cost: "0" },
      { punch_type: "tool_call", punch_key: "b", observed_at: new Date(now + 70_000).toISOString(), cost: "0" },     // 70s gap (stall 1)
      { punch_type: "tool_call", punch_key: "c", observed_at: new Date(now + 80_000).toISOString(), cost: "0" },     // 10s gap (ok)
      { punch_type: "tool_call", punch_key: "d", observed_at: new Date(now + 180_000).toISOString(), cost: "0" },    // 100s gap (stall 2, longest)
    ];

    const { audit } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return punches;
      return [];
    });

    const findings = await audit.detectStalls("session-1");

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toHaveProperty("stallCount", 2);
    expect(findings[0].evidence).toHaveProperty("maxGapSeconds", 100);
  });

  it("respects custom maxPunchGapSeconds", async () => {
    const now = Date.now();
    const punches = [
      { punch_type: "tool_call", punch_key: "a", observed_at: new Date(now).toISOString(), cost: "0" },
      { punch_type: "tool_call", punch_key: "b", observed_at: new Date(now + 40_000).toISOString(), cost: "0" }, // 40s gap
    ];

    // With default 60s threshold: no stall
    const { audit: auditDefault } = createMockAudit((sql) => {
      if (sql.includes("ORDER BY observed_at")) return punches;
      return [];
    });
    expect(await auditDefault.detectStalls("session-1")).toHaveLength(0);

    // With custom 30s threshold: stall detected
    const { audit: auditCustom } = createMockAudit(
      (sql) => {
        if (sql.includes("ORDER BY observed_at")) return punches;
        return [];
      },
      { maxPunchGapSeconds: 30 },
    );
    const findings = await auditCustom.detectStalls("session-1");
    expect(findings).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Integration: runAudit verdict logic
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — runAudit verdict", () => {
  /**
   * Build a full mock query handler for runAudit.
   * Controls responses for metrics, timestamps, child_rels, quality gates,
   * punches list, and tool adherence queries.
   */
  function createFullMockHandler(opts: {
    costRow?: Record<string, unknown>;
    timestampRow?: Record<string, unknown>;
    children?: Array<{ child_id: string }>;
    qualityGateCount?: number;
    punches?: unknown[];
    editCount?: number;
    childStatusRows?: Map<string, { punch_count: string; has_quality_gate: string }>;
  }) {
    const {
      costRow = zeroCostRow(),
      timestampRow = zeroTimestampRow(),
      children = [],
      qualityGateCount = 1,
      punches = [],
      editCount = 5,
      childStatusRows = new Map(),
    } = opts;

    return (sql: string, params?: unknown[]): unknown[] => {
      // Session metrics aggregation (SUM cost, step_count, etc.)
      if (sql.includes("SUM(cost)") || sql.includes("COALESCE(SUM(cost)")) {
        return [costRow];
      }
      // Timestamps for duration
      if (sql.includes("MIN(observed_at)")) {
        return [timestampRow];
      }
      // Child relations
      if (sql.includes("child_rels")) {
        return children;
      }
      // Quality gate count
      if (sql.includes("COUNT(*)") && sql.includes("punch_type") && sql.includes("punch_key LIKE")) {
        return [{ count: String(qualityGateCount) }];
      }
      // Tool adherence (edit count) — must come before generic COUNT(*)
      if (sql.includes("COUNT(*)") && sql.includes("write_to_file")) {
        return [{ count: String(editCount) }];
      }
      // Child status (incomplete subtask tree)
      if (sql.includes("COUNT(*)") && sql.includes("punch_type = 'quality_gate'")) {
        const taskId = params?.[0] as string;
        const row = childStatusRows.get(taskId);
        if (row) return [row];
        return [{ punch_count: "10", has_quality_gate: "1" }];
      }
      // Punch list for loop/stall detection
      if (sql.includes("ORDER BY observed_at")) {
        return punches;
      }
      return [];
    };
  }

  it("returns verdict=pass when no findings exist", async () => {
    const handler = createFullMockHandler({
      costRow: {
        total_cost: "0.20",
        step_count: "10",
        tokens_input: "30000",
        tokens_output: "15000",
        tokens_reasoning: "5000",
        punch_count: "40",
      },
      timestampRow: {
        min_at: "2025-01-01T00:00:00Z",
        max_at: "2025-01-01T00:05:00Z",
      },
      qualityGateCount: 1,
      editCount: 10,
      punches: [
        { punch_type: "tool_call", punch_key: "edit_file", observed_at: "2025-01-01T00:00:00Z", cost: "0" },
        { punch_type: "tool_call", punch_key: "read_file", observed_at: "2025-01-01T00:00:10Z", cost: "0" },
      ],
    });

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-clean");

    expect(report.verdict).toBe("pass");
    expect(report.findings).toHaveLength(0);
    expect(report.sessionId).toBe("session-clean");
    expect(report.auditedAt).toBeInstanceOf(Date);
    expect(report.metrics.totalCost).toBe(0.20);
    expect(report.metrics.stepCount).toBe(10);
    expect(report.metrics.punchCount).toBe(40);
  });

  it("returns verdict=warn when only non-critical findings exist", async () => {
    // High cost-per-100k but below absolute threshold → warning only
    const handler = createFullMockHandler({
      costRow: {
        total_cost: "0.50",
        step_count: "10",
        tokens_input: "50000",
        tokens_output: "25000",
        tokens_reasoning: "5000",
        punch_count: "40",
      },
      timestampRow: {
        min_at: "2025-01-01T00:00:00Z",
        max_at: "2025-01-01T00:05:00Z",
      },
      qualityGateCount: 1,
      editCount: 10,
      punches: [
        { punch_type: "tool_call", punch_key: "edit_file", observed_at: "2025-01-01T00:00:00Z", cost: "0" },
        { punch_type: "tool_call", punch_key: "read_file", observed_at: "2025-01-01T00:00:10Z", cost: "0" },
      ],
    });

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-warn");

    expect(report.verdict).toBe("warn");
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.severity !== "critical")).toBe(true);
  });

  it("returns verdict=fail when any critical finding exists", async () => {
    // Missing quality gates → critical findings
    const handler = createFullMockHandler({
      costRow: {
        total_cost: "0.20",
        step_count: "10",
        tokens_input: "30000",
        tokens_output: "15000",
        tokens_reasoning: "5000",
        punch_count: "40",
      },
      timestampRow: {
        min_at: "2025-01-01T00:00:00Z",
        max_at: "2025-01-01T00:05:00Z",
      },
      qualityGateCount: 0, // all gates missing → critical
      editCount: 10,
      punches: [
        { punch_type: "tool_call", punch_key: "edit_file", observed_at: "2025-01-01T00:00:00Z", cost: "0" },
        { punch_type: "tool_call", punch_key: "read_file", observed_at: "2025-01-01T00:00:10Z", cost: "0" },
      ],
    });

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-fail");

    expect(report.verdict).toBe("fail");
    expect(report.findings.some((f) => f.severity === "critical")).toBe(true);
  });

  it("includes metrics in the report", async () => {
    const handler = createFullMockHandler({
      costRow: {
        total_cost: "1.25",
        step_count: "30",
        tokens_input: "50000",
        tokens_output: "25000",
        tokens_reasoning: "10000",
        punch_count: "120",
      },
      timestampRow: {
        min_at: "2025-01-01T00:00:00Z",
        max_at: "2025-01-01T00:10:00Z",
      },
      children: [{ child_id: "child-1" }, { child_id: "child-2" }],
      qualityGateCount: 1,
      editCount: 10,
      punches: [],
    });

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-metrics");

    expect(report.metrics.totalCost).toBe(1.25);
    expect(report.metrics.stepCount).toBe(30);
    expect(report.metrics.punchCount).toBe(120);
    expect(report.metrics.tokensInput).toBe(50000);
    expect(report.metrics.tokensOutput).toBe(25000);
    expect(report.metrics.tokensReasoning).toBe(10000);
    expect(report.metrics.childCount).toBe(2);
    expect(report.metrics.durationMs).toBe(600_000); // 10 minutes
  });

  it("aggregates findings from all detectors", async () => {
    // Set up scenario with multiple anomaly types:
    // - Missing quality gates (critical)
    // - High cost (critical)
    // - Excessive steps (critical)
    // - Edit count below minimum (warning)
    const handler = createFullMockHandler({
      costRow: {
        total_cost: "5.00",
        step_count: "60",
        tokens_input: "100000",
        tokens_output: "50000",
        tokens_reasoning: "10000",
        punch_count: "200",
      },
      timestampRow: {
        min_at: "2025-01-01T00:00:00Z",
        max_at: "2025-01-01T01:00:00Z",
      },
      qualityGateCount: 0,
      editCount: 0,
      punches: Array.from({ length: 60 }, (_, i) => ({
        punch_type: "step_complete",
        punch_key: "step_finished",
        observed_at: new Date(Date.now() + i * 1000).toISOString(),
        cost: "0.01",
      })),
    });

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-everything-wrong");

    expect(report.verdict).toBe("fail");

    const types = report.findings.map((f) => f.type);
    expect(types).toContain("missing_quality_gate");
    expect(types).toContain("cost_anomaly");
    expect(types).toContain("loop_signature"); // step count > 50
    expect(types).toContain("tool_adherence_deviation"); // edit count 0 < min 1
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Edge cases: empty results, zero tokens, no punches
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — edge cases", () => {
  it("handles session with zero tokens and zero cost", async () => {
    const handler = (sql: string): unknown[] => {
      if (sql.includes("SUM(cost)") || sql.includes("COALESCE(SUM(cost)")) {
        return [zeroCostRow()];
      }
      if (sql.includes("MIN(observed_at)")) {
        return [zeroTimestampRow()];
      }
      if (sql.includes("child_rels")) return [];
      if (sql.includes("COUNT(*)") && sql.includes("punch_key LIKE")) {
        return [{ count: "1" }]; // gates present to avoid missing_quality_gate noise
      }
      if (sql.includes("COUNT(*)") && sql.includes("write_to_file")) {
        return [{ count: "5" }]; // within range
      }
      if (sql.includes("ORDER BY observed_at")) return [];
      return [];
    };

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-zero");

    expect(report.metrics.totalCost).toBe(0);
    expect(report.metrics.tokensInput).toBe(0);
    expect(report.metrics.tokensOutput).toBe(0);
    expect(report.metrics.durationMs).toBe(0);
    // No cost anomaly because zero cost is within budget
    expect(report.findings.filter((f) => f.type === "cost_anomaly")).toHaveLength(0);
  });

  it("handles session with no punches at all", async () => {
    const handler = (sql: string): unknown[] => {
      if (sql.includes("SUM(cost)") || sql.includes("COALESCE(SUM(cost)")) {
        return [zeroCostRow()];
      }
      if (sql.includes("MIN(observed_at)")) {
        return [zeroTimestampRow()];
      }
      if (sql.includes("child_rels")) return [];
      if (sql.includes("COUNT(*)") && sql.includes("punch_key LIKE")) {
        return [{ count: "0" }]; // no quality gates
      }
      if (sql.includes("COUNT(*)") && sql.includes("write_to_file")) {
        return [{ count: "0" }]; // no edits
      }
      if (sql.includes("ORDER BY observed_at")) return [];
      return [];
    };

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-empty");

    // Missing quality gates are still reported (that's the point)
    expect(report.findings.filter((f) => f.type === "missing_quality_gate").length).toBeGreaterThan(0);
    // Tool adherence below min
    expect(report.findings.filter((f) => f.type === "tool_adherence_deviation")).toHaveLength(1);
    // No stalls (< 2 punches)
    expect(report.findings.filter((f) => f.type === "stall_detected")).toHaveLength(0);
    // No loop signature (no punches)
    expect(report.findings.filter((f) => f.type === "loop_signature")).toHaveLength(0);
  });

  it("handles null values in metrics rows", async () => {
    const handler = (sql: string): unknown[] => {
      if (sql.includes("SUM(cost)") || sql.includes("COALESCE(SUM(cost)")) {
        return [{
          total_cost: null,
          step_count: null,
          tokens_input: null,
          tokens_output: null,
          tokens_reasoning: null,
          punch_count: null,
        }];
      }
      if (sql.includes("MIN(observed_at)")) {
        return [{ min_at: null, max_at: null }];
      }
      if (sql.includes("child_rels")) return [];
      if (sql.includes("COUNT(*)") && sql.includes("punch_key LIKE")) {
        return [{ count: "1" }];
      }
      if (sql.includes("COUNT(*)") && sql.includes("write_to_file")) {
        return [{ count: "5" }];
      }
      if (sql.includes("ORDER BY observed_at")) return [];
      return [];
    };

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-null");

    expect(report.metrics.totalCost).toBe(0);
    expect(report.metrics.stepCount).toBe(0);
    expect(report.metrics.punchCount).toBe(0);
    expect(report.metrics.durationMs).toBe(0);
  });

  it("handles string-typed numeric values from MySQL", async () => {
    const handler = (sql: string): unknown[] => {
      if (sql.includes("SUM(cost)") || sql.includes("COALESCE(SUM(cost)")) {
        return [{
          total_cost: "0.50",
          step_count: "15",
          tokens_input: "30000",
          tokens_output: "15000",
          tokens_reasoning: "5000",
          punch_count: "50",
        }];
      }
      if (sql.includes("MIN(observed_at)")) {
        return [{
          min_at: "2025-01-01T00:00:00Z",
          max_at: "2025-01-01T00:05:00Z",
        }];
      }
      if (sql.includes("child_rels")) return [];
      if (sql.includes("COUNT(*)") && sql.includes("punch_key LIKE")) {
        return [{ count: "1" }];
      }
      if (sql.includes("COUNT(*)") && sql.includes("write_to_file")) {
        return [{ count: "10" }];
      }
      if (sql.includes("ORDER BY observed_at")) return [];
      return [];
    };

    const { audit } = createMockAudit(handler);
    const report = await audit.runAudit("session-strings");

    expect(report.metrics.totalCost).toBe(0.50);
    expect(report.metrics.stepCount).toBe(15);
    expect(report.metrics.tokensInput).toBe(30000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Connection lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("SessionAudit — connection lifecycle", () => {
  it("throws when running audit without connection", async () => {
    const audit = new SessionAudit(
      { host: "127.0.0.1", port: 3307, database: "test_db" },
    );

    await expect(audit.runAudit("any")).rejects.toThrow("SessionAudit is not connected");
  });

  it("throws when calling detector without connection", async () => {
    const audit = new SessionAudit(
      { host: "127.0.0.1", port: 3307, database: "test_db" },
    );

    await expect(audit.detectMissingQualityGates("any")).rejects.toThrow(
      "SessionAudit is not connected",
    );
  });

  it("getConfig returns a copy of the configuration", () => {
    const audit = new SessionAudit(
      { host: "127.0.0.1", port: 3307, database: "test_db" },
      { maxExpectedSteps: 100 },
    );
    const config = audit.getConfig();
    expect(config.maxExpectedSteps).toBe(100);
    expect(config.cheapZonePercentileUsd).toBe(DEFAULT_AUDIT_CONFIG.cheapZonePercentileUsd);
  });

  it("disconnect is safe to call without connection", async () => {
    const audit = new SessionAudit(
      { host: "127.0.0.1", port: 3307, database: "test_db" },
    );

    // Should not throw
    await expect(audit.disconnect()).resolves.not.toThrow();
  });

  it("disconnect calls connection.end()", async () => {
    const { audit, mockConn } = createMockAudit(() => []);

    await audit.disconnect();
    expect(mockConn.end).toHaveBeenCalledOnce();
  });
});
