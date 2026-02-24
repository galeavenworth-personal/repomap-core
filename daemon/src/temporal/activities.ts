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
import { createOpencodeClient } from "@opencode-ai/sdk/client";
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
}

export interface BudgetLimits {
  maxTokens: number;
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  maxTokens: 100_000,
  maxCostUsd: 1.0,
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

function makeClient(config: KiloConfig) {
  return createOpencodeClient({
    baseUrl: `http://${config.kiloHost}:${config.kiloPort}`,
  });
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
  const client = makeClient(config);
  const response = await client.session.list();
  if (response.error) {
    throw new Error(`kilo serve health check failed: ${JSON.stringify(response.error)}`);
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
  const client = makeClient(config);
  const response = await client.session.create({});
  if (response.error || !response.data) {
    throw new Error(`Failed to create session: ${JSON.stringify(response.error)}`);
  }
  const sessionId = response.data.id;
  log.info(`Session created: ${sessionId}`);

  if (title) {
    try {
      await client.session.update({
        path: { id: sessionId },
        body: { title } as Record<string, unknown>,
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
 */
export async function sendPrompt(
  config: KiloConfig,
  sessionId: string,
  prompt: string,
  agent?: string
): Promise<void> {
  const client = makeClient(config);
  const response = await client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text: prompt }],
      agent,
    },
  });
  if (response.error) {
    throw new Error(`Prompt dispatch failed for session ${sessionId}: ${JSON.stringify(response.error)}`);
  }
  log.info(`Prompt dispatched to session ${sessionId} (${prompt.length} chars)`);
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
  const client = makeClient(config);
  const startTime = Date.now();

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new Error(
        `Session ${sessionId} timed out after ${Math.round(elapsed / 1000)}s`
      );
    }

    const snapshot = await getProgressSnapshot(client, sessionId);

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
}

/** Extract flat parts from raw message groups. */
function flattenMessageParts(messages: unknown): Array<Record<string, unknown>> {
  if (!messages) return [];

  const parts: Array<Record<string, unknown>> = [];
  for (const group of messages as unknown[]) {
    const items = Array.isArray(group) ? group : [group];
    for (const msg of items) {
      if (!msg || typeof msg !== "object") continue;
      const msgParts = (msg as Record<string, unknown>).parts as
        | Array<Record<string, unknown>>
        | undefined;
      if (msgParts) parts.push(...msgParts);
    }
  }
  return parts;
}

/** Accumulate tool statistics and cost/token data from a single part. */
function accumulatePart(acc: PartAccumulator, part: Record<string, unknown>): void {
  acc.totalParts++;
  acc.lastPartType = (part.type as string) ?? null;

  // step-finish parts carry cost and token data
  if (part.type === "step-finish") {
    if (typeof part.cost === "number") acc.totalCost += part.cost;
    if (typeof part.tokensInput === "number") acc.tokensInput += part.tokensInput;
    if (typeof part.tokensOutput === "number") acc.tokensOutput += part.tokensOutput;
    // Also check nested usage object
    const usage = part.usage as Record<string, unknown> | undefined;
    if (usage) {
      if (typeof usage.inputTokens === "number") acc.tokensInput += usage.inputTokens;
      if (typeof usage.outputTokens === "number") acc.tokensOutput += usage.outputTokens;
      if (typeof usage.input_tokens === "number") acc.tokensInput += usage.input_tokens;
      if (typeof usage.output_tokens === "number") acc.tokensOutput += usage.output_tokens;
    }
  }

  if (part.type !== "tool") return;

  acc.toolCalls++;
  const status = (part.state as Record<string, unknown> | undefined)?.status as string | undefined;
  if (status === "completed" || status === "error") {
    acc.completedTools++;
  } else if (status === "running" || status === "pending") {
    acc.runningTools++;
  }
  acc.lastToolName = (part.tool as string) ?? acc.lastToolName;
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
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string
): Promise<ProgressSnapshot> {
  const { data: messages } = await client.session.messages({
    path: { id: sessionId },
  });

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
