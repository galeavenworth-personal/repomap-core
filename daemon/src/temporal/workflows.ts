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
  CancellationScope,
  isCancellation,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";

const {
  healthCheck,
  createSession,
  sendPrompt,
  pollUntilDone,
  buildBootstrapManifest,
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

// Cleanup + punch activities that must run even during cancellation
const { abortSession, punchCard } = proxyActivities<typeof activities>({
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
  maxTokens?: number;
  maxCostUsd?: number;
  /** Bootstrap config — if provided, builds a manifest before sending the prompt. */
  repoDir?: string;
  bdPath?: string;
  epicId?: string;
}

export interface AgentTaskResult {
  status: "completed" | "aborted" | "failed" | "budget_exceeded";
  sessionId: string | null;
  totalParts: number;
  toolCalls: number;
  durationMs: number;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
  budgetReason: string | null;
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

  const wfId = `wf-${Date.now()}`;
  const punch = (punchKey: string, extra?: Record<string, unknown>) =>
    punchCard({
      taskId: state.sessionId ?? wfId,
      punchType: "workflow",
      punchKey,
      ...extra,
    });

  try {
    // ── PUNCH: workflow_start ──
    await punch("workflow_start", {
      meta: { agent: input.agent, promptLen: input.prompt.length, maxTokens: input.maxTokens ?? 100_000, maxCostUsd: input.maxCostUsd ?? 1.0 },
    });

    // Step 1: Health check
    state.phase = "health_check";
    await quickActivities.healthCheck(config);
    await punch("health_check_passed");

    if (aborted) return makeResult("aborted", state, startTime);

    // Step 2: Create session
    state.phase = "creating_session";
    const { sessionId } = await quickActivities.createSession(config, input.title);
    state.sessionId = sessionId;

    // ── PUNCH: session_created ──
    await punchCard({
      taskId: sessionId,
      punchType: "workflow",
      punchKey: "session_created",
      meta: { agent: input.agent, workflowId: wfId },
    });

    if (aborted) return makeResult("aborted", state, startTime);

    // Step 3: Bootstrap manifest (if configured)
    let finalPrompt = input.prompt;
    if (input.repoDir && input.bdPath) {
      state.phase = "bootstrapping";
      const manifest = await buildBootstrapManifest({
        repoDir: input.repoDir,
        bdPath: input.bdPath,
        epicId: input.epicId,
      });

      // ── PUNCH: bootstrap_complete ──
      await punchCard({
        taskId: sessionId,
        punchType: "workflow",
        punchKey: "bootstrap_complete",
        meta: { targets: manifest.targets.length, branch: manifest.repo.branch, head: manifest.repo.head },
      });

      // Inject manifest into prompt — parent gets a digest, not a universe to crawl
      finalPrompt = `<bootstrap_manifest>\n${JSON.stringify(manifest, null, 2)}\n</bootstrap_manifest>\n\n${input.prompt}`;
    }

    if (aborted) return makeResult("aborted", state, startTime);

    // Step 4: Send prompt
    state.phase = "sending_prompt";
    await sendPrompt(config, sessionId, finalPrompt, input.agent);

    // ── PUNCH: prompt_dispatched ──
    await punchCard({
      taskId: sessionId,
      punchType: "workflow",
      punchKey: "prompt_dispatched",
      meta: { promptLen: finalPrompt.length, agent: input.agent, bootstrapped: !!input.repoDir },
    });

    if (aborted) return makeResult("aborted", state, startTime);

    // Step 4: Brief pause to let the agent start processing
    await sleep("3 seconds");

    // Step 5: Poll until done (activity heartbeats keep Temporal informed)
    state.phase = "agent_working";
    const bootstrapped = !!(input.repoDir && input.bdPath);
    const budget = {
      maxTokens: input.maxTokens ?? 100_000,
      maxCostUsd: input.maxCostUsd ?? 1.0,
      // Bootstrapped parent has everything it needs — zero exploration allowed
      maxExplorationBeforeDelegation: bootstrapped ? 0 : 3,
    };
    const result = await pollUntilDone(
      config,
      sessionId,
      input.pollIntervalMs ?? 10_000,
      input.timeoutMs ?? 1_800_000,
      budget
    );

    state.totalParts = result.totalParts;
    state.toolCalls = result.toolCalls;

    if (result.budgetExceeded) {
      // ── PUNCH: budget_kill ──
      state.phase = "budget_exceeded";
      state.error = result.budgetReason;
      await punchCard({
        taskId: sessionId,
        punchType: "governor",
        punchKey: "budget_kill",
        cost: result.totalCost,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
        meta: { reason: result.budgetReason },
      });
      return makeResult("budget_exceeded", state, startTime, result);
    }

    // ── PUNCH: session_completed ──
    state.phase = "completed";
    await punchCard({
      taskId: sessionId,
      punchType: "workflow",
      punchKey: "session_completed",
      cost: result.totalCost,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      meta: { tools: result.toolCalls, parts: result.totalParts, durationMs: result.durationMs },
    });
    return makeResult("completed", state, startTime, result);
  } catch (err: unknown) {
    // On cancellation, abort the kilo serve session so it stops burning tokens
    if (isCancellation(err) && state.sessionId) {
      await CancellationScope.nonCancellable(async () => {
        await abortSession(config, state.sessionId!);
        // ── PUNCH: session_aborted ──
        await punchCard({
          taskId: state.sessionId!,
          punchType: "governor",
          punchKey: "session_aborted",
          meta: { reason: "workflow_cancelled" },
        });
      });
      state.phase = "aborted";
      return makeResult("aborted", state, startTime);
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    state.phase = "failed";
    state.error = errorMsg;
    // ── PUNCH: workflow_failed ──
    await CancellationScope.nonCancellable(async () => {
      await punchCard({
        taskId: state.sessionId ?? wfId,
        punchType: "workflow",
        punchKey: "workflow_failed",
        meta: { error: errorMsg },
      });
    });
    return makeResult("failed", state, startTime);
  }
}

function makeResult(
  status: AgentTaskResult["status"],
  state: AgentTaskStatus,
  startTime: number,
  agentResult?: { totalCost: number; tokensInput: number; tokensOutput: number; budgetReason: string | null }
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
    budgetReason: agentResult?.budgetReason ?? null,
    error: state.error,
  };
}
