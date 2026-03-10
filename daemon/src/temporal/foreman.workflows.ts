/**
 * Foreman Workflow — Self-Driving Control Loop
 *
 * Long-lived Temporal workflow that continuously polls for eligible work
 * (beads), dispatches it via agentTaskWorkflow child workflows, monitors
 * execution, handles failures with bounded retries, and escalates only
 * when human intervention is genuinely required.
 *
 * Design invariants:
 * - Deterministic: no I/O, no randomness, no Date.now() except via
 *   Temporal-safe APIs. All external work happens in activity proxies.
 * - Uses continue-as-new to prevent unbounded Temporal history growth.
 * - Observable: every phase transition is exposed via the status query.
 * - Thin orchestration: the foreman decides *what* to work on, not *how*.
 *
 * ADR: docs/infra/foreman-architecture.md
 * Contracts: .kilocode/contracts/foreman/
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  sleep,
  condition,
  continueAsNew,
  startChild,
  isCancellation,
} from "@temporalio/workflow";

import type {
  ForemanInput,
  ForemanContinueAsNewState,
  ForemanPhase,
  ForemanStatus,
  ForemanResult,
  HealthCheckResult,
  BeadCandidate,
  DispatchOutcome,
  DispatchResult,
  RetryLedgerEntry,
  DispatchPlan,
  ApprovalDecision,
} from "./foreman.types.js";

import type * as foremanActivities from "./foreman.activities.js";

import { agentTaskWorkflow } from "./workflows.js";
import type { AgentTaskInput, AgentTaskResult } from "./workflows.js";

// ── Activity Proxies (tiered timeouts per ADR S5) ──

/** Quick activities: short schedule-to-close for CLI calls and health checks. */
const quick = proxyActivities<typeof foremanActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
  },
});

/** Close/escalation activities: slightly more generous retry. */
const durable = proxyActivities<typeof foremanActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 4,
    initialInterval: "5s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
  },
});

// ── Signals ──

export const pauseSignal = defineSignal("foreman.pause");
export const resumeSignal = defineSignal("foreman.resume");
export const shutdownSignal = defineSignal<[{ reason: string }]>("foreman.shutdown");
export const forceDispatchSignal = defineSignal<[{ beadId: string }]>("foreman.forceDispatch");
export const skipBeadSignal = defineSignal<[{ beadId: string; reason: string }]>("foreman.skipBead");
export const updateConfigSignal = defineSignal<[Partial<ForemanInput>]>("foreman.updateConfig");
export const approveOutcomeSignal = defineSignal<[{ beadId: string; decision: ApprovalDecision }]>("foreman.approveOutcome");
export const approveDispatchSignal = defineSignal<[{ beadId: string }]>("foreman.approveDispatch");

// ── Queries ──

export const foremanStatusQuery = defineQuery<ForemanStatus>("foreman.status");
export const foremanHealthQuery = defineQuery<HealthCheckResult | null>("foreman.health");
export const foremanHistoryQuery = defineQuery<DispatchOutcome[]>("foreman.history");

// ── Ring Buffer ──

const MAX_RECENT_OUTCOMES = 20;

function pushOutcome(outcomes: DispatchOutcome[], outcome: DispatchOutcome): DispatchOutcome[] {
  const next = [...outcomes, outcome];
  if (next.length > MAX_RECENT_OUTCOMES) {
    return next.slice(next.length - MAX_RECENT_OUTCOMES);
  }
  return next;
}

// ── Retry / Error Classification ──

/**
 * Classify a DispatchResult as retryable or not.
 * ADR Section 7.3.
 */
function isRetryable(result: DispatchResult): boolean {
  switch (result.kind) {
    case "timeout":
      return true;
    case "failed":
      return result.retryable;
    case "validation_failed":
      return true;
    case "budget_exceeded":
      return false;
    case "aborted":
      return false;
    case "completed":
      return false;
  }
}

/**
 * Classify an AgentTaskResult.status into a DispatchResult.
 * ADR Section 8.1.
 */
