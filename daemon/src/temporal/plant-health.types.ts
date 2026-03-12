/**
 * Plant Health Types — Type surface for the plant health report.
 *
 * All types that compose the PlantHealthReport structure, extracted from
 * plant-health.ts for module boundary clarity.
 *
 * Every type here is Temporal-safe and JSON-serializable.
 */

import type { SubsystemHealth } from "./foreman.types.js";

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
