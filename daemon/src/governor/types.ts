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
  /** Maximum cost in USD before cost_overflow (default: 10.00). */
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
  cachePlateauRatio: number;
}

export const DEFAULT_THRESHOLDS: GovernorThresholds = {
  maxSteps: 100,
  maxCostUsd: 10.0,
  minCycleLength: 2,
  maxCycleLength: 6,
  cycleRepetitions: 3,
  cacheWindowSize: 20,
  cachePlateauRatio: 0.3,
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

// ── Session Inspection ──

/** A single tool call record from a session's message history. */
export interface ToolCallRecord {
  /** Tool name (e.g. "Edit", "Bash", "Read"). */
  tool: string;
  /** "ok" | "error" — final status of the tool call. */
  status: string;
  /** Error message, if status === "error". */
  error?: string;
  /** Text content returned by the tool (may be truncated). */
  content?: string;
  /** File path argument, if applicable. */
  filePath?: string;
  /** Timestamp of the tool call, if available. */
  calledAt?: Date;
}

/**
 * Abstraction over the external API that retrieves session history.
 *
 * Production implementations call kilo serve; tests can supply a
 * mock that returns canned ToolCallRecord arrays.
 */
export interface SessionInspector {
  /** Retrieve the tool call history for a given session. */
  getToolCalls(sessionId: string): Promise<ToolCallRecord[]>;
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

// ── Punch Card Validation ──

/** A single punch card requirement row from the punch_cards table. */
export interface PunchCardRequirement {
  punchType: string;
  punchKeyPattern: string;
  required: boolean;
  forbidden: boolean;
  description?: string;
}

/** Result of evaluating a punch card for a task. */
export interface ValidationResult {
  status: "pass" | "fail";
  cardId: string;
  taskId: string;
  missing: Array<{ punchType: string; punchKeyPattern: string; description?: string }>;
  violations: Array<{ punchType: string; punchKeyPattern: string; count: number; description?: string }>;
  toolAdherence?: ToolAdherenceResult;
}

/** Tool adherence check result. */
export interface ToolAdherenceResult {
  editCount: number;
  expectedRange: [number, number];
  withinRange: boolean;
}

/** Result of validating all children of a parent task. */
export interface SubtaskValidation {
  parentTaskId: string;
  children: Array<{ childId: string; validation: ValidationResult }>;
  allChildrenValid: boolean;
}