function toDispatchResult(agentResult: AgentTaskResult): DispatchResult {
  switch (agentResult.status) {
    case "completed":
      return { kind: "completed" };
    case "failed": {
      const err = agentResult.error ?? "unknown error";
      const retryable = classifyErrorRetryability(err);
      return { kind: "failed", error: err, retryable };
    }
    case "aborted":
      return { kind: "aborted", reason: agentResult.error ?? "aborted" };
    case "validation_failed":
      return { kind: "validation_failed", missing: [], violations: [] };
    case "budget_exceeded":
      return {
        kind: "budget_exceeded",
        actualCost: agentResult.totalCost,
        budgetUsd: 0,
      };
    default:
      return { kind: "failed", error: `unknown status: ${agentResult.status}`, retryable: false };
  }
}

/**
 * Heuristic error classification for retry decisions.
 * ADR Section 8.2.
 */
function classifyErrorRetryability(error: string): boolean {
  const lower = error.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) return true;
  if (lower.includes("econnrefused") || lower.includes("enotfound")) return true;
  if (lower.includes("session") && lower.includes("not found")) return true;
  if (lower.includes("rate limit") || lower.includes("429")) return true;
  // Conservative: unknown errors are not retryable
  return false;
}

/**
 * Classify whether an error thrown by an activity is a BeadsContractError
 * (non-retryable schema/CLI failure). In workflow code we cannot import
 * the activity error class directly, so we classify by error name.
 *
 * Temporal wraps activity errors in ApplicationFailure; the original
 * error name is preserved in the cause chain or message.
 */
function isBeadsContractError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Direct instance (in test mocks)
  if (err.name === "BeadsContractError") return true;
  // Temporal ApplicationFailure wrapping
  if (err.message?.includes("BeadsContractError")) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.name === "BeadsContractError") return true;
  return false;
}

/**
 * Update the retry ledger for a bead after a failed dispatch.
 * Returns the updated entry.
 */
function updateRetryLedger(
  ledger: RetryLedgerEntry[],
  beadId: string,
  result: DispatchResult,
  maxRetries: number,
  backoffMs: number,
  nowIso: string,
): RetryLedgerEntry {
  const existing = ledger.find((e) => e.beadId === beadId);
  const attempts = (existing?.attempts ?? 0) + 1;
  const maxAttempts = maxRetries + 1; // maxRetries is retries-after-first, so total = maxRetries + 1
  const exhausted = attempts >= maxAttempts;
  const nextRetryAfter = new Date(Date.parse(nowIso) + backoffMs * attempts).toISOString();
  const error = "error" in result ? (result as { error: string }).error : result.kind;

  const entry: RetryLedgerEntry = {
    beadId,
    attempts,
    maxAttempts,
    lastAttemptAt: nowIso,
    lastError: error,
    lastResult: result,
    nextRetryAfter,
    exhausted,
  };

  if (existing) {
    Object.assign(existing, entry);
  } else {
    ledger.push(entry);
  }

  return entry;
}

/**
 * Remove a bead from the retry ledger (e.g., on success).
 */
function removeFromRetryLedger(ledger: RetryLedgerEntry[], beadId: string): void {
  const idx = ledger.findIndex((e) => e.beadId === beadId);
  if (idx !== -1) {
    ledger.splice(idx, 1);
  }
}

// ── Internal State ──

interface ForemanState {
  phase: ForemanPhase;
  iterationCount: number;

  // Operator
  pauseRequested: boolean;
  shutdownRequested: boolean;
  shutdownReason: string | null;

  // Dispatch
  currentBeadId: string | null;
  currentWorkflowId: string | null;
  skipList: string[];
  forceDispatchQueue: string[];

  // Carried counters
  totalIterations: number;
  totalDispatches: number;
  totalCompletions: number;
  totalFailures: number;
  totalEscalations: number;

  // Health
  lastHealthCheck: HealthCheckResult | null;
  lastHealthCheckAt: string | null;
  consecutiveHealthFailures: number;

  // Intervention / exception state
  interventionReason: string | null;
  awaitingInterventionSince: string | null;
  interventionResumed: boolean;

  // Approval state
  approvedDispatchBeadIds: string[];
  outcomeApproval: { beadId: string; decision: ApprovalDecision } | null;

