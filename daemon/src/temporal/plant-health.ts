/**
 * Plant Health Composite Command — Structured health report for the plant.
 *
 * Returns an operator-facing health report covering 6 sections:
 *   1. Punch Card Status — per active session step count, cost, tool adherence
 *   2. Governor Status   — sessions under intervention, active line fitters
 *   3. Quality Gate Results — last pass/fail per quality gate
 *   4. Cost Summary      — total spend, per-session breakdown, cheap zone classification
 *   5. Subtask Tree Health — parent-child completeness, orphaned sessions
 *   6. Daemon Health      — kilo serve, Dolt query latency, Temporal status
 *
 * Key design decisions:
 *   - Each section independently succeeds or fails (one unhealthy section
 *     doesn't prevent reporting the others).
 *   - Missing data is reported as `unknown` with a reason, never as a crash.
 *   - Callable as a Temporal activity AND as a standalone CLI script.
 *   - Structured JSON output for programmatic consumption.
 *
 * Key metrics (from Experiment A/B data):
 *   - Cost per 100k tokens target: ≤$0.42 in cheap zone
 *   - Session step count target: ≤50 for bounded tasks
 *   - Tool adherence ratio: edits vs overhead tools
 *   - Loop detection score: repeated tool pattern frequency
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createConnection } from "node:net";
import mysql, { type Connection } from "mysql2/promise";

import { timed } from "../infra/utils.js";
import type { DoltConfig } from "../writer/index.js";
import type {
  HealthCheckResult,
  SubsystemHealth,
  CheckStackHealthInput,
} from "./foreman.types.js";

// ── Report Types ──

/** Status of a single health report section. */
export type SectionStatus = "ok" | "degraded" | "unhealthy" | "unknown";

/** Base for all section results — each section independently succeeds or fails. */
export interface SectionResult<T> {
  status: SectionStatus;
  data: T | null;
  error: string | null;
}

// ── Section 1: Punch Card Status ──

export interface PunchCardSessionStatus {
  sessionId: string;
  stepCount: number;
  totalCost: number;
  toolCalls: number;
  editCount: number;
  overheadToolCount: number;
  toolAdherenceRatio: number | null; // edits / total tools, null if no tools
}

export type PunchCardStatus = SectionResult<{
  activeSessions: PunchCardSessionStatus[];
  totalActiveSessions: number;
}>;

// ── Section 2: Governor Status ──

export interface GovernorSessionIntervention {
  sessionId: string;
  breachType: string;
  currentCost: number;
  costLimit: number;
  currentSteps: number;
  stepLimit: number;
}

export type GovernorStatus = SectionResult<{
  sessionsUnderIntervention: GovernorSessionIntervention[];
  interventionCount: number;
  /** Whether any active line fitters are running (from Dolt fitter records). */
  activeFitterCount: number;
}>;

// ── Section 3: Quality Gate Results ──

export interface QualityGateResult {
  gateId: string;
  status: "pass" | "fail";
  beadId: string;
  runTimestamp: string;
  elapsedSeconds: number;
}

export type QualityGateStatus = SectionResult<{
  gates: QualityGateResult[];
  allPassing: boolean;
}>;

// ── Section 4: Cost Summary ──

export type CostZone = "cheap" | "moderate" | "ballooned";

export interface SessionCostEntry {
  sessionId: string;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
  costPer100kTokens: number | null;
  zone: CostZone;
}

export type CostSummaryStatus = SectionResult<{
  totalSpend: number;
  sessionBreakdown: SessionCostEntry[];
  sessionCount: number;
  cheapZoneTarget: number;
}>;

// ── Section 5: Subtask Tree Health ──

export interface SubtaskTreeEntry {
  parentId: string;
  childCount: number;
  childrenWithPunches: number;
  childrenWithQualityGates: number;
  orphanedChildren: string[];
  healthy: boolean;
}

export type SubtaskTreeStatus = SectionResult<{
  trees: SubtaskTreeEntry[];
  totalOrphaned: number;
  allHealthy: boolean;
}>;

// ── Section 6: Daemon Health ──

export type DaemonHealthStatus = SectionResult<{
  kiloServe: SubsystemHealth;
  dolt: SubsystemHealth;
  temporal: SubsystemHealth;
  doltQueryLatencyMs: number | null;
}>;

// ── Key Metrics ──

