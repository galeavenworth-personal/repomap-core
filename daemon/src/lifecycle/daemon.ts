/**
 * Daemon Lifecycle
 *
 * Manages the daemon's connection to kilo serve and Dolt,
 * subscribes to the SSE event stream, and orchestrates the
 * classify → mint → write pipeline.
 *
 * Lifecycle:
 *   1. Connect to kilo serve (verify health)
 *   2. Connect to Dolt
 *   3. Subscribe to SSE event stream
 *   4. For each event: classify → write punch (if punch-worthy)
 *   5. On shutdown: unsubscribe, disconnect, exit cleanly
 */

import { createOpencodeClient } from "@opencode-ai/sdk/client";

import { classifyEvent, type RawEvent } from "../classifier/index.js";
import { createDoltWriter, type DoltWriter } from "../writer/index.js";
import { runCatchUp } from "./catchup.js";

export interface DaemonConfig {
  kiloPort: number;
  kiloHost: string;
  doltPort: number;
  doltHost: string;
  doltDatabase: string;
  doltUser?: string;
  doltPassword?: string;
}

export interface Daemon {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type OcClient = ReturnType<typeof createOpencodeClient>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickDate(record: Record<string, unknown>, ...keys: string[]): Date | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Date) return value;
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return undefined;
}

function pickTimestamp(record: Record<string, unknown>): number {
  const ts = pickNumber(record, "ts", "timestamp", "time", "createdAtMs");
  if (typeof ts === "number") return ts;
  const created = pickDate(record, "createdAt", "updatedAt");
  return created ? created.getTime() : Date.now();
}

/** Record child session relationships when a session completes. */
async function recordSessionChildren(
  client: OcClient,
  writer: DoltWriter,
  taskId: string
): Promise<void> {
  try {
    const { data: children } = await client.session.children({
      path: { id: taskId },
    });
    if (!children) return;
    for (const child of children) {
      await writer.writeChildRelation(taskId, child.id);
    }
  } catch (e) {
    console.error("[oc-daemon] Failed to record children:", e);
  }
}

/** Process a single SSE event through the classify → write pipeline. */
async function processEvent(
  client: OcClient,
  writer: DoltWriter,
  event: unknown
): Promise<void> {
  const rawEvent = event as RawEvent;
  const punch = classifyEvent(rawEvent);
  if (!punch) return;

  await writer.writePunch(punch);

  if (rawEvent.type === "session.created" || rawEvent.type === "session.updated") {
    const info = asRecord(asRecord(rawEvent.properties).info);
    const sessionId = pickString(info, "id", "sessionId", "taskId") ?? punch.taskId;
    const tokens = asRecord(info.tokens);
    await writer.writeSession({
      sessionId,
      taskId: pickString(info, "taskId", "id"),
      mode: pickString(info, "mode"),
      model: pickString(info, "model", "inferenceModel"),
      status: pickString(info, "status"),
      totalCost: pickNumber(info, "totalCost", "cost", "costUsd"),
      tokensIn: pickNumber(info, "tokensIn") ?? pickNumber(tokens, "input"),
      tokensOut: pickNumber(info, "tokensOut") ?? pickNumber(tokens, "output"),
      tokensReasoning: pickNumber(info, "tokensReasoning") ?? pickNumber(tokens, "reasoning"),
      startedAt: pickDate(info, "startedAt", "createdAt"),
      completedAt: pickDate(info, "completedAt"),
      outcome: pickString(info, "outcome"),
    });
  }

  const part = asRecord(asRecord(rawEvent.properties).part);
  const partType = pickString(part, "type");

  if (punch.punchType === "message" || partType === "text") {
    const role = pickString(part, "role") ?? pickString(asRecord(rawEvent.properties), "role") ?? "assistant";
    const previewSource = pickString(part, "text") ?? pickString(part, "content") ?? "";
    await writer.writeMessage({
      sessionId: punch.taskId,
      role,
      contentType: partType ?? "text",
      contentPreview: previewSource.slice(0, 512),
      ts: pickTimestamp(part),
      cost: pickNumber(part, "cost") ?? punch.cost,
      tokensIn: pickNumber(asRecord(part.tokens), "input") ?? punch.tokensInput,
      tokensOut: pickNumber(asRecord(part.tokens), "output") ?? punch.tokensOutput,
    });
  }

  if (punch.punchType === "tool_call") {
    const state = asRecord(part.state);
    const status = pickString(state, "status");
    const args = part.input;
    await writer.writeToolCall({
      sessionId: punch.taskId,
      toolName: punch.punchKey,
      argsSummary: typeof args === "string" ? args : args ? JSON.stringify(args).slice(0, 1024) : undefined,
      status,
      error: pickString(state, "error"),
      durationMs: pickNumber(part, "durationMs"),
      cost: punch.cost,
      ts: pickTimestamp(part),
    });
  }

  if (punch.punchKey === "session_completed") {
    await recordSessionChildren(client, writer, punch.taskId);
  }
}

/** Return true if the error is an expected AbortError during shutdown. */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function createDaemon(config: DaemonConfig): Daemon {
  const client = createOpencodeClient({
    baseUrl: `http://${config.kiloHost}:${config.kiloPort}`,
  });

  const writer: DoltWriter = createDoltWriter({
    host: config.doltHost,
    port: config.doltPort,
    database: config.doltDatabase,
    user: config.doltUser,
    password: config.doltPassword,
  });

  const abortController = new AbortController();

  return {
    async start() {
      console.log(
        `[oc-daemon] Connecting to kilo serve at ${config.kiloHost}:${config.kiloPort}`
      );
      await writer.connect();
      console.log(
        `[oc-daemon] Connected to Dolt at ${config.doltHost}:${config.doltPort}`
      );

      await runCatchUp(client, writer);

      let backoffMs = 1000;
      const maxBackoffMs = 30000;

      while (!abortController.signal.aborted) {
        try {
          console.log("[oc-daemon] Subscribing to SSE event stream...");
          const { stream } = await client.event.subscribe({
            signal: abortController.signal,
          });

          backoffMs = 1000;

          for await (const event of stream) {
            await processEvent(client, writer, event);
          }
          console.log("[oc-daemon] SSE stream ended. Reconnecting...");
        } catch (error: unknown) {
          if (isAbortError(error) || abortController.signal.aborted) break;
          console.error("[oc-daemon] SSE stream error:", error);
        }

        if (!abortController.signal.aborted) {
          console.log(`[oc-daemon] Waiting ${backoffMs}ms before reconnecting...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        }
      }
      console.log("[oc-daemon] Event loop exited.");
    },

    async stop() {
      console.log("[oc-daemon] Shutting down...");
      abortController.abort();
      await writer.disconnect();
      console.log("[oc-daemon] Shutdown complete.");
    },
  };
}