  // History
  recentOutcomes: DispatchOutcome[];
  retryLedger: RetryLedgerEntry[];

  // Timing
  foremanStartedAt: string;
  lastContinueAsNewAt: string | null;
  startTimestamp: number; // workflow start ms for wall-clock checks
}

function initializeState(input: ForemanInput, startTimestamp: number): ForemanState {
  const carried = input.carriedState;
  return {
    phase: "polling",
    iterationCount: 0,
    pauseRequested: carried?.pauseRequested ?? false,
    shutdownRequested: carried?.shutdownRequested ?? false,
    shutdownReason: null,
    currentBeadId: null,
    currentWorkflowId: null,
    skipList: [],
    forceDispatchQueue: [],

    totalIterations: carried?.totalIterations ?? 0,
    totalDispatches: carried?.totalDispatches ?? 0,
    totalCompletions: carried?.totalCompletions ?? 0,
    totalFailures: carried?.totalFailures ?? 0,
    totalEscalations: carried?.totalEscalations ?? 0,

    lastHealthCheck: carried?.lastHealthCheck ?? null,
    lastHealthCheckAt: carried?.lastHealthCheckAt ?? null,
    consecutiveHealthFailures: carried?.consecutiveHealthFailures ?? 0,

    interventionReason: carried?.interventionReason ?? null,
    awaitingInterventionSince: carried?.awaitingInterventionSince ?? null,
    interventionResumed: false,

    approvedDispatchBeadIds: [],
    outcomeApproval: null,

    recentOutcomes: carried?.recentOutcomes ?? [],
    retryLedger: carried?.retryLedger ?? [],

    foremanStartedAt: carried?.foremanStartedAt ?? new Date(startTimestamp).toISOString(),
    lastContinueAsNewAt: carried?.lastContinueAsNewAt ?? null,
    startTimestamp,
  };
}

function serializeState(state: ForemanState): ForemanContinueAsNewState {
  return {
    totalIterations: state.totalIterations,
    totalDispatches: state.totalDispatches,
    totalCompletions: state.totalCompletions,
    totalFailures: state.totalFailures,
    totalEscalations: state.totalEscalations,
    lastHealthCheck: state.lastHealthCheck,
    lastHealthCheckAt: state.lastHealthCheckAt,
    recentOutcomes: state.recentOutcomes,
    retryLedger: state.retryLedger,
    pauseRequested: state.pauseRequested,
    shutdownRequested: state.shutdownRequested,
    consecutiveHealthFailures: state.consecutiveHealthFailures,
    interventionReason: state.interventionReason,
    awaitingInterventionSince: state.awaitingInterventionSince,
    foremanStartedAt: state.foremanStartedAt,
    lastContinueAsNewAt: new Date().toISOString(),
  };
}

function shouldContinueAsNew(state: ForemanState, input: ForemanInput): boolean {
  if (state.iterationCount >= input.maxIterations) return true;
  const elapsed = Date.now() - state.startTimestamp;
  if (elapsed >= input.maxWallClockMs) return true;
  return false;
}

function shouldRunHealthCheck(state: ForemanState, input: ForemanInput): boolean {
  if (!state.lastHealthCheckAt) return true;
  const elapsed = Date.now() - Date.parse(state.lastHealthCheckAt);
  return elapsed >= input.healthCheckIntervalMs;
}

function makeResult(
  status: ForemanResult["status"],
  state: ForemanState,
  shutdownReason?: string | null,
  error?: string | null,
): ForemanResult {
  return {
    status,
    totalIterations: state.totalIterations,
    totalDispatches: state.totalDispatches,
    totalCompletions: state.totalCompletions,
    totalFailures: state.totalFailures,
    totalEscalations: state.totalEscalations,
    shutdownReason: shutdownReason ?? null,
    error: error ?? null,
  };
}

