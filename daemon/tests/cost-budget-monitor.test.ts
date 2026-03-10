/**
 * Cost Budget Monitor Tests
 *
 * Tests for the governor's cost budget enforcement module that queries
 * Dolt punch data in real-time for cost accumulation per session,
 * applies configurable thresholds, and triggers governor responses.
 *
 * Tests are organized by concern:
 *   1. Configuration loading (env vars + defaults)
 *   2. Session cost queries (single session)
 *   3. Tree cost aggregation (parent + children)
 *   4. Budget check with breaches → governor intervention
 *   5. Budget check with warnings
 *   6. Budget check with no issues
 *   7. Integration with existing governor types
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  CostBudgetMonitor,
  loadCostBudgetConfig,
  DEFAULT_COST_BUDGET_CONFIG,
  type CostBudgetConfig,
} from "../src/governor/cost-budget-monitor.js";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Configuration Loading
// ═══════════════════════════════════════════════════════════════════════════════

describe("loadCostBudgetConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  it("returns defaults when no env vars or overrides provided", () => {
    const config = loadCostBudgetConfig();
    expect(config).toEqual(DEFAULT_COST_BUDGET_CONFIG);
  });

  it("reads env vars when set", () => {
    process.env.GOVERNOR_MAX_SESSION_COST_USD = "2.50";
    process.env.GOVERNOR_MAX_SESSION_STEPS = "75";
    process.env.GOVERNOR_MAX_TREE_COST_USD = "10.00";
    process.env.GOVERNOR_WARNING_THRESHOLD = "0.9";

    const config = loadCostBudgetConfig();
    expect(config.maxSessionCostUsd).toBe(2.5);
    expect(config.maxSessionSteps).toBe(75);
    expect(config.maxTreeCostUsd).toBe(10);
    expect(config.warningThresholdRatio).toBe(0.9);
  });

  it("overrides take precedence over env vars", () => {
    process.env.GOVERNOR_MAX_SESSION_COST_USD = "2.50";

    const config = loadCostBudgetConfig({ maxSessionCostUsd: 3 });
    expect(config.maxSessionCostUsd).toBe(3);
  });

  it("ignores invalid env values and uses defaults", () => {
    process.env.GOVERNOR_MAX_SESSION_COST_USD = "not-a-number";
    process.env.GOVERNOR_MAX_SESSION_STEPS = "-5";
    process.env.GOVERNOR_MAX_TREE_COST_USD = "";

    const config = loadCostBudgetConfig();
    expect(config.maxSessionCostUsd).toBe(DEFAULT_COST_BUDGET_CONFIG.maxSessionCostUsd);
    expect(config.maxSessionSteps).toBe(DEFAULT_COST_BUDGET_CONFIG.maxSessionSteps);
    expect(config.maxTreeCostUsd).toBe(DEFAULT_COST_BUDGET_CONFIG.maxTreeCostUsd);
  });

  it("default per-session cost cap is $1.00", () => {
    expect(DEFAULT_COST_BUDGET_CONFIG.maxSessionCostUsd).toBe(1);
  });

  it("default per-session step cap is 50", () => {
    expect(DEFAULT_COST_BUDGET_CONFIG.maxSessionSteps).toBe(50);
  });

  it("default per-tree cost cap is $5.00", () => {
    expect(DEFAULT_COST_BUDGET_CONFIG.maxTreeCostUsd).toBe(5);
  });

  it("default warning threshold is 0.8 (80%)", () => {
    expect(DEFAULT_COST_BUDGET_CONFIG.warningThresholdRatio).toBe(0.8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2-7. CostBudgetMonitor — Mock-Based Unit Tests
// ═══════════════════════════════════════════════════════════════════════════════
//
// These tests mock the mysql2 connection to test the monitor's logic without
// requiring a live Dolt database. This is the same pattern used by
// punch-card-validator.test.ts.

/** Helper to create a mock MySQL connection that returns configurable query results. */
function createMockConnection(queryResponses: Map<string, unknown[]>) {
  return {
    execute: vi.fn(async (sql: string, _params?: unknown[]) => {
      // Match against query patterns
      for (const [pattern, rows] of queryResponses) {
        if (sql.includes(pattern)) {
          return [rows];
        }
      }
      return [[]];
    }),
    end: vi.fn(async () => {}),
  };
}