export interface PlantKeyMetrics {
  /** Average cost per 100k tokens across all sessions (null if no data). */
  avgCostPer100kTokens: number | null;
  /** Max step count across active sessions (null if no data). */
  maxSessionStepCount: number | null;
  /** Average tool adherence ratio (edits / total) across sessions (null if no data). */
  avgToolAdherenceRatio: number | null;
  /** Number of sessions with detected loop patterns. */
  sessionsWithLoops: number;
}

// ── Composite Report ──

export interface PlantHealthReport {
  /** ISO 8601 timestamp when the report was generated. */
  generatedAt: string;
  /** Overall plant health. */
  overall: "healthy" | "degraded" | "unhealthy" | "unknown";
  /** Individual section reports. */
  sections: {
    punchCardStatus: PunchCardStatus;
    governorStatus: GovernorStatus;
    qualityGateResults: QualityGateStatus;
    costSummary: CostSummaryStatus;
    subtaskTreeHealth: SubtaskTreeStatus;
    daemonHealth: DaemonHealthStatus;
  };
  /** Key metrics derived from section data. */
  keyMetrics: PlantKeyMetrics;
}

// ── Configuration ──

export interface PlantHealthConfig {
  repoPath: string;
  doltHost: string;
  doltPort: number;
  doltDatabase: string;
  kiloHost: string;
  kiloPort: number;
  /** Cost per 100k tokens threshold for cheap zone classification (default: $0.42). */
  cheapZoneThresholdUsd: number;
  /** Cost per 100k tokens threshold for ballooned classification (default: $1.00). */
  balloonedThresholdUsd: number;
  /** Path to gate_runs.jsonl relative to repoPath (default: .kilocode/gate_runs.jsonl). */
  gateRunsPath: string;
  /** Whether running inside a Temporal activity (affects temporal health check). */
  insideTemporal: boolean;
}

export const DEFAULT_PLANT_HEALTH_CONFIG: Omit<PlantHealthConfig, "repoPath"> = {
  doltHost: "127.0.0.1",
  doltPort: 3307,
  doltDatabase: "beads_repomap-core",
  kiloHost: "127.0.0.1",
  kiloPort: 4096,
  cheapZoneThresholdUsd: 0.42,
  balloonedThresholdUsd: 1.0,
  gateRunsPath: ".kilocode/gate_runs.jsonl",
  insideTemporal: false,
};

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

interface LoopCountRow {
  loop_sessions: string | number;
}

interface ParentRow {
  parent_id: string;
}

// ── Gate Run JSONL Shape ──

