/**
 * Temporal Activities — Thin Client for kilo serve
 *
 * Activities contain all I/O: HTTP calls to kilo serve, polling, health checks.
 * Each activity is independently retryable by Temporal. The workflow orchestrates
 * the sequence; activities do the actual work.
 *
 * This is a thin durability wrapper. All orchestration intelligence lives in
 * the kilo serve mode system (.kilocodemodes), contracts, and workflows.
 * Temporal adds: retry, durability, observability. Nothing else.
 */

import { heartbeat, log } from "@temporalio/activity";

import type { DoltConfig } from "../writer/index.js";

export interface KiloConfig {
  kiloHost: string;
  kiloPort: number;
}

export interface SessionInfo {
  sessionId: string;
  title?: string;
}

export interface ProgressSnapshot {
  totalParts: number;
  toolCalls: number;
  completedTools: number;
  runningTools: number;
  lastToolName: string | null;
  done: boolean;
  thinking: boolean;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
}

export interface AgentResult {
  sessionId: string;
  totalParts: number;
  toolCalls: number;
  durationMs: number;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
}

function kiloUrl(config: KiloConfig, path: string): string {
  return `http://${config.kiloHost}:${config.kiloPort}${path}`;
}

/**
 * Health check — verify kilo serve is responding.
 */
export async function healthCheck(config: KiloConfig): Promise<string> {
  const res = await fetch(kiloUrl(config, "/session"));
  if (!res.ok) {
    throw new Error(`kilo serve health check failed: HTTP ${res.status}`);
  }
  log.info("kilo serve health check passed");
  return "ok";
}

/**
 * Create a new kilo serve session.
 */
