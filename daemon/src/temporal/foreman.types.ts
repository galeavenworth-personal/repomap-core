/**
 * Foreman Type Surface â Shared Serializable Contract Layer
 *
 * All TypeScript types that foreman-facing modules import. Derived from
 * the foreman architecture ADR (docs/infra/foreman-architecture.md) and
 * the five foreman contracts (.kilocode/contracts/foreman/).
 *
 * Every type here is Temporal-safe and JSON-serializable: no functions,
 * no classes, no Date objects â only plain objects, strings, numbers,
 * booleans, arrays, and null.
 */

import type { AuditSummary } from "./workflows.js";

// ââ Workflow Phases (S3.2) ââ

/**
 * Named phases of the foreman control loop. The phase is the primary
 * observable state, exposed via the status query.
 */
export type ForemanPhase =
  | "polling"
  | "health_check"
  | "selecting"
  | "dispatching"
  | "monitoring"
  | "completing"
  | "failing"
  | "retrying"
  | "escalating"
  | "idle"
  | "paused"
  | "shutting_down";

// ââ Workflow Input (S4.1) ââ

/**
 * Initial input when starting the foreman workflow.
 * `carriedState` is null on a fresh start and populated by continue-as-new.
 */
export interface ForemanInput {
  // Identity
  workflowId: string;
  repoPath: string;

  // Temporal config
  taskQueue: string;

  // Kilo serve config
  kiloHost: string;
  kiloPort: number;

  // Dolt config
  doltHost: string;
  doltPort: number;
  doltDatabase: string;

  // Timing
  pollIntervalMs: number;
  healthCheckIntervalMs: number;
  maxIterations: number;
  maxWallClockMs: number;

  // Dispatch config
  maxConcurrentDispatches: number;
  defaultTimeoutMs: number;
  defaultCostBudgetUsd: number;

  // Retry config
  maxRetriesPerBead: number;
  retryBackoffMs: number;

  // Carried-forward state (set by continue-as-new, null on fresh start)
  carriedState: ForemanContinueAsNewState | null;
}

// ââ Continue-As-New State (S4.2) ââ

/**
 * Serialized state carried across continue-as-new boundaries.
 * Contains lifetime counters, recent history, retry tracking,
 * and operator state.
 */
export interface ForemanContinueAsNewState {
  // Counters
  totalIterations: number;
  totalDispatches: number;
  totalCompletions: number;
  totalFailures: number;
  totalEscalations: number;

  // Health snapshot
  lastHealthCheck: HealthCheckResult | null;
  lastHealthCheckAt: string | null; // ISO 8601

  // Recent history (bounded ring buffer)
  recentOutcomes: DispatchOutcome[]; // Last 20 outcomes
  retryLedger: RetryLedgerEntry[];

  // Operator state
  pauseRequested: boolean;
  shutdownRequested: boolean;

  // Timing
  foremanStartedAt: string; // ISO 8601, original start time
  lastContinueAsNewAt: string | null; // ISO 8601
}

// ââ Health Check (S4.3) ââ

/** Aggregate stack health result. All subsystems must pass before dispatch. */
export interface HealthCheckResult {
  overall: "pass" | "degraded" | "fail";
  checkedAt: string; // ISO 8601
  subsystems: {
    kiloServe: SubsystemHealth;
    dolt: SubsystemHealth;
    git: SubsystemHealth;
    temporal: SubsystemHealth;
    beads: SubsystemHealth;
  };
}

/** Health status for a single subsystem. */
export interface SubsystemHealth {
  status: "up" | "degraded" | "down";
  message: string | null;
  latencyMs: number | null;
}

// ââ Bead Candidate (S4.4) ââ

/** A bead eligible for dispatch, as returned by the bead selector activity. */
export interface BeadCandidate {
  beadId: string;
  title: string;
  priority: "P0" | "P1" | "P2" | "P3";
  labels: string[];
  dependsOn: string[];
  estimatedComplexity: "trivial" | "small" | "medium" | "large" | "unknown";
}

// ââ Dispatchability (S4.5) ââ

/**
 * The foreman's decision about whether a bead can be dispatched.
 * `dispatchPlan` is populated only when `decision` is `"dispatch"`.
 */
export interface DispatchabilityResult {
  decision: "dispatch" | "skip" | "defer" | "block";
  beadId: string;
  reason: string;
  dispatchPlan: DispatchPlan | null;
}

/** Concrete plan for dispatching a bead as a child workflow. */
export interface DispatchPlan {
  beadId: string;
  prompt: string;
  agent: string;
  title: string;
  timeoutMs: number;
  costBudgetUsd: number;
  cardId: string | null;
  enforcedOnly: boolean;
}

// ââ Dispatch Outcome (S4.6) ââ

/**
 * Durable record of what happened when a bead was dispatched.
 * Stored in the recentOutcomes ring buffer (max 20).
 */
