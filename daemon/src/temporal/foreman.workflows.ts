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
  };
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

      // If health gate fails, idle and retry
      if (state.lastHealthCheck?.overall === "fail") {
        state.phase = "idle";
        await sleep(config.pollIntervalMs);
        state.iterationCount++;
        state.totalIterations++;
        continue;
      }

      // -- Phase: Select --
      state.phase = "selecting";
      let candidate: BeadCandidate | null = null;

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

      if (!candidate) {
        state.phase = "idle";
        await sleep(config.pollIntervalMs);
        state.iterationCount++;
        state.totalIterations++;
        continue;
      }

      // -- Phase: Dispatch --
      state.phase = "dispatching";
      state.currentBeadId = candidate.beadId;
      const plan = buildDispatchPlan(candidate, config);

      // Claim the bead
      await quick.updateBeadStatus(config.repoPath, candidate.beadId, "in_progress");

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

      // -- Phase: Handle Outcome --
      switch (dispatchResult.kind) {
        case "completed": {
          state.phase = "completing";
          await durable.closeBead({
            repoPath: config.repoPath,
            beadId: candidate.beadId,
            outcome,
          });
          state.totalCompletions++;
          removeFromRetryLedger(state.retryLedger, candidate.beadId);
          break;
        }

        case "failed":
        case "timeout":
        case "validation_failed": {
          state.phase = "failing";
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
            // Unclaim the bead so human can re-trigger
            await quick.updateBeadStatus(config.repoPath, candidate.beadId, "ready");
            state.totalFailures++;
            state.totalEscalations++;
          }
          break;
        }

        case "budget_exceeded": {
          state.phase = "escalating";
          await quick.updateBeadStatus(config.repoPath, candidate.beadId, "ready");
          state.totalFailures++;
          state.totalEscalations++;
          break;
        }

        case "aborted": {
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