interface GateRunEntry {
  gate_id: string;
  status: "pass" | "fail";
  bead_id: string;
  run_timestamp: string;
  elapsed_seconds: number;
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

/** Timeout for individual health checks (5 seconds). */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Latency threshold above which a subsystem is classified as degraded (3 seconds). */
const DEGRADED_LATENCY_THRESHOLD_MS = 3_000;

/** Build a SubsystemHealth from a check result. */
function buildSubsystemHealth(
  status: "up" | "down",
  latencyMs: number | null,
  message: string | null,
): SubsystemHealth {
  const effectiveStatus =
    status === "up" && latencyMs !== null && latencyMs > DEGRADED_LATENCY_THRESHOLD_MS
      ? "degraded"
      : status;
  return { status: effectiveStatus, message, latencyMs };
}

function parseTemporalAddress(address: string): {
  host: string;
  port: number;
  display: string;
} {
  const trimmed = address.trim();
  if (!trimmed) {
    return { host: "localhost", port: 7233, display: "localhost:7233" };
  }

  const bracketMatch = /^\[(.+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketMatch) {
    const host = bracketMatch[1] ?? "localhost";
    const parsedPort = Number.parseInt(bracketMatch[2] ?? "7233", 10);
    const port = Number.isFinite(parsedPort) ? parsedPort : 7233;
    return { host, port, display: `${host}:${port}` };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0 && lastColon < trimmed.length - 1) {
    const host = trimmed.slice(0, lastColon);
    const parsedPort = Number.parseInt(trimmed.slice(lastColon + 1), 10);
    if (Number.isFinite(parsedPort)) {
      return { host, port: parsedPort, display: `${host}:${parsedPort}` };
    }
  }

  return { host: trimmed, port: 7233, display: `${trimmed}:7233` };
}

// ── Section Collectors ──

/**
 * Collect punch card status for active sessions.
 *
 * Queries Dolt for sessions with recent punches (last 24 hours)
 * and computes per-session metrics.
 */
async function collectPunchCardStatus(
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
async function collectGovernorStatus(
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
 * Collect quality gate results from gate_runs.jsonl.
 *
 * Reads the JSONL file and extracts the last result per gate ID.
 */
async function collectQualityGateResults(
  repoPath: string,
  gateRunsPath: string,
): Promise<QualityGateStatus> {
  try {
    const fullPath = resolve(repoPath, gateRunsPath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      return {
        status: "unknown",
        data: null,
        error: `Quality gate file not found: ${gateRunsPath}`,
      };
    }

    const lines = content.trim().split("\n").filter(Boolean);
    const lastPerGate = new Map<string, GateRunEntry>();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as GateRunEntry;
        if (entry.gate_id) {
          lastPerGate.set(entry.gate_id, entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    const gates: QualityGateResult[] = [];
    for (const [gateId, entry] of lastPerGate) {
      gates.push({
        gateId,
        status: entry.status === "pass" ? "pass" : "fail",
        beadId: entry.bead_id ?? "unknown",
        runTimestamp: entry.run_timestamp ?? "unknown",
        elapsedSeconds: entry.elapsed_seconds ?? 0,
      });
    }

    const allPassing = gates.length > 0 && gates.every((g) => g.status === "pass");
    const anyFailing = gates.some((g) => g.status === "fail");

    return {
      status: gates.length === 0 ? "unknown" : anyFailing ? "degraded" : "ok",
      data: { gates, allPassing },
      error: null,
    };
  } catch (e) {
    return {
      status: "unknown",
      data: null,
      error: `Failed to read quality gate results: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Collect cost summary across all sessions.
 *
 * Queries Dolt for per-session cost and token data and classifies each
 * session into a cost zone.
 */
async function collectCostSummary(
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
async function collectSubtaskTreeHealth(
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

/**
 * Collect daemon health — kilo serve, Dolt, and Temporal connectivity.
 *
 * Reuses patterns from foreman.activities.ts health checks.
 */
async function collectDaemonHealth(
  config: PlantHealthConfig,
): Promise<DaemonHealthStatus> {
  try {
    // Check kilo serve
    let kiloServe: SubsystemHealth;
    try {
      const { result: res, elapsedMs } = await timed(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        try {
          return await fetch(`http://${config.kiloHost}:${config.kiloPort}/session`, {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      });
      kiloServe = res.ok
        ? buildSubsystemHealth("up", elapsedMs, `HTTP ${res.status}`)
        : buildSubsystemHealth("down", elapsedMs, `HTTP ${res.status} ${res.statusText}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      kiloServe = { status: "down", message: `unreachable: ${msg}`, latencyMs: null };
    }

    // Check Dolt via TCP
    let dolt: SubsystemHealth;
    let doltQueryLatencyMs: number | null = null;
    try {
      const { elapsedMs } = await timed(async () => {
        await new Promise<void>((resolveConn, reject) => {
          const sock = createConnection(
            { host: config.doltHost, port: config.doltPort },
            () => {
              sock.destroy();
              resolveConn();
            },
          );
          sock.on("error", reject);
          sock.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
            sock.destroy();
            reject(new Error("timeout"));
          });
        });
      });
      dolt = buildSubsystemHealth("up", elapsedMs, `TCP ${config.doltHost}:${config.doltPort}`);

      // Measure query latency via a lightweight query
      try {
        let conn: Connection | null = null;
        try {
          conn = await mysql.createConnection({
            host: config.doltHost,
            port: config.doltPort,
            database: config.doltDatabase,
            user: "root",
            connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
          });
          const activeConn = conn;
          const { elapsedMs: queryMs } = await timed(async () => {
            await activeConn.execute("SELECT 1");
          });
          doltQueryLatencyMs = queryMs;
        } finally {
          if (conn) {
            await conn.end();
          }
        }
      } catch {
        // Query latency probe failed, but TCP was up.
        dolt = {
          status: "degraded",
          latencyMs: elapsedMs,
          message: "TCP up, but query latency probe failed",
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dolt = { status: "down", message: `TCP ${config.doltHost}:${config.doltPort} failed: ${msg}`, latencyMs: null };
    }

    // Check Temporal
    let temporal: SubsystemHealth;
    if (config.insideTemporal) {
      temporal = { status: "up", message: "implicit: running inside Temporal activity", latencyMs: 0 };
    } else {
      // TCP check against configured Temporal address
      const temporalEndpoint = parseTemporalAddress(process.env.TEMPORAL_ADDRESS ?? "localhost:7233");
      try {
        const { elapsedMs } = await timed(async () => {
          await new Promise<void>((resolveConn, reject) => {
            const sock = createConnection(
              { host: temporalEndpoint.host, port: temporalEndpoint.port },
              () => {
                sock.destroy();
                resolveConn();
              },
            );
            sock.on("error", reject);
            sock.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
              sock.destroy();
              reject(new Error("timeout"));
            });
          });
        });
        temporal = buildSubsystemHealth("up", elapsedMs, `TCP ${temporalEndpoint.display}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        temporal = { status: "down", message: `TCP ${temporalEndpoint.display} failed: ${msg}`, latencyMs: null };
      }
    }

    const anyDown = [kiloServe, dolt, temporal].some((s) => s.status === "down");
    const anyDegraded = [kiloServe, dolt, temporal].some((s) => s.status === "degraded");

    return {
      status: anyDown ? "unhealthy" : anyDegraded ? "degraded" : "ok",
      data: { kiloServe, dolt, temporal, doltQueryLatencyMs },
      error: null,
    };
  } catch (e) {
    return {
      status: "unknown",
      data: null,
      error: `Failed to collect daemon health: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Compute key metrics from section data.
 */
function computeKeyMetrics(
  conn: Connection | null,
  punchCard: PunchCardStatus,
  costSummary: CostSummaryStatus,
): PlantKeyMetrics {
  // Average cost per 100k tokens
  let avgCostPer100kTokens: number | null = null;
  if (costSummary.data) {
    const sessionsWithCost = costSummary.data.sessionBreakdown.filter(
      (s) => s.costPer100kTokens != null,
    );
    if (sessionsWithCost.length > 0) {
      const sum = sessionsWithCost.reduce((acc, s) => acc + (s.costPer100kTokens ?? 0), 0);
      avgCostPer100kTokens = sum / sessionsWithCost.length;
    }
  }

  // Max session step count
  let maxSessionStepCount: number | null = null;
  if (punchCard.data) {
    const steps = punchCard.data.activeSessions.map((s) => s.stepCount);
    if (steps.length > 0) {
      maxSessionStepCount = Math.max(...steps);
    }
  }

  // Average tool adherence ratio
  let avgToolAdherenceRatio: number | null = null;
  if (punchCard.data) {
    const sessionsWithRatio = punchCard.data.activeSessions.filter(
      (s) => s.toolAdherenceRatio != null,
    );
    if (sessionsWithRatio.length > 0) {
      const sum = sessionsWithRatio.reduce(
        (acc, s) => acc + (s.toolAdherenceRatio ?? 0),
        0,
      );
      avgToolAdherenceRatio = sum / sessionsWithRatio.length;
    }
  }

  return {
    avgCostPer100kTokens,
    maxSessionStepCount,
    avgToolAdherenceRatio,
    // sessionsWithLoops requires an additional query — set to 0 for now
    sessionsWithLoops: 0,
  };
}

// ── Aggregate Overall Health ──

function aggregateOverall(
  sections: PlantHealthReport["sections"],
): PlantHealthReport["overall"] {
  const statuses = [
    sections.punchCardStatus.status,
    sections.governorStatus.status,
    sections.qualityGateResults.status,
    sections.costSummary.status,
    sections.subtaskTreeHealth.status,
    sections.daemonHealth.status,
  ];

  if (statuses.includes("unhealthy")) return "unhealthy";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.every((s) => s === "unknown")) return "unknown";
  return "healthy";
}

// ── Main Composite Command ──

/**
 * Generate a complete plant health report.
 *
 * This is the composite command — callable as a Temporal activity
 * or as a standalone function. Each section independently collects
 * its data and gracefully handles errors.
 */
export async function generatePlantHealthReport(
  config: PlantHealthConfig,
): Promise<PlantHealthReport> {
  let conn: Connection | null = null;

  try {
    // Establish Dolt connection for sections that need it
    try {
      conn = await mysql.createConnection({
        host: config.doltHost,
        port: config.doltPort,
        database: config.doltDatabase,
        user: "root",
        connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
      });
    } catch {
      // Dolt connection failed — sections that need it will report as unknown
    }

    // Collect all sections in parallel where possible
    const [
      punchCardStatus,
      governorStatus,
      qualityGateResults,
      costSummary,
      subtaskTreeHealth,
      daemonHealth,
    ] = await Promise.all([
      conn
        ? collectPunchCardStatus(conn)
        : Promise.resolve<PunchCardStatus>({
            status: "unknown", data: null, error: "Dolt connection unavailable",
          }),
      conn
        ? collectGovernorStatus(conn)
        : Promise.resolve<GovernorStatus>({
            status: "unknown", data: null, error: "Dolt connection unavailable",
          }),
      collectQualityGateResults(config.repoPath, config.gateRunsPath),
      conn
        ? collectCostSummary(conn, config.cheapZoneThresholdUsd, config.balloonedThresholdUsd)
        : Promise.resolve<CostSummaryStatus>({
            status: "unknown", data: null, error: "Dolt connection unavailable",
          }),
      conn
        ? collectSubtaskTreeHealth(conn)
        : Promise.resolve<SubtaskTreeStatus>({
            status: "unknown", data: null, error: "Dolt connection unavailable",
          }),
      collectDaemonHealth(config),
    ]);

    const sections = {
      punchCardStatus,
      governorStatus,
      qualityGateResults,
      costSummary,
      subtaskTreeHealth,
      daemonHealth,
    };

    const keyMetrics = computeKeyMetrics(conn, punchCardStatus, costSummary);

    return {
      generatedAt: new Date().toISOString(),
      overall: aggregateOverall(sections),
      sections,
      keyMetrics,
    };
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Temporal activity wrapper for generatePlantHealthReport.
 *
 * Adapts the CheckStackHealthInput format used by foreman activities
 * for consistency, while providing the richer plant health report.
 */
export async function checkPlantHealth(
  input: CheckStackHealthInput & {
    cheapZoneThresholdUsd?: number;
    balloonedThresholdUsd?: number;
    gateRunsPath?: string;
  },
): Promise<PlantHealthReport> {
  return generatePlantHealthReport({
    repoPath: input.repoPath,
    doltHost: input.doltHost,
    doltPort: input.doltPort,
    doltDatabase: input.doltDatabase,
    kiloHost: input.kiloHost,
    kiloPort: input.kiloPort,
    cheapZoneThresholdUsd: input.cheapZoneThresholdUsd ?? DEFAULT_PLANT_HEALTH_CONFIG.cheapZoneThresholdUsd,
    balloonedThresholdUsd: input.balloonedThresholdUsd ?? DEFAULT_PLANT_HEALTH_CONFIG.balloonedThresholdUsd,
    gateRunsPath: input.gateRunsPath ?? DEFAULT_PLANT_HEALTH_CONFIG.gateRunsPath,
    insideTemporal: true,
  });
}

// ── CLI Entry Point ──

async function main(): Promise<void> {
  const repoPath = process.argv[2] ?? process.cwd();

  const config: PlantHealthConfig = {
    repoPath,
    ...DEFAULT_PLANT_HEALTH_CONFIG,
  };

  // Override from environment
  if (process.env.DOLT_HOST) config.doltHost = process.env.DOLT_HOST;
  if (process.env.DOLT_PORT) config.doltPort = Number.parseInt(process.env.DOLT_PORT, 10);
  if (process.env.DOLT_DATABASE) config.doltDatabase = process.env.DOLT_DATABASE;
  if (process.env.KILO_HOST) config.kiloHost = process.env.KILO_HOST;
  if (process.env.KILO_PORT) config.kiloPort = Number.parseInt(process.env.KILO_PORT, 10);

  console.error("[plant-health] Generating health report...");
  const report = await generatePlantHealthReport(config);
  console.log(JSON.stringify(report, null, 2));
  console.error(`[plant-health] Overall: ${report.overall}`);
}

// Run as CLI when executed directly
const isMainModule = process.argv[1]?.endsWith("plant-health.ts") ||
  process.argv[1]?.endsWith("plant-health.js");

if (isMainModule) {
  main().catch((err) => {
    console.error("[plant-health] Fatal error:", err);
    process.exit(1);
  });
}
