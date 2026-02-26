/**
 * Temporal Workflows — Thin Client for kilo serve
 *
 * Workflows are deterministic orchestration functions. They contain NO I/O —
 * all external calls happen in Activities. Temporal persists workflow state
 * and replays from the last checkpoint on failure.
 *
 * This is a thin durability wrapper. All orchestration intelligence lives in
 * the kilo serve mode system (.kilocodemodes), contracts, and workflows.
 * Temporal adds: retry, durability, observability. Nothing else.
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  sleep,
  CancellationScope,
  isCancellation,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";

const {
  healthCheck,
  createSession,
  sendPrompt,
  pollUntilDone,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "35 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "5s",
    maximumInterval: "60s",
    backoffCoefficient: 2,
  },
});

// Cleanup activities that must run even during cancellation
const { abortSession } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2, initialInterval: "1s" },
});

// Override for short-lived activities
const quickActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    maximumInterval: "30s",
    backoffCoefficient: 2,
  },
});

// ── Signals ──

export const abortSignal = defineSignal("abort");

// ── Queries ──

export interface AgentTaskStatus {
  phase: string;
  sessionId: string | null;
  toolCalls: number;
  totalParts: number;
  elapsedMs: number;
  error: string | null;
}

export const statusQuery = defineQuery<AgentTaskStatus>("status");

// ── Workflow Input ──

export interface AgentTaskInput {
  prompt: string;
  agent?: string;
  title?: string;
  kiloHost?: string;
  kiloPort?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Dolt config for punch card validation (omit to skip validation). */
  doltConfig?: { host: string; port: number; database: string; user?: string; password?: string };
  /** Card ID to validate against after completion. */
  cardId?: string;
  /** Task ID for punch card validation (defaults to sessionId). */
  punchCardTaskId?: string;
}

export interface AgentTaskResult {
  status: "completed" | "aborted" | "failed" | "validation_failed";
  sessionId: string | null;
  totalParts: number;
  toolCalls: number;
  durationMs: number;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
  error: string | null;
}

// ── Workflow ──

export async function agentTaskWorkflow(
  input: AgentTaskInput
): Promise<AgentTaskResult> {
  const config = {
    kiloHost: input.kiloHost ?? "127.0.0.1",
    kiloPort: input.kiloPort ?? 4096,
  };

  const startTime = Date.now();
  let aborted = false;

  const state: AgentTaskStatus = {
    phase: "initializing",
    sessionId: null,
    toolCalls: 0,
    totalParts: 0,
    elapsedMs: 0,
    error: null,
  };

  // Register signal/query handlers
  setHandler(abortSignal, () => {
    aborted = true;
  });
  setHandler(statusQuery, () => ({
    ...state,
    elapsedMs: Date.now() - startTime,
  }));

  try {
    // Step 1: Health check
    state.phase = "health_check";
    await quickActivities.healthCheck(config);

    if (aborted) return makeResult("aborted", state, startTime);

    // Step 2: Create session
    state.phase = "creating_session";
    const { sessionId } = await quickActivities.createSession(config, input.title);
    state.sessionId = sessionId;

    if (aborted) return makeResult("aborted", state, startTime);

    // Step 3: Send prompt (the mode system handles all orchestration)
    state.phase = "sending_prompt";
    await sendPrompt(config, sessionId, input.prompt, input.agent);

    if (aborted) return makeResult("aborted", state, startTime);

    // Step 4: Brief pause to let the agent start processing
    await sleep("3 seconds");

    // Step 5: Poll until done (activity heartbeats keep Temporal informed)
    state.phase = "agent_working";
    const result = await pollUntilDone(
      config,
      sessionId,
      input.pollIntervalMs ?? 10_000,
      input.timeoutMs ?? 1_800_000,
    );

    state.totalParts = result.totalParts;
    state.toolCalls = result.toolCalls;

    // Step 6: Validate punch card (if configured)
    if (input.doltConfig && input.cardId) {
      state.phase = "validating";
      const validation = await quickActivities.validateTaskPunchCard(
        input.doltConfig,
        input.punchCardTaskId ?? sessionId,
        input.cardId,
      );
      if (validation.status === "fail") {
        state.phase = "validation_failed";
        state.error = `Punch card validation failed: missing=[${validation.missing.join(", ")}] violations=[${validation.violations.join(", ")}]`;
        return makeResult("validation_failed", state, startTime, result);
      }
    }

    state.phase = "completed";
    return makeResult("completed", state, startTime, result);
  } catch (err: unknown) {
    // On cancellation, abort the kilo serve session so it stops burning tokens
    if (isCancellation(err) && state.sessionId) {
      await CancellationScope.nonCancellable(async () => {
        await abortSession(config, state.sessionId!);
      });
      state.phase = "aborted";
      return makeResult("aborted", state, startTime);
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    state.phase = "failed";
    state.error = errorMsg;
    return makeResult("failed", state, startTime);
  }
}

function makeResult(
  status: AgentTaskResult["status"],
  state: AgentTaskStatus,
  startTime: number,
  agentResult?: { totalCost: number; tokensInput: number; tokensOutput: number }
): AgentTaskResult {
  return {
    status,
    sessionId: state.sessionId,
    totalParts: state.totalParts,
    toolCalls: state.toolCalls,
    durationMs: Date.now() - startTime,
    totalCost: agentResult?.totalCost ?? 0,
    tokensInput: agentResult?.tokensInput ?? 0,
    tokensOutput: agentResult?.tokensOutput ?? 0,
    error: state.error,
  };
}
