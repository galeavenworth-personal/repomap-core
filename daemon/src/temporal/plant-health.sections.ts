/**
 * Plant Health Section Collectors — Dolt-dependent health report sections.
 *
 * Each function independently collects data for one section of the plant
 * health report. Failures are reported in the result structure, never thrown.
 *
 * Sections in this module (all require a mysql2 Connection):
 *   1. Punch Card Status — per active session step count, cost, tool adherence
 *   2. Governor Status   — sessions under intervention, active line fitters
 *   3. Cost Summary      — total spend, per-session breakdown, cheap zone
 *   4. Subtask Tree Health — parent-child completeness, orphaned sessions
 */

import type { Connection } from "mysql2/promise";

import type {
  PunchCardStatus,
  PunchCardSessionStatus,
  GovernorStatus,
  GovernorSessionIntervention,
  CostSummaryStatus,
  SessionCostEntry,
  CostZone,
  SubtaskTreeStatus,
  SubtaskTreeEntry,
} from "./plant-health.types.js";

// ── Dolt Row Types (module-local) ──

interface ActiveSessionRow {
  task_id: string;
  step_count: string | number;
  total_cost: string | number;
  tool_calls: string | number;
  edit_count: string | number;
}

interface CostSessionRow {
  task_id: string;
  total_cost: string | number;
  tokens_input: string | number;
  tokens_output: string | number;
}

interface ChildStatusRow {
  child_id: string;
  punch_count: string | number;
  has_quality_gate: string | number;
}

interface InterventionRow {
  task_id: string;
  total_cost: string | number;
  step_count: string | number;
}

interface ParentRow {
  parent_id: string;
}

// ── Helpers ──

