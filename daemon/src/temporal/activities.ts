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
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`Failed to create session: HTTP ${res.status}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const sessionId = data.id as string;
  log.info(`Session created: ${sessionId}`);

  if (title) {
    try {
      await fetch(kiloUrl(config, `/session/${sessionId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch {
      log.warn(`Could not set session title: ${title}`);
    }
  }

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
 * Send a prompt to a kilo serve session (async dispatch).
 * Uses prompt_async endpoint so it returns immediately — the agent
 * processes in the background while pollUntilDone monitors progress.
 */
export async function sendPrompt(
  config: KiloConfig,
  sessionId: string,
  prompt: string,
  agent?: string
): Promise<void> {
  const url = `http://${config.kiloHost}:${config.kiloPort}/session/${sessionId}/prompt_async`;
  const body = JSON.stringify({
    parts: [{ type: "text", text: prompt }],
    ...(agent ? { agent } : {}),
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`Prompt dispatch failed (HTTP ${res.status}): ${text}`);
  }
  log.info(`Prompt dispatched async to session ${sessionId} (${prompt.length} chars)`);
}

/**
 * Poll a session until it completes. Heartbeats report progress to Temporal.
 * If this activity is killed/restarted, Temporal retries from scratch (the
 * session itself is durable on kilo serve's side).
 */
export async function pollUntilDone(
  config: KiloConfig,
  sessionId: string,
  pollIntervalMs: number = 10_000,
  timeoutMs: number = 1_800_000, // 30 minutes
): Promise<AgentResult> {
  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new Error(
        `Session ${sessionId} timed out after ${Math.round(elapsed / 1000)}s`
      );
    }

    // ── Snapshot parent ──
    const snapshot = await getProgressSnapshot(config, sessionId);
    const parentIdle = await isSessionIdle(config, sessionId);

    // ── Discover children (for completion tracking only) ──
    const childIds = await getChildSessionIds(config, sessionId);
    const childIdle: boolean[] = [];
    let childTreeCost = 0;
    for (const cid of childIds) {
      const cidle = await isSessionIdle(config, cid);
      childIdle.push(cidle);
      const csnap = await getProgressSnapshot(config, cid);
      childTreeCost += csnap.totalCost;
    }

    const totalTreeCost = snapshot.totalCost + childTreeCost;

    // Heartbeat with progress — Temporal uses this to detect liveness
    heartbeat({
      elapsed: Math.round(elapsed / 1000),
      totalParts: snapshot.totalParts,
      toolCalls: snapshot.toolCalls,
      cost: snapshot.totalCost,
      treeCost: totalTreeCost,
      children: childIds.length,
    });

    // ── Completion: parent done AND all children idle ──
    const allChildrenIdle = childIdle.every((idle) => idle);
    if (snapshot.done && parentIdle && allChildrenIdle) {
      log.info(
        `Session tree completed: parent ${sessionId} + ${childIds.length} children | $${totalTreeCost.toFixed(2)} total | ${Math.round(elapsed / 1000)}s`
      );
      return {
        sessionId,
        totalParts: snapshot.totalParts,
        toolCalls: snapshot.toolCalls,
        durationMs: elapsed,
        totalCost: totalTreeCost,
        tokensInput: snapshot.tokensInput,
        tokensOutput: snapshot.tokensOutput,
      };
    }

    // ── Logging ──
    const tokens = snapshot.tokensInput + snapshot.tokensOutput;
    const childSummary = childIds.length > 0
      ? ` | children: ${childIds.length} ($${childTreeCost.toFixed(2)})`
      : "";
    log.info(
      `[${Math.round(elapsed / 1000)}s] Parts: ${snapshot.totalParts}, tools: ${snapshot.toolCalls} | $${snapshot.totalCost.toFixed(2)} | ${tokens.toLocaleString()} tok | idle: ${parentIdle}${childSummary}`
    );

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

  // step-finish parts carry cost and token data
  // Format: { cost: number, tokens: { input: number, output: number, reasoning?: number } }
  if (part.type === "step-finish") {
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
 * Check session status via kilo serve API.
 * Returns true if the session is idle (not processing).
 */
async function isSessionIdle(config: KiloConfig, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(kiloUrl(config, `/session/${sessionId}`));
    if (!res.ok) return false;
    const data = await res.json() as Record<string, unknown>;
    // Session is idle when not actively processing
    return data.status === "idle" || data.status === "completed";
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
  let messages: unknown;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log.warn(`getProgressSnapshot: ${res.status} for session ${sessionId}`);
      return { totalParts: 0, toolCalls: 0, completedTools: 0, runningTools: 0, lastToolName: null, done: false, totalCost: 0, tokensInput: 0, tokensOutput: 0 };
    }
    messages = await res.json();
  } catch (err) {
    log.warn(`getProgressSnapshot fetch failed for session ${sessionId}: ${err}`);
    return { totalParts: 0, toolCalls: 0, completedTools: 0, runningTools: 0, lastToolName: null, done: false, totalCost: 0, tokensInput: 0, tokensOutput: 0 };
  }

  const acc: PartAccumulator = {
    totalParts: 0,
    toolCalls: 0,
    completedTools: 0,
    runningTools: 0,
    lastToolName: null,
    lastPartType: null,
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
  doltConfig: { host: string; port: number; database: string; user?: string; password?: string },
  taskId: string,
  cardId: string,
): Promise<{ status: "pass" | "fail"; missing: string[]; violations: string[] }> {
  const { PunchCardValidator } = await import("../governor/punch-card-validator.js");
  const validator = new PunchCardValidator(doltConfig);
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
