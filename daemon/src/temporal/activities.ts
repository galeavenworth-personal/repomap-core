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

import { heartbeat, log } from "@temporalio/activity";
import { createOpencodeClient } from "@opencode-ai/sdk/client";

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
}

export interface AgentResult {
  sessionId: string;
  totalParts: number;
  toolCalls: number;
  durationMs: number;
}

function makeClient(config: KiloConfig) {
  return createOpencodeClient({
    baseUrl: `http://${config.kiloHost}:${config.kiloPort}`,
  });
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
  timeoutMs: number = 1_800_000 // 30 minutes
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
    });

    if (snapshot.done) {
      log.info(
        `Session ${sessionId} completed: ${snapshot.toolCalls} tools, ${snapshot.totalParts} parts, ${Math.round(elapsed / 1000)}s`
      );
      return {
        sessionId,
        totalParts: snapshot.totalParts,
        toolCalls: snapshot.toolCalls,
        durationMs: elapsed,
      };
    }

    if (snapshot.runningTools > 0) {
      log.info(
        `[${Math.round(elapsed / 1000)}s] Running: ${snapshot.runningTools} tools, last: ${snapshot.lastToolName}`
      );
    } else {
      log.info(
        `[${Math.round(elapsed / 1000)}s] Parts: ${snapshot.totalParts}, tools: ${snapshot.toolCalls}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Get a progress snapshot from session messages.
 */
async function getProgressSnapshot(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string
): Promise<ProgressSnapshot> {
  // Get message parts for detailed progress
  const { data: messages } = await client.session.messages({
    path: { id: sessionId },
  });

  let totalParts = 0;
  let toolCalls = 0;
  let completedTools = 0;
  let runningTools = 0;
  let lastToolName: string | null = null;
  let lastPartType: string | null = null;

  if (messages) {
    for (const group of messages as unknown[]) {
      const items = Array.isArray(group) ? group : [group];
      for (const msg of items) {
        if (!msg || typeof msg !== "object") continue;
        const parts = (msg as Record<string, unknown>).parts as
          | Array<Record<string, unknown>>
          | undefined;
        if (!parts) continue;

        for (const part of parts) {
          totalParts++;
          lastPartType = (part.type as string) ?? null;
          if (part.type === "tool") {
            toolCalls++;
            const state = part.state as Record<string, unknown> | undefined;
            const status = state?.status as string | undefined;
            if (status === "completed" || status === "error") {
              completedTools++;
            } else if (status === "running" || status === "pending") {
              runningTools++;
            }
            lastToolName = (part.tool as string) ?? lastToolName;
          }
        }
      }
    }
  }

  // Session is done when: there are parts, no tools are running/pending,
  // and the last part is a terminal type (step-finish, patch, or text after tools)
  const hasContent = totalParts > 1; // More than just the user prompt
  const noActiveTools = runningTools === 0;
  const isTerminal =
    lastPartType === "step-finish" ||
    lastPartType === "patch" ||
    (lastPartType === "text" && toolCalls > 0);
  const done = hasContent && noActiveTools && isTerminal;

  return {
    totalParts,
    toolCalls,
    completedTools,
    runningTools,
    lastToolName,
    done,
  };
}
