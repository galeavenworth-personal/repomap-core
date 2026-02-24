/**
 * Temporal Activities — Agent Task Orchestration
 *
 * Activities contain all I/O: HTTP calls to kilo serve, polling, health checks.
 * Each activity is independently retryable by Temporal. The workflow orchestrates
 * the sequence; activities do the actual work.
 *
 * These wrap the existing prompt-driver and kilo serve SDK calls as Temporal-compatible
 * activity functions with heartbeat support.
 */

import { createHash } from "node:crypto";
import { heartbeat, log } from "@temporalio/activity";
import mysql from "mysql2/promise";

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
  /** Number of new_task tool calls (delegation events). */
  delegations: number;
  /** Number of codebase exploration tools called (read, bash, grep, etc). */
  explorationCalls: number;
}

export interface BudgetLimits {
  maxTokens: number;
  maxCostUsd: number;
  /** Max exploration tool calls allowed before a new_task delegation is required (default: 3). */
  maxExplorationBeforeDelegation: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  maxTokens: 100_000,
  maxCostUsd: 1.0,
  maxExplorationBeforeDelegation: 3,
};

export interface AgentResult {
  sessionId: string;
  totalParts: number;
  toolCalls: number;
  durationMs: number;
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
  budgetExceeded: boolean;
  budgetReason: string | null;
}

function kiloUrl(config: KiloConfig, path: string): string {
  return `http://${config.kiloHost}:${config.kiloPort}${path}`;
}

// ── Punch Card ──

export interface PunchCardConfig {
  doltHost: string;
  doltPort: number;
  doltDatabase: string;
  doltUser: string;
}

export const DEFAULT_PUNCH_CONFIG: PunchCardConfig = {
  doltHost: process.env.DOLT_HOST ?? "127.0.0.1",
  doltPort: parseInt(process.env.DOLT_PORT ?? "3307", 10),
  doltDatabase: process.env.DOLT_DATABASE ?? "plant",
  doltUser: process.env.DOLT_USER ?? "root",
};

export interface WorkflowPunch {
  taskId: string;
  punchType: string;
  punchKey: string;
  cost?: number;
  tokensInput?: number;
  tokensOutput?: number;
  meta?: Record<string, unknown>;
}

/**
 * Write a workflow-level punch to Dolt.
 * These are distinct from SSE-derived punches — they record workflow
 * phase transitions, budget kills, and enforcement decisions.
 */
export async function punchCard(
  punch: WorkflowPunch,
  punchConfig?: PunchCardConfig
): Promise<void> {
  const cfg = punchConfig ?? DEFAULT_PUNCH_CONFIG;
  const now = new Date();
  const sourceHash = createHash("sha256")
    .update(JSON.stringify({
      taskId: punch.taskId,
      punchType: punch.punchType,
      punchKey: punch.punchKey,
      ts: now.toISOString(),
      meta: punch.meta,
    }))
    .digest("hex");

  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: cfg.doltHost,
      port: cfg.doltPort,
      database: cfg.doltDatabase,
      user: cfg.doltUser,
    });

    // Ensure cost/token columns exist (idempotent)
    for (const col of ["cost DECIMAL(10,6) NULL", "tokens_input INT NULL", "tokens_output INT NULL"]) {
      try { await conn.execute(`ALTER TABLE punches ADD COLUMN ${col}`); } catch { /* already exists */ }
    }

    await conn.execute(
      `INSERT INTO punches (task_id, punch_type, punch_key, observed_at, source_hash, cost, tokens_input, tokens_output)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM punches WHERE source_hash = ?)`,
      [
        punch.taskId,
        punch.punchType,
        punch.punchKey,
        now,
        sourceHash,
        punch.cost ?? null,
        punch.tokensInput ?? null,
        punch.tokensOutput ?? null,
        sourceHash,
      ]
    );
    log.info(`PUNCH: ${punch.punchType}/${punch.punchKey} for ${punch.taskId}`);
  } catch (err) {
    log.warn(`Failed to write punch ${punch.punchType}/${punch.punchKey}: ${err}`);
  } finally {
    if (conn) await conn.end();
  }
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
 * Abort a kilo serve session. Used for budget enforcement and cancellation cleanup.
 */