export interface DispatchOutcome {
  beadId: string;
  workflowId: string;
  sessionId: string | null;
  startedAt: string; // ISO 8601
  completedAt: string; // ISO 8601
  durationMs: number;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;

  result: DispatchResult;
  audit: AuditSummary | null;
  attempt: number; // 1-indexed
}

/**
 * Discriminated union for dispatch results.
 * `kind` separates happy-path completion from exception/escalation outcomes.
 */
export type DispatchResult =
  | { kind: "completed" }
  | { kind: "failed"; error: string; retryable: boolean }
  | { kind: "validation_failed"; missing: string[]; violations: string[] }
  | { kind: "budget_exceeded"; actualCost: number; budgetUsd: number }
  | { kind: "timeout"; elapsedMs: number; timeoutMs: number }
  | { kind: "aborted"; reason: string };

// ââ Retry Ledger (S4.7) ââ

/** Tracks retry state for a bead across attempts. */
export interface RetryLedgerEntry {
  beadId: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string; // ISO 8601
  lastError: string;
  lastResult: DispatchResult;
  nextRetryAfter: string; // ISO 8601 (backoff expiry)
  exhausted: boolean;
}

// ââ Operator Signals (S4.8) ââ

/**
 * Discriminated union for operator signals sent to the foreman.
 * Each variant maps to a Temporal signal definition.
 */
export type ForemanSignal =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "shutdown"; reason: string }
  | { type: "forceDispatch"; beadId: string }
  | { type: "skipBead"; beadId: string; reason: string }
  | { type: "updateConfig"; config: Partial<ForemanInput> };

// ââ Operator Queries (S4.9) ââ

/** Response type for the foreman.status query. */
export interface ForemanStatus {
  phase: ForemanPhase;
  currentBeadId: string | null;
  currentWorkflowId: string | null;
  iterationCount: number;
  lifetimeIterations: number;
  lifetimeDispatches: number;
  lifetimeCompletions: number;
  lifetimeFailures: number;
  lifetimeEscalations: number;
  uptime: number; // Ms since foremanStartedAt
  lastHealthCheck: HealthCheckResult | null;
  recentOutcomes: DispatchOutcome[];
  retryLedger: RetryLedgerEntry[];
  paused: boolean;
  shuttingDown: boolean;
}

// ââ Foreman Result ââ

/** Terminal result of the foreman workflow. */
export interface ForemanResult {
  status: "shutdown" | "completed" | "failed";
  totalIterations: number;
  totalDispatches: number;
  totalCompletions: number;
  totalFailures: number;
  totalEscalations: number;
  shutdownReason: string | null;
  error: string | null;
}

// ââ Activity Payloads (S5.1âS5.7) ââ

/** Input for the checkStackHealth activity (S5.1). */
export interface CheckStackHealthInput {
  repoPath: string;
  doltHost: string;
  doltPort: number;
  doltDatabase: string;
  kiloHost: string;
  kiloPort: number;
}

// Output: HealthCheckResult (defined above)

/** Input for the selectNextBead activity (S5.2). */
export interface SelectNextBeadInput {
  repoPath: string;
  retryLedger: RetryLedgerEntry[];
  skipList: string[];
}

// Output: BeadCandidate | null

/** Input for the evaluateDispatchability activity (S5.3). */
export interface EvaluateDispatchabilityInput {
  candidate: BeadCandidate;
  healthResult: HealthCheckResult;
  retryLedger: RetryLedgerEntry[];
  config: ForemanInput;
}

// Output: DispatchabilityResult (defined above)

// dispatchBead input: DispatchPlan (defined above, S5.4)

/** Output from the dispatchBead activity (S5.4). */
export interface DispatchBeadOutput {
  workflowId: string;
  runId: string;
}

/** Input for the monitorDispatch activity (S5.5). */
export interface MonitorDispatchInput {
  workflowId: string;
  runId: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

// Output: DispatchOutcome (defined above)

/** Input for the closeBead activity (S5.6). */
export interface CloseBeadInput {
  repoPath: string;
  beadId: string;
  outcome: DispatchOutcome;
}

/** Output from the closeBead activity (S5.6). */
export interface CloseBeadOutput {
  closed: boolean;
  error: string | null;
}

/** Input for the annotateBead activity. */
export interface AnnotateBeadInput {
  repoPath: string;
  beadId: string;
  comment: string;
}

/** Output from the annotateBead activity. */
export interface AnnotateBeadOutput {
  annotated: boolean;
  error: string | null;
}

/** Input for the createEscalation activity (S5.7). */
export interface CreateEscalationInput {
  repoPath: string;
  beadId: string;
  reason: string;
  outcomes: DispatchOutcome[];
  retryEntry: RetryLedgerEntry;
}

/** Output from the createEscalation activity (S5.7). */
export interface CreateEscalationOutput {
  escalationBeadId: string;
}
