/**
 * Cost Budget Monitor — Real-time cost enforcement via Dolt punch data.
 *
 * Queries the Dolt punches table in real-time to accumulate cost per session,
 * applies configurable thresholds, and returns governor intervention responses
 * on threshold breach. Works across subtask trees (parent + children aggregate).
 *
 * Data source: punches table columns (cost, tokens_input, tokens_output, tokens_reasoning)
 * Tree traversal: child_rels table (parent_id, child_id) for aggregation
 *
 * Design: I/O-bound (Dolt queries). Intended for use in Temporal activities,
 * NOT inside deterministic workflows.
 *
 * Cost curve context (from Experiment A/B, 2026-02-23):
 *   - First 100k tokens: $0.29-0.42 (cheap zone)
 *   - Tokens 100k-200k in same session: $0.64 (2.2x)
 *   - Tokens 200k-300k: $0.83 (2.9x)
 *   - Tokens 300k-400k: $1.22 (4.2x)
 *   - One runaway session (267 steps): $5.94 = 67% of total experiment cost
 *   - Well-behaved decomposed sessions: $0.42/100k tokens (42% cheaper)
 */

import mysql, { type Connection } from "mysql2/promise";

import type { DoltConfig } from "../writer/index.js";
import type { LoopClassification, LoopDetection, SessionMetrics } from "./types.js";

// ── Configuration ──

/** Configurable cost budget thresholds. */
export interface CostBudgetConfig {
  /** Maximum cost in USD per session before intervention (default: $1.00). */
  maxSessionCostUsd: number;
  /** Maximum step count per session before intervention (default: 50). */
  maxSessionSteps: number;
  /** Maximum aggregate cost in USD across a subtask tree (default: $5.00). */
  maxTreeCostUsd: number;
  /** Warning threshold as fraction of max cost (0.0–1.0) (default: 0.8). */
  warningThresholdRatio: number;
}

export const DEFAULT_COST_BUDGET_CONFIG: CostBudgetConfig = {
  maxSessionCostUsd: 1.0,
  maxSessionSteps: 50,
  maxTreeCostUsd: 5.0,
  warningThresholdRatio: 0.8,
};

/**
 * Load cost budget config from environment variables, falling back to defaults.
 *
 * Environment variables:
 *   GOVERNOR_MAX_SESSION_COST_USD  — per-session cost cap (default: 1.00)
 *   GOVERNOR_MAX_SESSION_STEPS     — per-session step cap (default: 50)
 *   GOVERNOR_MAX_TREE_COST_USD     — per-subtask-tree cost cap (default: 5.00)
 *   GOVERNOR_WARNING_THRESHOLD     — warning ratio 0.0-1.0 (default: 0.80)
 */
export function loadCostBudgetConfig(
  overrides?: Partial<CostBudgetConfig>,
): CostBudgetConfig {
  const env = process.env;

  const parseFloat_ = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw == null || raw === "") return fallback;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const parseInt_ = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw == null || raw === "") return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    maxSessionCostUsd: overrides?.maxSessionCostUsd
      ?? parseFloat_("GOVERNOR_MAX_SESSION_COST_USD", DEFAULT_COST_BUDGET_CONFIG.maxSessionCostUsd),
    maxSessionSteps: overrides?.maxSessionSteps
      ?? parseInt_("GOVERNOR_MAX_SESSION_STEPS", DEFAULT_COST_BUDGET_CONFIG.maxSessionSteps),
    maxTreeCostUsd: overrides?.maxTreeCostUsd
      ?? parseFloat_("GOVERNOR_MAX_TREE_COST_USD", DEFAULT_COST_BUDGET_CONFIG.maxTreeCostUsd),
    warningThresholdRatio: overrides?.warningThresholdRatio
      ?? parseFloat_("GOVERNOR_WARNING_THRESHOLD", DEFAULT_COST_BUDGET_CONFIG.warningThresholdRatio),
  };
}

// ── Query Results ──

/** Cost accumulation snapshot for a single session. */
export interface SessionCostSnapshot {
  sessionId: string;
  totalCost: number;
  stepCount: number;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  punchCount: number;
}

/** Cost accumulation snapshot for a subtask tree. */
export interface TreeCostSnapshot {
  rootSessionId: string;
  totalCost: number;
  totalSteps: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalTokensReasoning: number;
  sessionCount: number;
  sessions: SessionCostSnapshot[];
}

// ── Budget Check Result ──

export type BudgetStatus = "ok" | "warning" | "breach";

export interface CostBudgetCheckResult {
  status: BudgetStatus;
  /** Which threshold(s) were breached. Empty if status is "ok". */
  breaches: CostBreach[];
  /** Session-level cost snapshot. */
  sessionSnapshot: SessionCostSnapshot;
  /** Tree-level cost snapshot (includes children). */
  treeSnapshot: TreeCostSnapshot;
  /** Governor intervention response (null if no breach). */
  intervention: GovernorIntervention | null;
}

