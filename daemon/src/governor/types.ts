/**
 * Governor Types — Shared type definitions for the governor subsystem.
 *
 * The governor detects runaway sessions, kills them, diagnoses the failure,
 * and dispatches bounded line fitters to recover.
 */

// ── Loop Detection ──

/** Classification of detected loop anomalies. */
export type LoopClassification =
  | "step_overflow"
  | "cost_overflow"
  | "tool_cycle"
  | "cache_plateau";

/** Emitted when the loop detector identifies a runaway session. */
export interface LoopDetection {
  sessionId: string;
  classification: LoopClassification;
  /** Human-readable explanation of what triggered the detection. */
  reason: string;
  /** Current metrics at time of detection. */
  metrics: SessionMetrics;
  detectedAt: Date;
}

/** Accumulated session metrics from the punch stream. */
export interface SessionMetrics {
  stepCount: number;
  totalCost: number;
  toolCalls: number;
  /** Ordered list of recent tool names (last N). */
  recentTools: string[];
  /** Number of unique source hashes seen in a sliding window. */
  uniqueSourceHashes: number;
  elapsedMs: number;
}

// ── Thresholds ──

/** Configurable thresholds for loop detection. */
export interface GovernorThresholds {
  /** Maximum step count before step_overflow (default: 100). */
  maxSteps: number;
  /** Maximum cost in USD before cost_overflow (default: 2.00). */
  maxCostUsd: number;
  /** Minimum cycle length to check for tool_cycle (default: 2). */
  minCycleLength: number;
  /** Maximum cycle length to check for tool_cycle (default: 6). */
  maxCycleLength: number;
  /** Number of consecutive repetitions to confirm a cycle (default: 3). */
  cycleRepetitions: number;
  /** Size of the sliding window for cache_plateau detection (default: 20). */
  cacheWindowSize: number;
  /** If unique hashes / window size falls below this ratio, it's a plateau (default: 0.3). */
  cachePlateuRatio: number;
}

export const DEFAULT_THRESHOLDS: GovernorThresholds = {
  maxSteps: 100,
  maxCostUsd: 2.0,
  minCycleLength: 2,
  maxCycleLength: 6,
  cycleRepetitions: 3,
  cacheWindowSize: 20,
  cachePlateuRatio: 0.3,
};

// ── Kill ──

/** Confirmation that a session was killed. */
export interface KillConfirmation {
  sessionId: string;
  killedAt: Date;
  /** The loop detection that triggered the kill. */
  trigger: LoopDetection;
  /** Final session stats at time of kill. */
  finalMetrics: SessionMetrics;
}

// ── Diagnosis ──

/** Classification of the failure mode. */
export type DiagnosisCategory =
  | "stuck_on_approval"
  | "infinite_retry"
  | "scope_creep"
  | "context_exhaustion"
  | "model_confusion";

/** Report from the failure diagnosis engine. */
export interface DiagnosisReport {
  sessionId: string;
  category: DiagnosisCategory;
  /** 0.0–1.0 confidence in the classification. */
  confidence: number;
  /** Human-readable summary. */
  summary: string;
  /** Suggested recovery action. */
  suggestedAction: string;
  /** Files touched by the session (blast radius). */
  blastRadius: string[];
  /** The tool patterns that led to this diagnosis. */
  toolPatterns: ToolPattern[];
  diagnosedAt: Date;
}

export interface ToolPattern {
  tool: string;
  count: number;
  errorCount: number;
  lastStatus: string;
}

// ── Fitter Dispatch ──

/** Input for the line fitter dispatch. */
export interface FitterDispatchInput {
  diagnosis: DiagnosisReport;
  killConfirmation: KillConfirmation;
  /** Override agent mode (default determined by diagnosis category). */
  agentMode?: string;
  /** Maximum context budget in tokens (default: 100_000). */
  maxTokenBudget?: number;
  /** kilo serve connection info. */
  kiloHost?: string;
  kiloPort?: number;
}

/** Result from a line fitter session. */
export interface FitterResult {
  sessionId: string;
  success: boolean;
  cost: number;
  filesChanged: string[];
  durationMs: number;
  error: string | null;
}
