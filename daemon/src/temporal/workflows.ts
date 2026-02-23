/**
 * Temporal Workflows — Agent Task Orchestration
 *
 * Workflows are deterministic orchestration functions. They contain NO I/O —
 * all external calls happen in Activities. Temporal persists workflow state
 * and replays from the last checkpoint on failure.
 *
 * This module defines the agentTaskWorkflow, which replaces the manual
 * factory_dispatch.sh → poll → verify loop with a durable, queryable,
 * signal-aware workflow.
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  sleep,
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
}

export interface AgentTaskResult {
  status: "completed" | "aborted" | "failed";
  sessionId: string | null;
  totalParts: number;
  toolCalls: number;
  durationMs: number;
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

    // Step 3: Send prompt
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
      input.timeoutMs ?? 1_800_000
    );

    state.totalParts = result.totalParts;
    state.toolCalls = result.toolCalls;
    state.phase = "completed";

    return makeResult("completed", state, startTime);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    state.phase = "failed";
    state.error = errorMsg;
    return makeResult("failed", state, startTime);
  }
}

function makeResult(
  status: AgentTaskResult["status"],
  state: AgentTaskStatus,
  startTime: number
): AgentTaskResult {
  return {
    status,
    sessionId: state.sessionId,
    totalParts: state.totalParts,
    toolCalls: state.toolCalls,
    durationMs: Date.now() - startTime,
    error: state.error,
  };
}