export async function abortSession(
  config: KiloConfig,
  sessionId: string
): Promise<boolean> {
  try {
    const url = `http://${config.kiloHost}:${config.kiloPort}/session/${sessionId}/abort`;
    const res = await fetch(url, { method: "POST" });
    log.info(`Session ${sessionId} abort: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    log.warn(`Failed to abort session ${sessionId}: ${err}`);
    return false;
  }
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
  budget: BudgetLimits = DEFAULT_BUDGET
): Promise<AgentResult> {
  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new Error(
        `Session ${sessionId} timed out after ${Math.round(elapsed / 1000)}s`
      );
    }

    const snapshot = await getProgressSnapshot(config, sessionId);

    // Heartbeat with progress — Temporal uses this to detect liveness
    heartbeat({
      elapsed: Math.round(elapsed / 1000),
      totalParts: snapshot.totalParts,
      toolCalls: snapshot.toolCalls,
      completedTools: snapshot.completedTools,
      runningTools: snapshot.runningTools,
      lastTool: snapshot.lastToolName,
      cost: snapshot.totalCost,
      tokensIn: snapshot.tokensInput,
      tokensOut: snapshot.tokensOutput,
    });

    // ── Budget enforcement ──
    const totalTokens = snapshot.tokensInput + snapshot.tokensOutput;
    let budgetExceeded = false;
    let budgetReason: string | null = null;

    if (totalTokens > budget.maxTokens) {
      budgetExceeded = true;
      budgetReason = `Token budget exceeded: ${totalTokens.toLocaleString()} > ${budget.maxTokens.toLocaleString()}`;
    } else if (snapshot.totalCost > budget.maxCostUsd) {
      budgetExceeded = true;
      budgetReason = `Cost budget exceeded: $${snapshot.totalCost.toFixed(2)} > $${budget.maxCostUsd.toFixed(2)}`;
    } else if (
      snapshot.explorationCalls > budget.maxExplorationBeforeDelegation &&
      snapshot.delegations === 0
    ) {
      budgetExceeded = true;
      budgetReason = `Delegation required: ${snapshot.explorationCalls} exploration calls without a single new_task delegation (limit: ${budget.maxExplorationBeforeDelegation})`;
    }

    if (budgetExceeded) {
      log.warn(`BUDGET KILL: ${budgetReason} — aborting session ${sessionId}`);
      await abortSession(config, sessionId);
      return {
        sessionId,
        totalParts: snapshot.totalParts,
        toolCalls: snapshot.toolCalls,
        durationMs: elapsed,
        totalCost: snapshot.totalCost,
        tokensInput: snapshot.tokensInput,
        tokensOutput: snapshot.tokensOutput,
        budgetExceeded: true,
        budgetReason,
      };
    }

    if (snapshot.done) {
      log.info(
        `Session ${sessionId} completed: ${snapshot.toolCalls} tools, ${snapshot.totalParts} parts, $${snapshot.totalCost.toFixed(2)}, ${Math.round(elapsed / 1000)}s`
      );
      return {
        sessionId,
        totalParts: snapshot.totalParts,
        toolCalls: snapshot.toolCalls,
        durationMs: elapsed,
        totalCost: snapshot.totalCost,
        tokensInput: snapshot.tokensInput,
        tokensOutput: snapshot.tokensOutput,
        budgetExceeded: false,
        budgetReason: null,
      };
    }

    if (snapshot.runningTools > 0) {
      log.info(
        `[${Math.round(elapsed / 1000)}s] Running: ${snapshot.runningTools} tools, last: ${snapshot.lastToolName} | $${snapshot.totalCost.toFixed(2)} | ${totalTokens.toLocaleString()} tok`
      );
    } else {
      log.info(
        `[${Math.round(elapsed / 1000)}s] Parts: ${snapshot.totalParts}, tools: ${snapshot.toolCalls} | $${snapshot.totalCost.toFixed(2)} | ${totalTokens.toLocaleString()} tok`
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
  totalCost: number;
  tokensInput: number;
  tokensOutput: number;
  delegations: number;
  explorationCalls: number;
}

const EXPLORATION_TOOLS = new Set([
  "read", "read_file", "bash", "grep", "grep_search", "find", "find_by_name",
  "list_dir", "list_files", "search", "code_search", "codebase-retrieval",
]);

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

  // Track delegation and exploration
  if (toolName === "new_task") {
    acc.delegations++;
  } else if (EXPLORATION_TOOLS.has(toolName)) {
    acc.explorationCalls++;
  }
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
 * Get a progress snapshot from session messages.
 */
async function getProgressSnapshot(
  config: KiloConfig,
  sessionId: string
): Promise<ProgressSnapshot> {
  // Use raw HTTP instead of SDK to avoid ESM/response shape issues
  const url = `http://${config.kiloHost}:${config.kiloPort}/session/${sessionId}/message`;
  const res = await fetch(url);
  const messages = await res.json();

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
    delegations: 0,
    explorationCalls: 0,
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
    delegations: acc.delegations,
    explorationCalls: acc.explorationCalls,
  };
}