export async function createSession(
  config: KiloConfig,
  title?: string
): Promise<SessionInfo> {
  const res = await fetch(kiloUrl(config, "/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) {
    throw new Error(`Failed to create session: HTTP ${res.status}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const sessionId = data.id as string;
  log.info(`Session created: ${sessionId}${title ? ` (${title})` : ""}`);

  return { sessionId, title };
}

/**
 * Find all child session IDs for a given parent.
 */
async function getChildSessionIds(config: KiloConfig, parentId: string): Promise<string[]> {
  try {
    const res = await fetch(kiloUrl(config, `/session/${parentId}/children`));
    if (!res.ok) return [];
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    return sessions.map((s) => s.id as string);
  } catch {
    return [];
  }
}

/**
 * Abort a single kilo serve session.
 */
async function abortOne(
  config: KiloConfig,
  sessionId: string
): Promise<boolean> {
  try {
    const res = await fetch(kiloUrl(config, `/session/${sessionId}/abort`), { method: "POST" });
    log.info(`Session ${sessionId} abort: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    log.warn(`Failed to abort session ${sessionId}: ${err}`);
    return false;
  }
}

/**
 * Abort a kilo serve session AND all its children.
 * Used for cancellation cleanup.
 */
export async function abortSession(
  config: KiloConfig,
  sessionId: string
): Promise<boolean> {
  const children = await getChildSessionIds(config, sessionId);
  // Abort children first, then parent
  for (const childId of children) {
    await abortOne(config, childId);
  }
  return abortOne(config, sessionId);
}

/**
 * Send a prompt to a kilo serve session.
 * Uses the ASYNC prompt endpoint (POST /session/{id}/prompt_async) so that
 * this activity returns immediately and pollUntilDone can monitor progress.
 * The sync endpoint (POST /session/{id}/message) blocks until the agent
 * finishes — which prevents pollUntilDone from ever being reached.
 */
export async function sendPrompt(
  config: KiloConfig,
  sessionId: string,
  prompt: string,
  agent?: string
): Promise<void> {
  const body = {
    parts: [{ type: "text", text: prompt }],
    ...(agent ? { agent } : {}),
  };

  const res = await fetch(kiloUrl(config, `/session/${sessionId}/prompt_async`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to send prompt (HTTP ${res.status}): ${text}`
    );
  }

  log.info(`Prompt dispatched async to session ${sessionId} (${prompt.length} chars)`);
}

/**
 * Find the active leaf session in a delegation tree.
 * Agents run serially (by design), so only the deepest child is active.
 * Walks the tree recursively: parent → children → grandchildren → ...
 * Returns the deepest session that has children, or the leaf.
 */
async function findActiveLeaf(config: KiloConfig, sessionId: string): Promise<string> {
  const children = await getChildSessionIds(config, sessionId);
  if (children.length === 0) return sessionId;
  // Last child is typically the most recent delegation
  const lastChild = children[children.length - 1];
  return findActiveLeaf(config, lastChild);
}

/**
 * Collect aggregate cost/token stats for an entire session tree.
 */
async function getTreeStats(
  config: KiloConfig,
  sessionId: string,
): Promise<{ totalCost: number; tokensInput: number; tokensOutput: number; totalParts: number; toolCalls: number; childCount: number }> {
  const snap = await getProgressSnapshot(config, sessionId);
  const children = await getChildSessionIds(config, sessionId);
  let totalCost = snap.totalCost;
  let tokensInput = snap.tokensInput;
  let tokensOutput = snap.tokensOutput;
  let totalParts = snap.totalParts;
  let toolCalls = snap.toolCalls;
  let childCount = children.length;

  for (const cid of children) {
    const childStats = await getTreeStats(config, cid);
    totalCost += childStats.totalCost;
    tokensInput += childStats.tokensInput;
    tokensOutput += childStats.tokensOutput;
    totalParts += childStats.totalParts;
    toolCalls += childStats.toolCalls;
    childCount += childStats.childCount;
  }

  return { totalCost, tokensInput, tokensOutput, totalParts, toolCalls, childCount };
}

/**
 * Poll a session tree until it completes. Heartbeats report progress to Temporal.
 *
 * Completion rules:
 * 1. A session with children is NEVER independently "done" — children must
 *    all be idle first. You can't orphan delegated work.
 * 2. Only the active leaf agent is polled for tool/thinking activity.
 *    Agents run serially, so parents naturally idle while children work.
 * 3. An agent with an open step (step-start without step-finish) is
 *    "thinking" and counts as active, even with no running tools.
 * 4. 6 consecutive idle confirmations (60s at 10s intervals) on the active
 *    leaf before declaring the whole tree done.
 */
export async function pollUntilDone(
  config: KiloConfig,
  sessionId: string,
  pollIntervalMs: number = 10_000,
  timeoutMs: number = 1_800_000, // 30 minutes
): Promise<AgentResult> {
  const startTime = Date.now();

  const REQUIRED_IDLE_CONFIRMATIONS = 6;
  let consecutiveIdleCount = 0;
  let lastLeafParts = 0;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new Error(
        `Session ${sessionId} timed out after ${Math.round(elapsed / 1000)}s`
      );
    }

    // ── Walk tree to find the active leaf ──
    const activeLeaf = await findActiveLeaf(config, sessionId);
    const leafSnap = await getProgressSnapshot(config, activeLeaf);

    // ── Aggregate tree stats for heartbeat/reporting ──
    const tree = await getTreeStats(config, sessionId);

    // Heartbeat with progress — Temporal uses this to detect liveness
    heartbeat({
      elapsed: Math.round(elapsed / 1000),
      totalParts: tree.totalParts,
      toolCalls: tree.toolCalls,
      cost: tree.totalCost,
      children: tree.childCount,
      activeLeaf: activeLeaf === sessionId ? "self" : activeLeaf.slice(0, 16),
    });

    // ── Determine if the active leaf is truly idle ──
    const leafIsActive =
      leafSnap.thinking ||       // has open step (step-start without step-finish)
      leafSnap.runningTools > 0 || // tools still running
      !leafSnap.done;            // hasn't reached a terminal state yet

    if (leafIsActive) {
      consecutiveIdleCount = 0;
      lastLeafParts = leafSnap.totalParts;

      const phase = leafSnap.thinking ? "thinking" : leafSnap.runningTools > 0 ? "tools_running" : "working";
      const leafLabel = activeLeaf === sessionId ? "" : ` | leaf: ${activeLeaf.slice(0, 16)}`;
      log.info(
        `[${Math.round(elapsed / 1000)}s] ${phase} | parts: ${tree.totalParts}, tools: ${tree.toolCalls} | $${tree.totalCost.toFixed(2)} | ${(tree.tokensInput + tree.tokensOutput).toLocaleString()} tok | children: ${tree.childCount}${leafLabel}`
      );
    } else {
      // Leaf looks idle — but reset counter if new parts appeared
      if (leafSnap.totalParts !== lastLeafParts) {
        consecutiveIdleCount = 0;
        lastLeafParts = leafSnap.totalParts;
      }
      consecutiveIdleCount++;

      if (consecutiveIdleCount >= REQUIRED_IDLE_CONFIRMATIONS) {
        log.info(
          `Session tree completed: root ${sessionId} + ${tree.childCount} children | $${tree.totalCost.toFixed(2)} total | ${Math.round(elapsed / 1000)}s`
        );
        return {
          sessionId,
          totalParts: tree.totalParts,
          toolCalls: tree.toolCalls,
          durationMs: elapsed,
          totalCost: tree.totalCost,
          tokensInput: tree.tokensInput,
          tokensOutput: tree.tokensOutput,
        };
      }

      const leafLabel = activeLeaf === sessionId ? "" : ` | leaf: ${activeLeaf.slice(0, 16)}`;
      log.info(
        `[${Math.round(elapsed / 1000)}s] idle (${consecutiveIdleCount}/${REQUIRED_IDLE_CONFIRMATIONS}) | parts: ${tree.totalParts}, tools: ${tree.toolCalls} | $${tree.totalCost.toFixed(2)}${leafLabel}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

interface PartAccumulator {
  totalParts: number;
  toolCalls: number;
  completedTools: number;
  runningTools: number;
  lastToolName: string | null;
  lastPartType: string | null;
  openSteps: number;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
}

/** Extract flat parts from message array (raw HTTP response format: [{info, parts}, ...]). */
function flattenMessageParts(messages: unknown): Array<Record<string, unknown>> {
  if (!messages || !Array.isArray(messages)) return [];

  const parts: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    // Direct parts array on message object
    const msgParts = m.parts as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(msgParts)) {
      parts.push(...msgParts);
    }
  }
  return parts;
}

/** Accumulate tool statistics and cost/token data from a single part. */
function accumulatePart(acc: PartAccumulator, part: Record<string, unknown>): void {
  acc.totalParts++;
  acc.lastPartType = (part.type as string) ?? null;

  // Track step-start / step-finish balance to detect "thinking" phase.
  // An open step (step-start without matching step-finish) means the agent
  // is actively processing — reasoning, preparing tool calls, etc.
  if (part.type === "step-start") {
    acc.openSteps++;
  }

  // step-finish parts carry cost and token data
  // Format: { cost: number, tokens: { input: number, output: number, reasoning?: number } }
  if (part.type === "step-finish") {
    acc.openSteps = Math.max(0, acc.openSteps - 1);
    if (typeof part.cost === "number") acc.totalCost += part.cost;
    const tokens = part.tokens as Record<string, unknown> | undefined;
    if (tokens) {
      if (typeof tokens.input === "number") acc.tokensInput += tokens.input;
      if (typeof tokens.output === "number") acc.tokensOutput += tokens.output;
    }
  }

  if (part.type !== "tool") return;

  acc.toolCalls++;
  const toolName = (part.tool as string) ?? "unknown";
  const status = (part.state as Record<string, unknown> | undefined)?.status as string | undefined;
  if (status === "completed" || status === "error") {
    acc.completedTools++;
  } else if (status === "running" || status === "pending") {
    acc.runningTools++;
  }
  acc.lastToolName = toolName;
}

/** Determine if the session is in a terminal state. */
function isSessionDone(acc: PartAccumulator): boolean {
  const hasContent = acc.totalParts > 1;
  const noActiveTools = acc.runningTools === 0;
  const isTerminal =
    acc.lastPartType === "step-finish" ||
    acc.lastPartType === "patch" ||
    (acc.lastPartType === "text" && acc.toolCalls > 0);
  return hasContent && noActiveTools && isTerminal;
}

/**
 * Check if a session has no running/pending tools in its messages.
 * kilo serve v7.x has no "status" field on session objects, so we
 * detect idleness from the message stream instead.
 */
async function isSessionIdle(config: KiloConfig, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(kiloUrl(config, `/session/${sessionId}/message`));
    if (!res.ok) return false;
    const messages = await res.json() as Array<Record<string, unknown>>;
    for (const msg of messages) {
      const parts = (msg.parts as Array<Record<string, unknown>>) ?? [];
      for (const part of parts) {
        if (part.type === "tool") {
          const status = (part.state as Record<string, unknown>)?.status;
          if (status === "running" || status === "pending") {
            return false;
          }
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a progress snapshot from session messages.
 */
async function getProgressSnapshot(
  config: KiloConfig,
  sessionId: string
): Promise<ProgressSnapshot> {
  // Raw HTTP (activities.ts was ported from SDK in ab95f6c to fix sync prompt() blocking)
  const url = `http://${config.kiloHost}:${config.kiloPort}/session/${sessionId}/message`;
  const empty: ProgressSnapshot = { totalParts: 0, toolCalls: 0, completedTools: 0, runningTools: 0, lastToolName: null, done: false, thinking: false, totalCost: 0, tokensInput: 0, tokensOutput: 0 };
  let messages: unknown;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log.warn(`getProgressSnapshot: ${res.status} for session ${sessionId}`);
      return empty;
    }
    messages = await res.json();
  } catch (err) {
    log.warn(`getProgressSnapshot fetch failed for session ${sessionId}: ${err}`);
    return empty;
  }

  const acc: PartAccumulator = {
    totalParts: 0,
    toolCalls: 0,
    completedTools: 0,
    runningTools: 0,
    lastToolName: null,
    lastPartType: null,
    openSteps: 0,
    totalCost: 0,
    tokensInput: 0,
    tokensOutput: 0,
  };

  for (const part of flattenMessageParts(messages)) {
    accumulatePart(acc, part);
  }

  return {
    totalParts: acc.totalParts,
    toolCalls: acc.toolCalls,
    completedTools: acc.completedTools,
    runningTools: acc.runningTools,
    lastToolName: acc.lastToolName,
    done: isSessionDone(acc),
    thinking: acc.openSteps > 0,
    totalCost: acc.totalCost,
    tokensInput: acc.tokensInput,
    tokensOutput: acc.tokensOutput,
  };
}

/**
 * Validate punch card for a completed task.
 * Called after pollUntilDone to verify the task meets its card requirements.
 */
export async function validateTaskPunchCard(
  doltConfig: Omit<DoltConfig, "password">,
  taskId: string,
  cardId: string,
): Promise<{ status: "pass" | "fail"; missing: string[]; violations: string[] }> {
  const fullConfig: DoltConfig = {
    ...doltConfig,
    password: process.env.DOLT_DB_PASSWORD,
  };
  const { PunchCardValidator } = await import("../governor/punch-card-validator.js");
  const validator = new PunchCardValidator(fullConfig);
  try {
    await validator.connect();
    const result = await validator.validatePunchCard(taskId, cardId);
    return {
      status: result.status,
      missing: result.missing.map((m) => `${m.punchType}:${m.punchKeyPattern}`),
      violations: result.violations.map(
        (v) => `${v.punchType}:${v.punchKeyPattern} (${v.count}x)`
      ),
    };
  } finally {
    await validator.disconnect();
  }
}
