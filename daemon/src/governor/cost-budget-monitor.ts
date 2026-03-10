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

import type { DoltConfig } from "../writer/index.js";
import type { LoopClassification, LoopDetection, SessionMetrics } from "./types.js";
import {
  BaseDoltClient,
  parseEnvFloat,
  parseEnvInt,
} from "./dolt-utils.js";

// ── Configuration ──

/** Configurable cost budget thresholds. */
export interface CostBudgetConfig {
  /** Maximum cost in USD per session before intervention (default: $1). */
  maxSessionCostUsd: number;
  /** Maximum step count per session before intervention (default: 50). */
  maxSessionSteps: number;
  /** Maximum aggregate cost in USD across a subtask tree (default: $5). */
  maxTreeCostUsd: number;
  /** Warning threshold as fraction of max cost, 0–1 inclusive (default: 0.8). */
  warningThresholdRatio: number;
}

export const DEFAULT_COST_BUDGET_CONFIG: CostBudgetConfig = {
  maxSessionCostUsd: 1,
  maxSessionSteps: 50,
  maxTreeCostUsd: 5,
  warningThresholdRatio: 0.8,
};

/**
 * Load cost budget config from environment variables, falling back to defaults.
 *
 * Environment variables:
 *   GOVERNOR_MAX_SESSION_COST_USD  — per-session cost cap (default: 1)
 *   GOVERNOR_MAX_SESSION_STEPS     — per-session step cap (default: 50)
 *   GOVERNOR_MAX_TREE_COST_USD     — per-subtask-tree cost cap (default: 5)
 *   GOVERNOR_WARNING_THRESHOLD     — warning ratio 0–1 inclusive (default: 0.80)
 */