function buildStatusSnapshot(state: ForemanState): ForemanStatus {
  return {
    phase: state.phase,
    currentBeadId: state.currentBeadId,
    currentWorkflowId: state.currentWorkflowId,
    iterationCount: state.iterationCount,
    lifetimeIterations: state.totalIterations,
    lifetimeDispatches: state.totalDispatches,
    lifetimeCompletions: state.totalCompletions,
    lifetimeFailures: state.totalFailures,
    lifetimeEscalations: state.totalEscalations,
    uptime: Date.now() - Date.parse(state.foremanStartedAt),
    lastHealthCheck: state.lastHealthCheck,
    recentOutcomes: state.recentOutcomes,
    retryLedger: state.retryLedger,
    paused: state.pauseRequested,
    shuttingDown: state.shutdownRequested,
    interventionReason: state.interventionReason,
    awaitingInterventionSince: state.awaitingInterventionSince,
  };
}

/**
 * Build a human-readable annotation string for a dispatch outcome.
 * Used by outcome reconciliation to annotate beads with failure/abort/budget context.
 */
function buildOutcomeAnnotation(result: DispatchResult, outcome: DispatchOutcome): string {
  const parts: string[] = [
    `[foreman] Dispatch outcome: ${result.kind}`,
    `Attempt: ${outcome.attempt}`,
    `Duration: ${outcome.durationMs}ms`,
    `Cost: $${outcome.totalCost.toFixed(2)}`,
    `Workflow: ${outcome.workflowId}`,
  ];

  switch (result.kind) {
    case "failed":
      parts.push(`Error: ${result.error}`);
      parts.push(`Retryable: ${result.retryable}`);
      break;
    case "timeout":
      parts.push(`Elapsed: ${result.elapsedMs}ms / Timeout: ${result.timeoutMs}ms`);
      break;
    case "validation_failed":
      if (result.missing.length > 0) parts.push(`Missing: ${result.missing.join(", ")}`);
      if (result.violations.length > 0) parts.push(`Violations: ${result.violations.join(", ")}`);
      break;
    case "budget_exceeded":
      parts.push(`Actual cost: $${result.actualCost.toFixed(2)} / Budget: $${result.budgetUsd.toFixed(2)}`);
      break;
    case "aborted":
      parts.push(`Reason: ${result.reason}`);
      break;
  }

  if (outcome.audit) {
    parts.push(`Audit verdict: ${outcome.audit.verdict} (${outcome.audit.findingCount} findings)`);
  }

  return parts.join(" | ");
}

/**
 * Build AgentTaskInput from a DispatchPlan + ForemanInput.
 * ADR Section 11.2.
 */
function buildChildInput(plan: DispatchPlan, input: ForemanInput): AgentTaskInput {
  return {
    prompt: plan.prompt,
    agent: plan.agent,
    title: plan.title,
    kiloHost: input.kiloHost,
    kiloPort: input.kiloPort,
    timeoutMs: plan.timeoutMs,
    doltConfig: {
      host: input.doltHost,
      port: input.doltPort,
      database: input.doltDatabase,
    },
    cardId: plan.cardId ?? undefined,
    enforcedOnly: plan.enforcedOnly,
    costBudget: {
      maxSessionCostUsd: plan.costBudgetUsd,
    },
  };
}

/**
 * Build a simple dispatch plan from a BeadCandidate.
 * In the future, evaluateDispatchability activity will produce this.
 * For now, the workflow constructs it directly from config defaults.
 */
function buildDispatchPlan(candidate: BeadCandidate, input: ForemanInput): DispatchPlan {
  return {
    beadId: candidate.beadId,
    prompt: `Execute bead ${candidate.beadId}: ${candidate.title}`,
    agent: "code",
    title: `foreman: ${candidate.beadId} — ${candidate.title}`,
    timeoutMs: input.defaultTimeoutMs,
    costBudgetUsd: input.defaultCostBudgetUsd,
    cardId: null,
    enforcedOnly: false,
  };
}

// ── Workflow ──