/** Build a responses Map for a single leaf session (no children). */
function leafSessionResponses(snapshot: Record<string, unknown>) {
  const responses = new Map<string, unknown[]>();
  responses.set("FROM child_rels", []);
  responses.set("FROM punches", [snapshot]);
  return responses;
}

/**
 * Create a CostBudgetMonitor with a mocked connection.
 * Returns both the monitor and the mock connection for assertions.
 */
function createMockMonitor(
  queryResponses?: Map<string, unknown[]>,
  budgetConfig?: Partial<CostBudgetConfig>,
  customHandler?: (sql: string, params?: unknown[]) => unknown[],
) {
  const mockConn = customHandler
    ? {
        execute: vi.fn(async (sql: string, params?: unknown[]) => [customHandler(sql, params)]),
        end: vi.fn(async () => {}),
      }
    : createMockConnection(queryResponses ?? new Map());
  const monitor = new CostBudgetMonitor(
    { host: "127.0.0.1", port: 3307, database: "test_db" },
    budgetConfig,
  );
  // Inject mock connection via connect override
  (monitor as unknown as { connection: unknown }).connection = mockConn;
  return { monitor, mockConn };
}

// ── Session Cost Queries ──

describe("CostBudgetMonitor — getSessionCost", () => {
  it("returns zero snapshot for session with no punches", async () => {
    const responses = new Map<string, unknown[]>();
    responses.set("FROM punches", [{
      total_cost: "0", step_count: "0", tokens_input: "0",
      tokens_output: "0", tokens_reasoning: "0", punch_count: "0",
    }]);

    const { monitor } = createMockMonitor(responses);
    const snapshot = await monitor.getSessionCost("session-empty");

    expect(snapshot.sessionId).toBe("session-empty");
    expect(snapshot.totalCost).toBe(0);
    expect(snapshot.stepCount).toBe(0);
    expect(snapshot.tokensInput).toBe(0);
    expect(snapshot.tokensOutput).toBe(0);
    expect(snapshot.punchCount).toBe(0);
  });

  it("returns accumulated cost data from punches table", async () => {
    const responses = new Map<string, unknown[]>();
    responses.set("FROM punches", [{
      total_cost: "1.25", step_count: "30", tokens_input: "50000",
      tokens_output: "25000", tokens_reasoning: "10000", punch_count: "120",
    }]);

    const { monitor } = createMockMonitor(responses);
    const snapshot = await monitor.getSessionCost("session-costly");

    expect(snapshot.totalCost).toBe(1.25);
    expect(snapshot.stepCount).toBe(30);
    expect(snapshot.tokensInput).toBe(50000);
    expect(snapshot.tokensOutput).toBe(25000);
    expect(snapshot.tokensReasoning).toBe(10000);
    expect(snapshot.punchCount).toBe(120);
  });

  it("handles null cost values gracefully", async () => {
    const responses = new Map<string, unknown[]>();
    responses.set("FROM punches", [{
      total_cost: null, step_count: null, tokens_input: null,
      tokens_output: null, tokens_reasoning: null, punch_count: "5",
    }]);

    const { monitor } = createMockMonitor(responses);
    const snapshot = await monitor.getSessionCost("session-null");

    expect(snapshot.totalCost).toBe(0);
    expect(snapshot.stepCount).toBe(0);
    expect(snapshot.tokensInput).toBe(0);
    expect(snapshot.punchCount).toBe(5);
  });
});

// ── Tree Cost Aggregation ──