export function loadCostBudgetConfig(
  overrides?: Partial<CostBudgetConfig>,
): CostBudgetConfig {
  /** Parse a ratio that must be in [0, 1]. */
  const parseRatio = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (raw == null || raw === "") return fallback;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
  };

  return {
    maxSessionCostUsd: overrides?.maxSessionCostUsd
      ?? parseEnvFloat("GOVERNOR_MAX_SESSION_COST_USD", DEFAULT_COST_BUDGET_CONFIG.maxSessionCostUsd),
    maxSessionSteps: overrides?.maxSessionSteps
      ?? parseEnvInt("GOVERNOR_MAX_SESSION_STEPS", DEFAULT_COST_BUDGET_CONFIG.maxSessionSteps),
    maxTreeCostUsd: overrides?.maxTreeCostUsd
      ?? parseEnvFloat("GOVERNOR_MAX_TREE_COST_USD", DEFAULT_COST_BUDGET_CONFIG.maxTreeCostUsd),
    warningThresholdRatio: overrides?.warningThresholdRatio
      ?? parseRatio("GOVERNOR_WARNING_THRESHOLD", DEFAULT_COST_BUDGET_CONFIG.warningThresholdRatio),
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
export class CostBudgetMonitor extends BaseDoltClient {
  private readonly budgetConfig: CostBudgetConfig;

  constructor(
    doltConfig: DoltConfig,
    budgetConfig?: Partial<CostBudgetConfig>,
  ) {
    super(doltConfig);
    this.budgetConfig = loadCostBudgetConfig(budgetConfig);
  }

  /** Get the current budget configuration (useful for logging/debugging). */
  getConfig(): Readonly<CostBudgetConfig> {
    return { ...this.budgetConfig };
  }

  /**
   * Query Dolt for the cost accumulation of a single session.
   */
  async getSessionCost(sessionId: string): Promise<SessionCostSnapshot> {
    const agg = await this.queryCostAgg(sessionId);
    return { sessionId, ...agg };
  }

  /**
   * Get all child session IDs for a parent (recursive tree walk).
   * Uses child_rels table for traversal.
   */
  async getTreeSessionIds(rootSessionId: string): Promise<string[]> {
    const visited = new Set<string>([rootSessionId]);
    const queue = [rootSessionId];

    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = await this.queryChildIds(parentId);
      for (const childId of children) {
        if (!visited.has(childId)) {
          visited.add(childId);
          queue.push(childId);
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
    const breaches = this.detectBreaches(sessionSnapshot, treeSnapshot);

    const { status, intervention } = breaches.length > 0
      ? this.buildBreachResult(sessionId, sessionSnapshot, breaches)
      : this.evaluateWarningStatus(sessionSnapshot, treeSnapshot);

    return {
      status,
      breaches,
      sessionSnapshot,
      treeSnapshot,
      intervention,
    };
  }

  /** Evaluate all threshold conditions and return any breaches. */
  private detectBreaches(
    session: SessionCostSnapshot,
    tree: TreeCostSnapshot,
  ): CostBreach[] {
    const breaches: CostBreach[] = [];

    if (session.totalCost > this.budgetConfig.maxSessionCostUsd) {
      breaches.push({
        type: "session_cost",
        current: session.totalCost,
        limit: this.budgetConfig.maxSessionCostUsd,
        reason: `Session cost $${session.totalCost.toFixed(2)} exceeds cap $${this.budgetConfig.maxSessionCostUsd.toFixed(2)}`,
      });
    }

    if (session.stepCount > this.budgetConfig.maxSessionSteps) {
      breaches.push({
        type: "session_steps",
        current: session.stepCount,
        limit: this.budgetConfig.maxSessionSteps,
        reason: `Session step count ${session.stepCount} exceeds cap ${this.budgetConfig.maxSessionSteps}`,
      });
    }

    if (tree.totalCost > this.budgetConfig.maxTreeCostUsd) {
      breaches.push({
        type: "tree_cost",
        current: tree.totalCost,
        limit: this.budgetConfig.maxTreeCostUsd,
        reason: `Subtask tree cost $${tree.totalCost.toFixed(2)} exceeds cap $${this.budgetConfig.maxTreeCostUsd.toFixed(2)} (${tree.sessionCount} sessions)`,
      });
    }

    return breaches;
  }

  /** Build the intervention directive for a breach. */
  private buildBreachResult(
    sessionId: string,
    session: SessionCostSnapshot,
    breaches: CostBreach[],
  ): { status: BudgetStatus; intervention: GovernorIntervention } {
    const primaryBreach = breaches[0];
    const classification: LoopClassification =
      primaryBreach.type === "session_steps" ? "step_overflow" : "cost_overflow";
    const action: GovernorIntervention["action"] =
      primaryBreach.type === "tree_cost" ? "abort_tree" : "kill_session";

    const metrics: SessionMetrics = {
      stepCount: session.stepCount,
      totalCost: session.totalCost,
      toolCalls: session.punchCount,
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

    return {
      status: "breach",
      intervention: {
        action,
        classification,
        reason: detection.reason,
        targetSessionId: sessionId,
        detection,
      },
    };
  }

  /** Check if any metric is approaching the warning threshold. */
  private evaluateWarningStatus(
    session: SessionCostSnapshot,
    tree: TreeCostSnapshot,
  ): { status: BudgetStatus; intervention: null } {
    const sessionCostRatio = this.budgetConfig.maxSessionCostUsd > 0
      ? session.totalCost / this.budgetConfig.maxSessionCostUsd
      : 0;
    const treeCostRatio = this.budgetConfig.maxTreeCostUsd > 0
      ? tree.totalCost / this.budgetConfig.maxTreeCostUsd
      : 0;
    const stepRatio = this.budgetConfig.maxSessionSteps > 0
      ? session.stepCount / this.budgetConfig.maxSessionSteps
      : 0;

    const approachingThreshold =
      sessionCostRatio >= this.budgetConfig.warningThresholdRatio ||
      treeCostRatio >= this.budgetConfig.warningThresholdRatio ||
      stepRatio >= this.budgetConfig.warningThresholdRatio;

    return {
      status: approachingThreshold ? "warning" : "ok",
      intervention: null,
    };
  }
}