export async function foremanWorkflow(input: ForemanInput): Promise<ForemanResult> {
  const state = initializeState(input, Date.now());
  let config = { ...input };

  // ── Register signal handlers ──

  setHandler(pauseSignal, () => {
    state.pauseRequested = true;
  });

  setHandler(resumeSignal, () => {
    state.pauseRequested = false;
    // Resume also clears intervention state (operator acknowledging)
    if (state.phase === "awaiting_intervention") {
      state.interventionResumed = true;
      state.interventionReason = null;
      state.awaitingInterventionSince = null;
      state.consecutiveHealthFailures = 0;
    }
  });

  setHandler(shutdownSignal, ({ reason }) => {
    state.shutdownRequested = true;
    state.shutdownReason = reason;
  });

  setHandler(forceDispatchSignal, ({ beadId }) => {
    state.forceDispatchQueue.push(beadId);
  });

  setHandler(skipBeadSignal, ({ beadId }) => {
    if (!state.skipList.includes(beadId)) {
      state.skipList.push(beadId);
    }
  });

  setHandler(updateConfigSignal, (partial) => {
    // Merge partial config; immutable fields are not overwritten
    const { workflowId: _wf, repoPath: _rp, carriedState: _cs, ...safe } = partial;
    config = { ...config, ...safe };
  });

  setHandler(approveOutcomeSignal, ({ beadId, decision }) => {
    state.outcomeApproval = { beadId, decision };
  });

  setHandler(approveDispatchSignal, ({ beadId }) => {
    if (!state.approvedDispatchBeadIds.includes(beadId)) {
      state.approvedDispatchBeadIds.push(beadId);
    }
  });

  // ── Register query handlers ──

  setHandler(foremanStatusQuery, () => buildStatusSnapshot(state));
  setHandler(foremanHealthQuery, () => state.lastHealthCheck);
  setHandler(foremanHistoryQuery, () => state.recentOutcomes);

  // ── Check for shutdown from previous continue-as-new ──

  if (state.shutdownRequested) {
    return makeResult("shutdown", state, state.shutdownReason);
  }

  // ── Main control loop ──

  try {
    while (true) {
      // -- Check continue-as-new thresholds --
      if (shouldContinueAsNew(state, config)) {
        await continueAsNew<typeof foremanWorkflow>({
          ...config,
          carriedState: serializeState(state),
        });
      }

      // -- Check operator signals --
      if (state.shutdownRequested) {
        return makeResult("shutdown", state, state.shutdownReason);
      }

      if (state.pauseRequested) {
        state.phase = "paused";
        await condition(() => !state.pauseRequested || state.shutdownRequested);
        if (state.shutdownRequested) {
          return makeResult("shutdown", state, state.shutdownReason);
        }
        continue; // Re-enter loop after resume
      }

      // -- Check for forced dispatch --
      const forcedBeadId = state.forceDispatchQueue.shift() ?? null;

      // -- Phase: Health Check (throttled) --
      if (shouldRunHealthCheck(state, config)) {
        state.phase = "health_check";
        state.lastHealthCheck = await quick.checkStackHealth({
          repoPath: config.repoPath,
          doltHost: config.doltHost,
          doltPort: config.doltPort,
          doltDatabase: config.doltDatabase,
          kiloHost: config.kiloHost,
          kiloPort: config.kiloPort,
        });
        state.lastHealthCheckAt = state.lastHealthCheck.checkedAt;
      }

      // If health gate fails, track consecutive failures and potentially escalate
      if (state.lastHealthCheck?.overall === "fail") {
        state.consecutiveHealthFailures++;

        if (state.consecutiveHealthFailures >= config.healthFailureThreshold) {
          // Persistent unhealthy stack — escalate to operator
          const failedSubsystems = Object.entries(state.lastHealthCheck.subsystems)
            .filter(([, sub]) => sub.status === "down")
            .map(([name]) => name);
          const reason = `Persistent health failure (${state.consecutiveHealthFailures} consecutive): ${failedSubsystems.join(", ")} down`;

          state.phase = "awaiting_intervention";
          state.interventionReason = reason;
          state.awaitingInterventionSince = new Date().toISOString();

          // Create escalation bead for the health failure
          await durable.createEscalation({
            repoPath: config.repoPath,
            beadId: `health-${Date.now()}`,
            reason,
            outcomes: [],
            retryEntry: {
              beadId: "health-check",
              attempts: state.consecutiveHealthFailures,
              maxAttempts: config.healthFailureThreshold,
              lastAttemptAt: state.lastHealthCheck.checkedAt,
              lastError: reason,
              lastResult: { kind: "failed", error: reason, retryable: false },
              nextRetryAfter: new Date().toISOString(),
              exhausted: true,
            },
          });
          state.totalEscalations++;

          // Wait for operator resume signal
          await condition(() => state.interventionResumed || state.shutdownRequested);
          if (state.shutdownRequested) {
            return makeResult("shutdown", state, state.shutdownReason);
          }

          // Operator resumed — clear intervention state, re-check health
          state.interventionResumed = false;
          state.phase = "polling";
          continue;
        }

        // Below threshold — idle and retry on next iteration
        state.phase = "idle";
        await sleep(config.pollIntervalMs);
        state.iterationCount++;
        state.totalIterations++;
        continue;
      }

      // Health passed (or no check yet) — reset consecutive failure counter
      state.consecutiveHealthFailures = 0;

      // -- Phase: Select --
      state.phase = "selecting";
      let candidate: BeadCandidate | null = null;

      try {
        if (forcedBeadId) {
          // Force dispatch: fetch the specific bead detail
          const detail = await quick.getBeadDetail(config.repoPath, forcedBeadId);
          candidate = {
            beadId: detail.beadId,
            title: detail.title,
            priority: detail.priority,
            labels: detail.labels,
            dependsOn: detail.dependsOn,
            estimatedComplexity: detail.estimatedComplexity,
          };
        } else {
          candidate = await quick.selectNextBead({
            repoPath: config.repoPath,
            retryLedger: state.retryLedger,
            skipList: state.skipList,
          });
        }
      } catch (activityErr: unknown) {
        if (isBeadsContractError(activityErr)) {
          // Irrecoverable CLI/schema failure — await operator intervention
          const errMsg = activityErr instanceof Error ? activityErr.message : String(activityErr);
          state.phase = "awaiting_intervention";
          state.interventionReason = `BeadsContractError during selection: ${errMsg}`;
          state.awaitingInterventionSince = new Date().toISOString();
          state.totalEscalations++;

          await condition(() => state.interventionResumed || state.shutdownRequested);
          if (state.shutdownRequested) {
            return makeResult("shutdown", state, state.shutdownReason);
          }

          // Operator resumed — retry the failed operation once
          state.interventionResumed = false;
          state.interventionReason = null;
          state.awaitingInterventionSince = null;
          state.phase = "polling";
          continue;
        }
        throw activityErr; // Re-throw non-contract errors for outer catch
      }

      if (!candidate) {
        state.phase = "idle";
        await sleep(config.pollIntervalMs);
        state.iterationCount++;
        state.totalIterations++;
        continue;
      }

      // -- Phase: Pre-dispatch approval gate --
      // If bead has sensitive/human-required labels, require operator approval
      const requiresApproval = candidate.labels.some(
        (l) => l === "requires-human" || l === "sensitive" || l === "requires-approval",
      );

      if (requiresApproval && !state.approvedDispatchBeadIds.includes(candidate.beadId)) {
        state.phase = "awaiting_approval";
        state.interventionReason = `Policy-required approval before dispatch: bead ${candidate.beadId} has labels [${candidate.labels.join(", ")}]`;
        state.awaitingInterventionSince = new Date().toISOString();

        // Wait for operator approveDispatch signal for this bead
        await condition(
          () =>
            state.approvedDispatchBeadIds.includes(candidate!.beadId) ||
            state.shutdownRequested,
        );

        if (state.shutdownRequested) {
          return makeResult("shutdown", state, state.shutdownReason);
        }

        // Approval received — clear intervention state and proceed
        state.interventionReason = null;
        state.awaitingInterventionSince = null;
      }

      // -- Phase: Dispatch --
      state.phase = "dispatching";
      state.currentBeadId = candidate.beadId;
      const plan = buildDispatchPlan(candidate, config);

      // Claim the bead
      try {
        await quick.updateBeadStatus(config.repoPath, candidate.beadId, "in_progress");
      } catch (claimErr: unknown) {
        if (isBeadsContractError(claimErr)) {
          const errMsg = claimErr instanceof Error ? claimErr.message : String(claimErr);
          state.phase = "awaiting_intervention";
          state.interventionReason = `BeadsContractError during bead claim: ${errMsg}`;
          state.awaitingInterventionSince = new Date().toISOString();
          state.totalEscalations++;

          await condition(() => state.interventionResumed || state.shutdownRequested);
          if (state.shutdownRequested) {
            return makeResult("shutdown", state, state.shutdownReason);
          }

          state.interventionResumed = false;
          state.interventionReason = null;
          state.awaitingInterventionSince = null;
          state.phase = "polling";
          continue;
        }
        throw claimErr;
      }

      // Start child workflow
      const childInput = buildChildInput(plan, config);
      const childWorkflowId = `foreman-dispatch-${candidate.beadId}-${Date.now()}`;
      state.currentWorkflowId = childWorkflowId;

      // -- Phase: Monitor --
      state.phase = "monitoring";
      const dispatchStartedAt = new Date().toISOString();

      const childHandle = await startChild(agentTaskWorkflow, {
        workflowId: childWorkflowId,
        args: [childInput],
        taskQueue: config.taskQueue,
      });

      // Wait for child completion
      const agentResult = await childHandle.result();

      const dispatchCompletedAt = new Date().toISOString();
      const dispatchResult = toDispatchResult(agentResult);
      const durationMs = Date.parse(dispatchCompletedAt) - Date.parse(dispatchStartedAt);

      const outcome: DispatchOutcome = {
        beadId: candidate.beadId,
        workflowId: childWorkflowId,
        sessionId: agentResult.sessionId,
        startedAt: dispatchStartedAt,
        completedAt: dispatchCompletedAt,
        durationMs,
        totalCost: agentResult.totalCost,
        tokensInput: agentResult.tokensInput,
        tokensOutput: agentResult.tokensOutput,
        result: dispatchResult,
        audit: agentResult.audit,
        attempt: (state.retryLedger.find((e) => e.beadId === candidate!.beadId)?.attempts ?? 0) + 1,
      };

      // -- Record outcome --
      state.recentOutcomes = pushOutcome(state.recentOutcomes, outcome);
      state.currentBeadId = null;
      state.currentWorkflowId = null;
      state.totalDispatches++;

      // -- Phase: Outcome Reconciliation --
      // Maps durable child workflow outcomes into correct bead mutations.
      // Rules:
      //   completed       → bd close (happy path), or await approval if requires-approval label
      //   failed/timeout  → annotate + retry or escalate
      //   aborted         → annotate + leave open
      //   validation_failed/budget_exceeded → annotate + escalate or leave open
      switch (dispatchResult.kind) {
        case "completed": {
          // Check if bead requires operator approval before close
          const needsOutcomeApproval = candidate.labels.includes("requires-approval");

          if (needsOutcomeApproval) {
            state.phase = "awaiting_approval";
            state.interventionReason = `Outcome requires approval before close: bead ${candidate.beadId}`;
            state.awaitingInterventionSince = new Date().toISOString();

            // Wait for operator approveOutcome signal
            await condition(
              () =>
                (state.outcomeApproval !== null &&
                  state.outcomeApproval.beadId === candidate!.beadId) ||
                state.shutdownRequested,
            );

            if (state.shutdownRequested) {
              return makeResult("shutdown", state, state.shutdownReason);
            }

            const approval = state.outcomeApproval!;
            state.outcomeApproval = null;
            state.interventionReason = null;
            state.awaitingInterventionSince = null;

            switch (approval.decision) {
              case "close":
                state.phase = "completing";
                await durable.closeBead({
                  repoPath: config.repoPath,
                  beadId: candidate.beadId,
                  outcome,
                });
                state.totalCompletions++;
                removeFromRetryLedger(state.retryLedger, candidate.beadId);
                break;
              case "retry":
                // Put bead back to ready for re-dispatch on next iteration
                await quick.updateBeadStatus(config.repoPath, candidate.beadId, "ready");
                break;
              case "skip":
                if (!state.skipList.includes(candidate.beadId)) {
                  state.skipList.push(candidate.beadId);
                }
                await quick.updateBeadStatus(config.repoPath, candidate.beadId, "ready");
                break;
            }
          } else {
            state.phase = "completing";
            await durable.closeBead({
              repoPath: config.repoPath,
              beadId: candidate.beadId,
              outcome,
            });
            state.totalCompletions++;
            removeFromRetryLedger(state.retryLedger, candidate.beadId);
          }
          break;
        }

        case "failed":
        case "timeout":
        case "validation_failed": {
          state.phase = "failing";

          // Annotate the bead with failure context for audit trail
          const failAnnotation = buildOutcomeAnnotation(dispatchResult, outcome);
          await durable.annotateBead({
            repoPath: config.repoPath,
            beadId: candidate.beadId,
            comment: failAnnotation,
          });

          const retryEntry = updateRetryLedger(
            state.retryLedger,
            candidate.beadId,
            dispatchResult,
            config.maxRetriesPerBead,
            config.retryBackoffMs,
            dispatchCompletedAt,
          );

          if (!retryEntry.exhausted && isRetryable(dispatchResult)) {
            state.phase = "retrying";
            // Backoff is enforced by nextRetryAfter in the ledger;
            // the bead will be skipped by selectNextBead until backoff expires
          } else {
            state.phase = "escalating";

            // Collect all outcomes for this bead across attempts
            const beadOutcomes = state.recentOutcomes.filter(
              (o) => o.beadId === candidate!.beadId,
            );

            // Determine escalation reason
            const escalationReason = retryEntry.exhausted
              ? "Retry exhaustion"
              : `Non-retryable ${dispatchResult.kind}`;

            // Create escalation bead for human intervention
            await durable.createEscalation({
              repoPath: config.repoPath,
              beadId: candidate.beadId,
              reason: escalationReason,
              outcomes: beadOutcomes,
              retryEntry,
            });

            // Unclaim the bead so human can re-trigger
            await quick.updateBeadStatus(config.repoPath, candidate.beadId, "ready");
            state.totalFailures++;
            state.totalEscalations++;
          }
          break;
        }

        case "budget_exceeded": {
          state.phase = "escalating";

          // Annotate with budget exceeded details
          const budgetAnnotation = buildOutcomeAnnotation(dispatchResult, outcome);
          await durable.annotateBead({
            repoPath: config.repoPath,
            beadId: candidate.beadId,
            comment: budgetAnnotation,
          });

          // Collect all outcomes for this bead
          const beadOutcomes = state.recentOutcomes.filter(
            (o) => o.beadId === candidate!.beadId,
          );

          // Budget exceeded is non-retryable — always escalate
          // Build a synthetic retry entry for the escalation
          const budgetRetryEntry = updateRetryLedger(
            state.retryLedger,
            candidate.beadId,
            dispatchResult,
            config.maxRetriesPerBead,
            config.retryBackoffMs,
            dispatchCompletedAt,
          );

          await durable.createEscalation({
            repoPath: config.repoPath,
            beadId: candidate.beadId,
            reason: "Budget exceeded",
            outcomes: beadOutcomes,
            retryEntry: budgetRetryEntry,
          });

          await quick.updateBeadStatus(config.repoPath, candidate.beadId, "ready");
          state.totalFailures++;
          state.totalEscalations++;
          break;
        }

        case "aborted": {
          // Annotate with abort reason, leave bead open for manual intervention
          const abortAnnotation = buildOutcomeAnnotation(dispatchResult, outcome);
          await durable.annotateBead({
            repoPath: config.repoPath,
            beadId: candidate.beadId,
            comment: abortAnnotation,
          });

          await quick.updateBeadStatus(config.repoPath, candidate.beadId, "ready");
          break;
        }
      }

      state.iterationCount++;
      state.totalIterations++;
    }
  } catch (err: unknown) {
    if (isCancellation(err)) {
      return makeResult("shutdown", state, "workflow cancelled");
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return makeResult("failed", state, null, errorMsg);
  }
}