describe("CostBudgetMonitor — getTreeCost", () => {
  it("returns single session when no children exist", async () => {
    const responses = leafSessionResponses({
      total_cost: "0.50", step_count: "10", tokens_input: "20000",
      tokens_output: "10000", tokens_reasoning: "5000", punch_count: "40",
    });

    const { monitor } = createMockMonitor(responses);
    const tree = await monitor.getTreeCost("root-session");

    expect(tree.rootSessionId).toBe("root-session");
    expect(tree.sessionCount).toBe(1);
    expect(tree.totalCost).toBe(0.5);
  });

  it("aggregates cost across parent + children", async () => {
    const parentCost = {
      total_cost: "0.50", step_count: "10", tokens_input: "20000",
      tokens_output: "10000", tokens_reasoning: "5000", punch_count: "40",
    };
    const childCost = {
      total_cost: "0.30", step_count: "8", tokens_input: "15000",
      tokens_output: "8000", tokens_reasoning: "3000", punch_count: "25",
    };

    const { monitor } = createMockMonitor(undefined, undefined, (sql, params) => {
      if (sql.includes("FROM child_rels")) {
        return (params?.[0] === "parent-session") ? [{ child_id: "child-session-1" }] : [];
      }
      if (sql.includes("FROM punches")) {
        if (params?.[0] === "parent-session") return [parentCost];
        if (params?.[0] === "child-session-1") return [childCost];
        return [{ total_cost: "0", step_count: "0", tokens_input: "0", tokens_output: "0", tokens_reasoning: "0", punch_count: "0" }];
      }
      return [];
    });

    const tree = await monitor.getTreeCost("parent-session");

    expect(tree.sessionCount).toBe(2);
    expect(tree.totalCost).toBeCloseTo(0.80, 2);
    expect(tree.totalSteps).toBe(18);
    expect(tree.totalTokensInput).toBe(35000);
    expect(tree.totalTokensOutput).toBe(18000);
  });

  it("handles deep subtask trees (grandchildren)", async () => {
    const costSnapshot = {
      total_cost: "0.25", step_count: "5", tokens_input: "10000",
      tokens_output: "5000", tokens_reasoning: "2000", punch_count: "20",
    };

    const { monitor } = createMockMonitor(undefined, undefined, (sql, params) => {
      if (sql.includes("FROM child_rels")) {
        if (params?.[0] === "root") return [{ child_id: "child-1" }];
        if (params?.[0] === "child-1") return [{ child_id: "grandchild-1" }];
        return [];
      }
      if (sql.includes("FROM punches")) return [costSnapshot];
      return [];
    });

    const tree = await monitor.getTreeCost("root");

    expect(tree.sessionCount).toBe(3);
    expect(tree.totalCost).toBeCloseTo(0.75, 2); // 3 × $0.25
    expect(tree.totalSteps).toBe(15); // 3 × 5
  });
});

// ── Budget Check — Breaches ──

function createBudgetMonitor(
  sessionCost: number,
  sessionSteps: number,
  treeCost: number,
  treeSessionCount: number,
  budgetConfig?: Partial<CostBudgetConfig>,
) {
  const mockConn = {
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM child_rels")) {
        // Return additional child sessions to make tree bigger
        if (treeSessionCount > 1 && params?.[0] === "test-session") {
          const children = [];
          for (let i = 1; i < treeSessionCount; i++) {
            children.push({ child_id: `child-${i}` });
          }
          return [children];
        }
        return [[]];
      }
      if (sql.includes("FROM punches")) {
        const taskId = params?.[0] as string;
        if (taskId === "test-session") {
          return [[{
            total_cost: String(sessionCost),
            step_count: String(sessionSteps),
            tokens_input: "10000",
            tokens_output: "5000",
            tokens_reasoning: "2000",
            punch_count: "50",
          }]];
        }
        // Children share the remaining tree cost equally
        const childCost = treeSessionCount > 1
          ? (treeCost - sessionCost) / (treeSessionCount - 1)
          : 0;
        return [[{
          total_cost: String(childCost),
          step_count: "5",
          tokens_input: "5000",
          tokens_output: "2500",
          tokens_reasoning: "1000",
          punch_count: "20",
        }]];
      }
      return [[]];
    }),
    end: vi.fn(async () => {}),
  };

  const monitor = new CostBudgetMonitor(
    { host: "127.0.0.1", port: 3307, database: "test_db" },
    budgetConfig,
  );
  (monitor as unknown as { connection: unknown }).connection = mockConn;
  return monitor;
}

