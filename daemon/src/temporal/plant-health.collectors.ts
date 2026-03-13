import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import mysql, { type Connection } from "mysql2/promise";
import { timed } from "../infra/utils.js";
import type { SubsystemHealth } from "./foreman.types.js";
import { buildSubsystemHealth } from "./health-utils.js";
import type {
  ActiveSessionRow, ChildStatusRow, CostSessionRow, CostSummaryStatus, CostZone,
  DaemonHealthStatus, GateRunEntry, GovernorSessionIntervention, GovernorStatus,
  InterventionRow, ParentRow, PlantHealthConfig, PunchCardSessionStatus,
  PunchCardStatus, QualityGateResult, QualityGateStatus, SessionCostEntry,
  SubtaskTreeEntry, SubtaskTreeStatus,
} from "./plant-health.types.js";

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

export function toNum(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyCostZone(
  costPer100k: number | null,
  cheapThreshold: number,
  balloonedThreshold: number,
): CostZone {
  if (costPer100k == null) return "cheap";
  if (costPer100k <= cheapThreshold) return "cheap";
  if (costPer100k <= balloonedThreshold) return "moderate";
  return "ballooned";
}

export function parseTemporalAddress(address: string): {
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

export async function collectGovernorStatus(
  conn: Connection,
): Promise<GovernorStatus> {
  try {
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
      // fitter_dispatch punch type may not exist yet
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

export async function collectQualityGateResults(
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

export async function collectSubtaskTreeHealth(
  conn: Connection,
): Promise<SubtaskTreeStatus> {
  try {
    const [parentRows] = await conn.execute(
      "SELECT DISTINCT parent_id FROM child_rels",
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

export async function collectDaemonHealth(
  config: PlantHealthConfig,
): Promise<DaemonHealthStatus> {
  try {
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

    let temporal: SubsystemHealth;
    if (config.insideTemporal) {
      temporal = { status: "up", message: "implicit: running inside Temporal activity", latencyMs: 0 };
    } else {
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
