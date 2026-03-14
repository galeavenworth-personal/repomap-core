import type { SubsystemHealth } from "./foreman.types.js";

export type SectionStatus = "ok" | "degraded" | "unhealthy" | "unknown";

export interface SectionResult<T> {
  status: SectionStatus;
  data: T | null;
  error: string | null;
}

export interface PunchCardSessionStatus {
  sessionId: string;
  stepCount: number;
  totalCost: number;
  toolCalls: number;
  editCount: number;
  overheadToolCount: number;
  toolAdherenceRatio: number | null;
}

export type PunchCardStatus = SectionResult<{
  activeSessions: PunchCardSessionStatus[];
  totalActiveSessions: number;
}>;

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
  activeFitterCount: number;
}>;

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

export type DaemonHealthStatus = SectionResult<{
  kiloServe: SubsystemHealth;
  dolt: SubsystemHealth;
  temporal: SubsystemHealth;
  doltQueryLatencyMs: number | null;
}>;

export interface PlantKeyMetrics {
  avgCostPer100kTokens: number | null;
  maxSessionStepCount: number | null;
  avgToolAdherenceRatio: number | null;
  sessionsWithLoops: number;
}

export interface PlantHealthReport {
  generatedAt: string;
  overall: "healthy" | "degraded" | "unhealthy" | "unknown";
  sections: {
    punchCardStatus: PunchCardStatus;
    governorStatus: GovernorStatus;
    qualityGateResults: QualityGateStatus;
    costSummary: CostSummaryStatus;
    subtaskTreeHealth: SubtaskTreeStatus;
    daemonHealth: DaemonHealthStatus;
  };
  keyMetrics: PlantKeyMetrics;
}

export interface PlantHealthConfig {
  repoPath: string;
  doltHost: string;
  doltPort: number;
  doltDatabase: string;
  kiloHost: string;
  kiloPort: number;
  cheapZoneThresholdUsd: number;
  balloonedThresholdUsd: number;
  gateRunsPath: string;
  insideTemporal: boolean;
}

export const DEFAULT_PLANT_HEALTH_CONFIG: Omit<PlantHealthConfig, "repoPath"> = {
  doltHost: "127.0.0.1",
  doltPort: 3307,
  doltDatabase: "factory",
  kiloHost: "127.0.0.1",
  kiloPort: 4096,
  cheapZoneThresholdUsd: 0.42,
  balloonedThresholdUsd: 1,
  gateRunsPath: ".kilocode/gate_runs.jsonl",
  insideTemporal: false,
};

export interface ActiveSessionRow {
  task_id: string;
  step_count: string | number;
  total_cost: string | number;
  tool_calls: string | number;
  edit_count: string | number;
}

export interface CostSessionRow {
  task_id: string;
  total_cost: string | number;
  tokens_input: string | number;
  tokens_output: string | number;
}

export interface ChildStatusRow {
  child_id: string;
  punch_count: string | number;
  has_quality_gate: string | number;
}

export interface InterventionRow {
  task_id: string;
  total_cost: string | number;
  step_count: string | number;
}

export interface LoopCountRow {
  loop_sessions: string | number;
}

export interface ParentRow {
  parent_id: string;
}

export interface GateRunEntry {
  gate_id: string;
  status: "pass" | "fail";
  bead_id: string;
  run_timestamp: string;
  elapsed_seconds: number;
}