describe("CostBudgetMonitor — checkBudget breaches", () => {

  it("triggers intervention when session cost exceeds cap", async () => {
    // Session cost $1.50 exceeds default $1.00 cap
    const monitor = createBudgetMonitor(1.50, 10, 1.50, 1);
    const result = await monitor.checkBudget("test-session");

    expect(result.status).toBe("breach");
    expect(result.breaches.length).toBeGreaterThanOrEqual(1);
    expect(result.breaches[0].type).toBe("session_cost");
    expect(result.breaches[0].current).toBe(1.50);
    expect(result.breaches[0].limit).toBe(1);
    expect(result.intervention).not.toBeNull();
    expect(result.intervention!.action).toBe("kill_session");
    expect(result.intervention!.classification).toBe("cost_overflow");
  });

  it("triggers intervention when session steps exceed cap", async () => {
    // 60 steps exceeds default 50 cap
    const monitor = createBudgetMonitor(0.50, 60, 0.50, 1);
    const result = await monitor.checkBudget("test-session");

    expect(result.status).toBe("breach");
    expect(result.breaches.some((b) => b.type === "session_steps")).toBe(true);
    expect(result.intervention).not.toBeNull();
    expect(result.intervention!.classification).toBe("step_overflow");
    expect(result.intervention!.action).toBe("kill_session");
  });

  it("triggers abort_tree when tree cost exceeds cap", async () => {
    // Tree cost $6.00 exceeds default $5.00 cap
    const monitor = createBudgetMonitor(0.50, 10, 6.00, 3);
    const result = await monitor.checkBudget("test-session");

    expect(result.status).toBe("breach");
    expect(result.breaches.some((b) => b.type === "tree_cost")).toBe(true);
    expect(result.intervention).not.toBeNull();
    expect(result.intervention!.action).toBe("abort_tree");
  });

  it("reports multiple breaches simultaneously", async () => {
    // Both session cost and steps exceed caps
    const monitor = createBudgetMonitor(1.50, 60, 1.50, 1);
    const result = await monitor.checkBudget("test-session");

    expect(result.status).toBe("breach");
    expect(result.breaches.length).toBeGreaterThanOrEqual(2);
    const types = result.breaches.map((b) => b.type);
    expect(types).toContain("session_cost");
    expect(types).toContain("session_steps");
  });

  it("intervention detection is compatible with governor types", async () => {
    const monitor = createBudgetMonitor(2.00, 10, 2.00, 1);
    const result = await monitor.checkBudget("test-session");

    expect(result.intervention).not.toBeNull();
    const detection = result.intervention!.detection;

    // Verify the detection is a valid LoopDetection
    expect(detection.sessionId).toBe("test-session");
    expect(detection.classification).toBe("cost_overflow");
    expect(typeof detection.reason).toBe("string");
    expect(detection.metrics).toBeDefined();
    expect(detection.metrics.totalCost).toBe(2);
    expect(detection.detectedAt).toBeInstanceOf(Date);
  });

  it("uses custom thresholds from config overrides", async () => {
    // Session cost $0.30 exceeds custom $0.25 cap
    const monitor = createBudgetMonitor(0.30, 5, 0.30, 1, {
      maxSessionCostUsd: 0.25,
      maxSessionSteps: 100,
      maxTreeCostUsd: 1,
    });
    const result = await monitor.checkBudget("test-session");

    expect(result.status).toBe("breach");
    expect(result.breaches[0].limit).toBe(0.25);
  });
});

// ── Budget Check — Warnings ──