export interface CostBreach {
  type: "session_cost" | "session_steps" | "tree_cost";
  current: number;
  limit: number;
  /** Human-readable explanation. */
  reason: string;
}

/**
 * Governor intervention response — the action to take on budget breach.
 * This is NOT just a log/alert; it's a directive that the caller must act on.
 */
export interface GovernorIntervention {
  /** The action the governor directs. */
  action: "kill_session" | "abort_tree" | "throttle";
  /** Which loop classification this maps to (for kill switch integration). */
  classification: LoopClassification;
  /** Human-readable reason for the intervention. */
  reason: string;
  /** The session to target. */
  targetSessionId: string;
  /** Full detection payload (compatible with existing governor kill pipeline). */
  detection: LoopDetection;
}

// ── Monitor Implementation ──

/** Row shape from Dolt cost aggregation queries. */
interface CostAggRow {
  total_cost: string | number | null;
  step_count: string | number | null;
  tokens_input: string | number | null;
  tokens_output: string | number | null;
  tokens_reasoning: string | number | null;
  punch_count: string | number | null;
}

interface ChildRow {
  child_id: string;
}

function toNumber(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Cost Budget Monitor — queries Dolt in real-time and evaluates cost budgets.
 *
 * Usage:
 *   const monitor = new CostBudgetMonitor(doltConfig, budgetConfig);
 *   await monitor.connect();
 *   const result = await monitor.checkBudget(sessionId);
 *   if (result.intervention) { ... kill session ... }
 *   await monitor.disconnect();
 */
export class CostBudgetMonitor {
  private connection: Connection | null = null;
  private readonly budgetConfig: CostBudgetConfig;

  constructor(
    private readonly doltConfig: DoltConfig,
    budgetConfig?: Partial<CostBudgetConfig>,
  ) {
    this.budgetConfig = loadCostBudgetConfig(budgetConfig);
  }

  async connect(): Promise<void> {
    this.connection = await mysql.createConnection({
      host: this.doltConfig.host,
      port: this.doltConfig.port,
      database: this.doltConfig.database,
      user: this.doltConfig.user ?? "root",
      password: this.doltConfig.password,
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  private requireConnection(): Connection {
    if (!this.connection) {
      throw new Error("CostBudgetMonitor is not connected");
    }
    return this.connection;
  }

  /** Get the current budget configuration (useful for logging/debugging). */
  getConfig(): Readonly<CostBudgetConfig> {
    return { ...this.budgetConfig };
  }

  /**
   * Query Dolt for the cost accumulation of a single session.
   */
  async getSessionCost(sessionId: string): Promise<SessionCostSnapshot> {
    const conn = this.requireConnection();

    const [rowsUnknown] = await conn.execute(
      `SELECT
         COALESCE(SUM(cost), 0)             AS total_cost,
         SUM(CASE WHEN punch_type = 'step_complete' AND punch_key = 'step_finished' THEN 1 ELSE 0 END) AS step_count,
         COALESCE(SUM(tokens_input), 0)     AS tokens_input,
         COALESCE(SUM(tokens_output), 0)    AS tokens_output,
         COALESCE(SUM(tokens_reasoning), 0) AS tokens_reasoning,
         COUNT(*)                            AS punch_count
       FROM punches
       WHERE task_id = ?`,
      [sessionId],
    );

    const rows = rowsUnknown as CostAggRow[];
    const row = rows[0];

    return {
      sessionId,
      totalCost: toNumber(row?.total_cost),
      stepCount: toNumber(row?.step_count),
      tokensInput: toNumber(row?.tokens_input),
      tokensOutput: toNumber(row?.tokens_output),
      tokensReasoning: toNumber(row?.tokens_reasoning),
      punchCount: toNumber(row?.punch_count),
    };
  }

  /**
   * Get all child session IDs for a parent (recursive tree walk).
   * Uses child_rels table for traversal.
   */
  async getTreeSessionIds(rootSessionId: string): Promise<string[]> {
    const conn = this.requireConnection();
    const visited = new Set<string>([rootSessionId]);
    const queue = [rootSessionId];

    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const [rowsUnknown] = await conn.execute(
        `SELECT child_id FROM child_rels WHERE parent_id = ?`,
        [parentId],
      );
      const rows = rowsUnknown as ChildRow[];
      for (const row of rows) {
        if (!visited.has(row.child_id)) {
          visited.add(row.child_id);
          queue.push(row.child_id);
        }
      }
    }

    return [...visited];
  }

  /**
   * Query Dolt for the aggregate cost across a subtask tree.
   */
  async getTreeCost(rootSessionId: string): Promise<TreeCostSnapshot> {
    const sessionIds = await this.getTreeSessionIds(rootSessionId);
    const sessions: SessionCostSnapshot[] = [];

    for (const sid of sessionIds) {
      sessions.push(await this.getSessionCost(sid));
    }

    return {
      rootSessionId,
      totalCost: sessions.reduce((sum, s) => sum + s.totalCost, 0),
      totalSteps: sessions.reduce((sum, s) => sum + s.stepCount, 0),
      totalTokensInput: sessions.reduce((sum, s) => sum + s.tokensInput, 0),
      totalTokensOutput: sessions.reduce((sum, s) => sum + s.tokensOutput, 0),
      totalTokensReasoning: sessions.reduce((sum, s) => sum + s.tokensReasoning, 0),
      sessionCount: sessions.length,
      sessions,
    };
  }

  /**
   * Check cost budgets for a session and its subtask tree.
   * Returns the check result including any governor intervention directive.
   */
  async checkBudget(sessionId: string): Promise<CostBudgetCheckResult> {
    const sessionSnapshot = await this.getSessionCost(sessionId);
    const treeSnapshot = await this.getTreeCost(sessionId);
    const breaches: CostBreach[] = [];

    // Check per-session cost cap
    if (sessionSnapshot.totalCost > this.budgetConfig.maxSessionCostUsd) {
      breaches.push({
        type: "session_cost",
        current: sessionSnapshot.totalCost,
        limit: this.budgetConfig.maxSessionCostUsd,
        reason: `Session cost $${sessionSnapshot.totalCost.toFixed(2)} exceeds cap $${this.budgetConfig.maxSessionCostUsd.toFixed(2)}`,
      });
    }

    // Check per-session step cap
    if (sessionSnapshot.stepCount > this.budgetConfig.maxSessionSteps) {
      breaches.push({
        type: "session_steps",
        current: sessionSnapshot.stepCount,
        limit: this.budgetConfig.maxSessionSteps,
        reason: `Session step count ${sessionSnapshot.stepCount} exceeds cap ${this.budgetConfig.maxSessionSteps}`,
      });
    }

    // Check per-tree cost cap (aggregate)
    if (treeSnapshot.totalCost > this.budgetConfig.maxTreeCostUsd) {
      breaches.push({
        type: "tree_cost",
        current: treeSnapshot.totalCost,
        limit: this.budgetConfig.maxTreeCostUsd,
        reason: `Subtask tree cost $${treeSnapshot.totalCost.toFixed(2)} exceeds cap $${this.budgetConfig.maxTreeCostUsd.toFixed(2)} (${treeSnapshot.sessionCount} sessions)`,
      });
    }

    // Determine status
    let status: BudgetStatus = "ok";
    let intervention: GovernorIntervention | null = null;

    if (breaches.length > 0) {
      status = "breach";
      const primaryBreach = breaches[0];
      const classification: LoopClassification =
        primaryBreach.type === "session_steps" ? "step_overflow" : "cost_overflow";
      const action: GovernorIntervention["action"] =
        primaryBreach.type === "tree_cost" ? "abort_tree" : "kill_session";

      const metrics: SessionMetrics = {
        stepCount: sessionSnapshot.stepCount,
        totalCost: sessionSnapshot.totalCost,
        toolCalls: sessionSnapshot.punchCount,
        recentTools: [],
        uniqueSourceHashes: 0,
        elapsedMs: 0,
      };

      const detection: LoopDetection = {
        sessionId,
        classification,
        reason: breaches.map((b) => b.reason).join("; "),
        metrics,
        detectedAt: new Date(),
      };

      intervention = {
        action,
        classification,
        reason: detection.reason,
        targetSessionId: sessionId,
        detection,
      };
    } else {
      // Check for warning threshold
      const sessionCostRatio = this.budgetConfig.maxSessionCostUsd > 0
        ? sessionSnapshot.totalCost / this.budgetConfig.maxSessionCostUsd
        : 0;
      const treeCostRatio = this.budgetConfig.maxTreeCostUsd > 0
        ? treeSnapshot.totalCost / this.budgetConfig.maxTreeCostUsd
        : 0;
      const stepRatio = this.budgetConfig.maxSessionSteps > 0
        ? sessionSnapshot.stepCount / this.budgetConfig.maxSessionSteps
        : 0;

      if (
        sessionCostRatio >= this.budgetConfig.warningThresholdRatio ||
        treeCostRatio >= this.budgetConfig.warningThresholdRatio ||
        stepRatio >= this.budgetConfig.warningThresholdRatio
      ) {
        status = "warning";
      }
    }

    return {
      status,
      breaches,
      sessionSnapshot,
      treeSnapshot,
      intervention,
    };
  }
}
