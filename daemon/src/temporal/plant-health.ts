/**
 * Plant Health Composite Command — Structured health report for the plant.
 *
 * This module is intentionally a slim facade that preserves the public API
 * while delegating section collectors and type surface to focused modules.
 */

import mysql, { type Connection } from "mysql2/promise";
import type { CheckStackHealthInput } from "./foreman.types.js";
import {
  collectCostSummary,
  collectDaemonHealth,
  collectGovernorStatus,
  collectPunchCardStatus,
  collectQualityGateResults,
  collectSubtaskTreeHealth,
} from "./plant-health.collectors.js";
import {
  DEFAULT_PLANT_HEALTH_CONFIG,
  type CostSummaryStatus,
  type GovernorStatus,
  type PlantHealthConfig,
  type PlantHealthReport,
  type PlantKeyMetrics,
  type PunchCardStatus,
  type SubtaskTreeStatus,
} from "./plant-health.types.js";

export type {
  ActiveSessionRow,
  ChildStatusRow,
  CostSessionRow,
  CostSummaryStatus,
  CostZone,
  DaemonHealthStatus,
  GateRunEntry,
  GovernorSessionIntervention,
  GovernorStatus,
  InterventionRow,
  LoopCountRow,
  ParentRow,
  PlantHealthConfig,
  PlantHealthReport,
  PlantKeyMetrics,
  PunchCardSessionStatus,
  PunchCardStatus,
  QualityGateResult,
  QualityGateStatus,
  SectionResult,
  SectionStatus,
  SessionCostEntry,
  SubtaskTreeEntry,
  SubtaskTreeStatus,
} from "./plant-health.types.js";

export { DEFAULT_PLANT_HEALTH_CONFIG } from "./plant-health.types.js";

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

function computeKeyMetrics(
  _conn: Connection | null,
  punchCard: PunchCardStatus,
  costSummary: CostSummaryStatus,
): PlantKeyMetrics {
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

  let maxSessionStepCount: number | null = null;
  if (punchCard.data) {
    const steps = punchCard.data.activeSessions.map((s) => s.stepCount);
    if (steps.length > 0) {
      maxSessionStepCount = Math.max(...steps);
    }
  }

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
    sessionsWithLoops: 0,
  };
}

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

export async function generatePlantHealthReport(
  config: PlantHealthConfig,
): Promise<PlantHealthReport> {
  let conn: Connection | null = null;

  try {
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

async function main(): Promise<void> {
  const repoPath = process.argv[2] ?? process.cwd();

  const config: PlantHealthConfig = {
    repoPath,
    ...DEFAULT_PLANT_HEALTH_CONFIG,
  };

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

const isMainModule = process.argv[1]?.endsWith("plant-health.ts") ||
  process.argv[1]?.endsWith("plant-health.js");

if (isMainModule) {
  try {
    await main();
  } catch (err) {
    console.error("[plant-health] Fatal error:", err);
    process.exit(1);
  }
}