/** Safely coerce a MySQL numeric value to a JS number (0 on null/NaN). */
function toNum(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Classify cost per 100k tokens into a zone. */
function classifyCostZone(
  costPer100k: number | null,
  cheapThreshold: number,
  balloonedThreshold: number,
): CostZone {
  if (costPer100k == null) return "cheap"; // no data = assume cheap
  if (costPer100k <= cheapThreshold) return "cheap";
  if (costPer100k <= balloonedThreshold) return "moderate";
  return "ballooned";
}

// ── Section Collectors ──

/**
 * Collect punch card status for active sessions.
 *
 * Queries Dolt for sessions with recent punches (last 24 hours)
 * and computes per-session metrics.
 */
export async function collectPunchCardStatus(
  conn: Connection,
): Promise<PunchCardStatus> {
  try {
    const [rows] = await conn.execute(
      `SELECT
         task_id,
         SUM(CASE WHEN punch_type = 'step_complete' AND punch_key = 'step_finished' THEN 1 ELSE 0 END) AS step_count,
         COALESCE(SUM(cost), 0) AS total_cost,
         SUM(CASE WHEN punch_type = 'tool_call' THEN 1 ELSE 0 END) AS tool_calls,
         SUM(CASE WHEN punch_type = 'tool_call' AND punch_key IN ('write_to_file', 'edit_file', 'apply_diff') THEN 1 ELSE 0 END) AS edit_count
       FROM punches
       WHERE observed_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY task_id
       ORDER BY MAX(observed_at) DESC
       LIMIT 50`,
    );

    const sessionRows = rows as ActiveSessionRow[];
    const activeSessions: PunchCardSessionStatus[] = sessionRows.map((r) => {
      const toolCalls = toNum(r.tool_calls);
      const editCount = toNum(r.edit_count);
      const overheadToolCount = toolCalls - editCount;
      return {
        sessionId: r.task_id,
        stepCount: toNum(r.step_count),
        totalCost: toNum(r.total_cost),
        toolCalls,
        editCount,
        overheadToolCount,
        toolAdherenceRatio: toolCalls > 0 ? editCount / toolCalls : null,
      };
    });

    const anyUnhealthy = activeSessions.some((s) => s.stepCount > 50);
    return {
      status: activeSessions.length === 0 ? "unknown" : anyUnhealthy ? "degraded" : "ok",
      data: {
        activeSessions,
        totalActiveSessions: activeSessions.length,
      },
      error: null,
    };
  } catch (e) {
    return {
      status: "unknown",
      data: null,
      error: `Failed to query punch card status: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Collect governor status — sessions under intervention and active fitters.
 *
 * Queries Dolt for sessions whose cost or step count exceeds governor thresholds.
 */
export async function collectGovernorStatus(
  conn: Connection,
): Promise<GovernorStatus> {
  try {
    // Find sessions that exceed cost or step thresholds
    // Using the default governor thresholds as reference
    const maxCostUsd = 5;
    const maxSteps = 200;

    const [interventionRows] = await conn.execute(
      `SELECT
         task_id,
         COALESCE(SUM(cost), 0) AS total_cost,
         SUM(CASE WHEN punch_type = 'step_complete' AND punch_key = 'step_finished' THEN 1 ELSE 0 END) AS step_count
       FROM punches
       WHERE observed_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY task_id
       HAVING total_cost > ? OR step_count > ?`,
      [maxCostUsd, maxSteps],
    );

    const rows = interventionRows as InterventionRow[];
    const interventions: GovernorSessionIntervention[] = rows.map((r) => ({
      sessionId: r.task_id,
      breachType: toNum(r.total_cost) > maxCostUsd ? "cost_overflow" : "step_overflow",
      currentCost: toNum(r.total_cost),
      costLimit: maxCostUsd,
      currentSteps: toNum(r.step_count),
      stepLimit: maxSteps,
    }));

    // Check for active fitters (sessions with fitter-related punches in the last hour)
    let activeFitterCount = 0;
    try {
      const [fitterRows] = await conn.execute(
        `SELECT COUNT(DISTINCT task_id) AS fitter_count
         FROM punches
         WHERE punch_type = 'fitter_dispatch'
           AND observed_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
      );
      activeFitterCount = toNum(
        (fitterRows as Array<{ fitter_count: string | number }>)[0]?.fitter_count,
      );
    } catch {
      // fitter_dispatch punch type may not exist yet — that's fine
    }

    return {
      status: interventions.length > 0 ? "unhealthy" : "ok",
      data: {
        sessionsUnderIntervention: interventions,
        interventionCount: interventions.length,
        activeFitterCount,
      },
      error: null,
    };
  } catch (e) {
    return {
      status: "unknown",
      data: null,
      error: `Failed to query governor status: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Collect cost summary across all sessions.
 *
 * Queries Dolt for per-session cost and token data and classifies each
 * session into a cost zone.
 */
export async function collectCostSummary(
  conn: Connection,
  cheapThreshold: number,
  balloonedThreshold: number,
): Promise<CostSummaryStatus> {
  try {
    const [rows] = await conn.execute(
      `SELECT
         task_id,
         COALESCE(SUM(cost), 0) AS total_cost,
         COALESCE(SUM(tokens_input), 0) AS tokens_input,
         COALESCE(SUM(tokens_output), 0) AS tokens_output
       FROM punches
       WHERE observed_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       GROUP BY task_id
       ORDER BY total_cost DESC
       LIMIT 100`,
    );

    const sessionRows = rows as CostSessionRow[];
    let totalSpend = 0;
    const sessionBreakdown: SessionCostEntry[] = sessionRows.map((r) => {
      const totalCost = toNum(r.total_cost);
      const tokensInput = toNum(r.tokens_input);
      const tokensOutput = toNum(r.tokens_output);
      const totalTokens = tokensInput + tokensOutput;
      const costPer100k = totalTokens > 0 ? (totalCost / totalTokens) * 100_000 : null;

      totalSpend += totalCost;
      return {
        sessionId: r.task_id,
        totalCost,
        tokensInput,
        tokensOutput,
        costPer100kTokens: costPer100k,
        zone: classifyCostZone(costPer100k, cheapThreshold, balloonedThreshold),
      };
    });

    const anyBallooned = sessionBreakdown.some((s) => s.zone === "ballooned");
    return {
      status: sessionBreakdown.length === 0 ? "unknown" : anyBallooned ? "degraded" : "ok",
      data: {
        totalSpend,
        sessionBreakdown,
        sessionCount: sessionBreakdown.length,
        cheapZoneTarget: cheapThreshold,
      },
      error: null,
    };
  } catch (e) {
    return {
      status: "unknown",
      data: null,
      error: `Failed to query cost summary: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Collect subtask tree health.
 *
 * Queries Dolt for parent-child relationships and checks for
 * orphaned children (children with no punches).
 */
export async function collectSubtaskTreeHealth(
  conn: Connection,
): Promise<SubtaskTreeStatus> {
  try {
    // Get all parent IDs with children
    const [parentRows] = await conn.execute(
      `SELECT DISTINCT parent_id FROM child_rels`,
    );

    const parents = parentRows as ParentRow[];
    if (parents.length === 0) {
      return {
        status: "ok",
        data: { trees: [], totalOrphaned: 0, allHealthy: true },
        error: null,
      };
    }

    const trees: SubtaskTreeEntry[] = [];
    let totalOrphaned = 0;

    for (const { parent_id } of parents) {
      // Get children and their punch status
      const [childRows] = await conn.execute(
        `SELECT
           cr.child_id,
           COUNT(p.punch_id) AS punch_count,
           SUM(CASE WHEN p.punch_type IN ('gate_pass', 'gate_fail') THEN 1 ELSE 0 END) AS has_quality_gate
         FROM child_rels cr
         LEFT JOIN punches p ON p.task_id = cr.child_id
         WHERE cr.parent_id = ?
         GROUP BY cr.child_id`,
        [parent_id],
      );

      const children = childRows as ChildStatusRow[];
      const orphaned: string[] = [];
      let withPunches = 0;
      let withGates = 0;

      for (const child of children) {
        const punchCount = toNum(child.punch_count);
        const hasGate = toNum(child.has_quality_gate);
        if (punchCount === 0) {
          orphaned.push(child.child_id);
        } else {
          withPunches++;
        }
        if (hasGate > 0) withGates++;
      }

      totalOrphaned += orphaned.length;
      trees.push({
        parentId: parent_id,
        childCount: children.length,
        childrenWithPunches: withPunches,
        childrenWithQualityGates: withGates,
        orphanedChildren: orphaned,
        healthy: orphaned.length === 0,
      });
    }

    const allHealthy = totalOrphaned === 0;
    return {
      status: allHealthy ? "ok" : "degraded",
      data: { trees, totalOrphaned, allHealthy },
      error: null,
    };
  } catch (e) {
    return {
      status: "unknown",
      data: null,
      error: `Failed to query subtask tree health: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