describe("CostBudgetMonitor — checkBudget warnings", () => {
  it("returns warning when session cost approaches threshold", async () => {
    // $0.85 is 85% of $1.00 cap, above 80% warning threshold
    const { monitor } = createMockMonitor(leafSessionResponses({
      total_cost: "0.85", step_count: "20", tokens_input: "30000",
      tokens_output: "15000", tokens_reasoning: "5000", punch_count: "60",
    }));
    const result = await monitor.checkBudget("test-session");

    expect(result.status).toBe("warning");
    expect(result.breaches).toHaveLength(0);
    expect(result.intervention).toBeNull();
  });

  it("returns warning when steps approach threshold", async () => {
    // 42 steps is 84% of 50 cap, above 80% warning threshold
    const { monitor } = createMockMonitor(leafSessionResponses({
      total_cost: "0.30", step_count: "42", tokens_input: "30000",
      tokens_output: "15000", tokens_reasoning: "5000", punch_count: "60",
    }));
    const result = await monitor.checkBudget("test-session");

    expect(result.status).toBe("warning");
    expect(result.intervention).toBeNull();
  });
});

// ── Budget Check — OK ──

describe("CostBudgetMonitor — checkBudget OK", () => {
  it("returns ok when all metrics are within budget", async () => {
    const { monitor } = createMockMonitor(leafSessionResponses({
      total_cost: "0.30", step_count: "10", tokens_input: "15000",
      tokens_output: "8000", tokens_reasoning: "3000", punch_count: "30",
    }));
    const result = await monitor.checkBudget("test-session");

    expect(result.status).toBe("ok");
    expect(result.breaches).toHaveLength(0);
    expect(result.intervention).toBeNull();
    expect(result.sessionSnapshot.totalCost).toBe(0.30);
    expect(result.treeSnapshot.sessionCount).toBe(1);
  });
});

// ── getConfig ──

describe("CostBudgetMonitor — getConfig", () => {
  it("returns the current budget configuration", () => {
    const monitor = new CostBudgetMonitor(
      { host: "127.0.0.1", port: 3307, database: "test_db" },
      { maxSessionCostUsd: 2 },
    );
    const config = monitor.getConfig();
    expect(config.maxSessionCostUsd).toBe(2);
    expect(config.maxSessionSteps).toBe(50); // default
  });
});

// ── Runaway Session Scenario (from real cost data) ──

describe("CostBudgetMonitor — runaway session detection", () => {
  it("catches the 267-step $5.94 runaway from Experiment A (with default thresholds)", async () => {
    // Simulates the runaway session from the bead description:
    // 267 steps, $5.94, 67% of total experiment cost
    const { monitor } = createMockMonitor(leafSessionResponses({
      total_cost: "5.94", step_count: "267", tokens_input: "400000",
      tokens_output: "200000", tokens_reasoning: "100000", punch_count: "534",
    }));
    const result = await monitor.checkBudget("runaway-session");

    expect(result.status).toBe("breach");
    expect(result.intervention).not.toBeNull();
    // Should breach BOTH session cost ($5.94 > $1.00) and session steps (267 > 50)
    const types = result.breaches.map((b) => b.type);
    expect(types).toContain("session_cost");
    expect(types).toContain("session_steps");
  });

  it("well-behaved $0.42 session passes budget check", async () => {
    // Simulates a well-behaved decomposed session: $0.42/100k tokens
    const { monitor } = createMockMonitor(leafSessionResponses({
      total_cost: "0.42", step_count: "15", tokens_input: "70000",
      tokens_output: "30000", tokens_reasoning: "10000", punch_count: "45",
    }));
    const result = await monitor.checkBudget("good-session");

    expect(result.status).toBe("ok");
    expect(result.intervention).toBeNull();
  });
});

// ── Connection lifecycle ──

describe("CostBudgetMonitor — connection lifecycle", () => {
  it("throws when querying without connection", async () => {
    const monitor = new CostBudgetMonitor(
      { host: "127.0.0.1", port: 3307, database: "test_db" },
    );

    await expect(monitor.getSessionCost("any")).rejects.toThrow(
      "CostBudgetMonitor is not connected"
    );
  });
});
