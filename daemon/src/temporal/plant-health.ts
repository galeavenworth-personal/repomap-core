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
 *
 * Module structure (split for maintainability):
 *   - plant-health.types.ts   — All types, interfaces, and default config
 *   - plant-health.sections.ts — 6 section collectors (Dolt, JSONL, TCP checks)
 *   - health-utils.ts         — Shared buildSubsystemHealth + constants
 *   - plant-health.ts         — This file: orchestrator, key metrics, CLI
 */

import mysql, { type Connection } from "mysql2/promise";

import type {
  CheckStackHealthInput,
} from "./foreman.types.js";
import { HEALTH_CHECK_TIMEOUT_MS } from "./health-utils.js";
import {
  collectQualityGateResults,
  collectDaemonHealth,
} from "./plant-health.checks.js";
import {
  collectPunchCardStatus,
  collectGovernorStatus,
  collectCostSummary,
  collectSubtaskTreeHealth,
} from "./plant-health.sections.js";
import type {
  PunchCardStatus,
  GovernorStatus,
  QualityGateStatus,
  CostSummaryStatus,
  SubtaskTreeStatus,
  PlantHealthConfig,
  PlantHealthReport,
  PlantKeyMetrics,
} from "./plant-health.types.js";
import { DEFAULT_PLANT_HEALTH_CONFIG } from "./plant-health.types.js";

// ── Re-export all types for backward compatibility ──
// Consumers that import from plant-health.ts continue to work unchanged.

export type {
  SectionStatus,
  SectionResult,
  PunchCardSessionStatus,
  PunchCardStatus,
  GovernorSessionIntervention,
  GovernorStatus,
  QualityGateResult,
  QualityGateStatus,
  CostZone,
  SessionCostEntry,
  CostSummaryStatus,
  SubtaskTreeEntry,
  SubtaskTreeStatus,
  DaemonHealthStatus,
  PlantKeyMetrics,
  PlantHealthReport,
  PlantHealthConfig,
} from "./plant-health.types.js";

export { DEFAULT_PLANT_HEALTH_CONFIG } from "./plant-health.types.js";

// ── Key Metrics ──

/**
 * Compute key metrics from section data.
 */
function computeKeyMetrics(
  _conn: Connection | null,
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
