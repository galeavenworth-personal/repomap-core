import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { createHash } from "node:crypto";

import { classifyEvent, type RawEvent } from "../classifier/index.js";
import { PunchCardValidator } from "../governor/punch-card-validator.js";
import { DEFAULT_MODE_CARD_MAP, loadModeCardMap } from "../infra/mode-card-map.js";
import { sortKeysDeep } from "../infra/utils.js";
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
  // Direct numeric timestamp fields
  const ts = pickNumber(record, "ts", "timestamp", "createdAtMs");
  if (typeof ts === "number") return ts;

  // Current SDK shape: nested `time` object with epoch ms fields
  const timeObj = record.time;
  if (timeObj && typeof timeObj === "object") {
    const t = timeObj as Record<string, unknown>;
    const nested = pickNumber(t, "start", "end", "created", "updated", "completed");
    if (typeof nested === "number") return nested;
  }

  // Legacy ISO string dates
  const created = pickDate(record, "createdAt", "updatedAt");
  if (created) return created.getTime();

  // Only warn once per event type to reduce log spam
  return Date.now();
}

function computeRawEventSourceHash(event: RawEvent): string {
  const canonical = JSON.stringify(
    sortKeysDeep({
      type: event.type,
      properties: event.properties,
    })
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function extractRawEventSessionId(event: RawEvent): string {
  const properties = asRecord(event.properties);
  if (event.type === "message.part.updated") {
    const part = asRecord(properties.part);
    return pickString(part, "sessionID", "sessionId", "taskId") ?? "unknown";
  }
  if (event.type === "message.updated" || event.type === "message.removed") {
    const info = asRecord(properties.info);
    return pickString(info, "sessionID", "sessionId") ?? pickString(properties, "sessionID") ?? "unknown";
  }
  if (event.type.startsWith("session.")) {
    const info = asRecord(properties.info);
    return pickString(info, "id", "sessionId", "taskId") ?? "unknown";
  }
  return pickString(properties, "sessionId", "taskId") ?? "unknown";
}

function extractRawEventTs(event: RawEvent): Date | undefined {
  const properties = asRecord(event.properties);

  // Direct top-level date fields (legacy)
  const direct = pickDate(properties, "ts", "timestamp", "createdAt", "updatedAt");
  if (direct) return direct;

  if (event.type === "message.part.updated") {
    const part = asRecord(properties.part);
    // Current SDK: part.time.start / part.time.end (epoch ms)
    const timeObj = asRecord(part.time);
    const epochMs = pickNumber(timeObj, "start", "end", "created");
    if (typeof epochMs === "number") return new Date(epochMs);
    return new Date(pickTimestamp(part));
  }

  if (event.type === "message.updated") {
    const info = asRecord(properties.info);
    // AssistantMessage: info.time.created / info.time.completed (epoch ms)
    const timeObj = asRecord(info.time);
    const epochMs = pickNumber(timeObj, "completed", "created");
    if (typeof epochMs === "number") return new Date(epochMs);
  }

  if (event.type.startsWith("session.")) {
    const info = asRecord(properties.info);
    // Current SDK: info.time.created / info.time.updated (epoch ms)
    const timeObj = asRecord(info.time);
    const epochMs = pickNumber(timeObj, "updated", "created");
    if (typeof epochMs === "number") return new Date(epochMs);
    // Legacy fallback
    return pickDate(info, "updatedAt", "createdAt", "startedAt", "completedAt");
  }

  return undefined;
}

function summarizeArgs(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  if (args) return JSON.stringify(args).slice(0, 1024);
  return undefined;
}

function resolveMessageRole(part: Record<string, unknown>, properties: Record<string, unknown>): string {
  const partRole = pickString(part, "role");
  if (partRole) return partRole;
  const eventRole = pickString(properties, "role");
  if (eventRole) return eventRole;
  return "assistant";
}

function pickMode(payload: Record<string, unknown>): string | undefined {
  const direct = pickString(payload, "mode", "agent");
  if (direct) return direct;

  const info = asRecord(payload.info);
  return pickString(info, "mode", "agent");
}

async function fetchSessionMode(config: DaemonConfig, taskId: string): Promise<string | undefined> {
  try {
    const response = await fetch(`http://${config.kiloHost}:${config.kiloPort}/session/${taskId}`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as Record<string, unknown>;
    return pickMode(body);
  } catch {
    return undefined;
  }
}

async function validateSessionCheckpoint(
  writer: DoltWriter,
  config: DaemonConfig,
  taskId: string,
  mode?: string,
): Promise<void> {
  const resolvedMode = mode ?? (await fetchSessionMode(config, taskId));
  if (!resolvedMode) {
    console.warn(`[oc-daemon] No mode resolved for session ${taskId}; skipping checkpoint validation`);
    return;
  }

  const modeCardMap = await loadModeCardMap(DEFAULT_MODE_CARD_MAP);
  const cardId = modeCardMap[resolvedMode];
  if (!cardId) {
    console.warn(`[oc-daemon] No punch card configured for mode '${resolvedMode}'; skipping validation`);
    return;
  }

  const validator = new PunchCardValidator({
    host: config.doltHost,
    port: config.doltPort,
    database: config.doltDatabase,
    user: config.doltUser,
    password: config.doltPassword,
  });

  try {
    await validator.connect();
    const result = await validator.validatePunchCard(taskId, cardId);
    const details = {
      missing: result.missing.map((m) => `${m.punchType}:${m.punchKeyPattern}`),
      violations: result.violations.map((v) => `${v.punchType}:${v.punchKeyPattern} (${v.count}x)`),
    };

    await writer.writeCheckpoint({
      taskId,
      cardId,
      status: result.status,
      validatedAt: new Date(),
      missingPunches: JSON.stringify(details),
    });

    if (result.status === "pass") {
      console.log(`[oc-daemon] CHECKPOINT PASS: ${cardId} for ${taskId}`);
    } else {
      console.warn(
        `[oc-daemon] CHECKPOINT FAIL: ${cardId} for ${taskId} missing=[${details.missing.join(", ")}] violations=[${details.violations.join(", ")}]`
      );
    }
  } catch (error) {
    console.error(`[oc-daemon] Checkpoint validation failed for ${taskId}:`, error);
  } finally {
    await validator.disconnect();
  }
}

/**
 * Record child session relationships when a session completes.
 *
 * LIMITATION: child_complete:child_return punches are minted for every child
 * session ID when the parent completes, without verifying that each child
 * actually reached a terminal state. The daemon processes events asynchronously
 * so child completion status may not yet be available at the time the parent's
 * session_completed event fires. A future improvement could query each child's
 * status and filter accordingly.
 */
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
      // TODO: Verify child session actually completed before minting child_complete punch.
      // Currently assumes completion because the daemon processes events asynchronously
      // and child terminal status may not be available yet.
      console.warn(
        `[oc-daemon] Minting child_complete punch for child ${child.id} of parent ${taskId} — child completion assumed, not verified`
      );
      await writer.writePunch({
        taskId,
        punchType: "child_complete",
        punchKey: "child_return",
        observedAt: new Date(),
        sourceHash: createHash("sha256")
          .update(`child_complete:${taskId}:${child.id}`)
          .digest("hex"),
      });
    }
  } catch (e) {
    console.error("[oc-daemon] Failed to record children:", e);
  }
}

async function projectSessionEvent(writer: DoltWriter, rawEvent: RawEvent): Promise<void> {
  const properties = asRecord(rawEvent.properties);

  // Handle session.created / session.updated — current SDK Session shape
  if (rawEvent.type === "session.created" || rawEvent.type === "session.updated") {
    const info = asRecord(properties.info);
    const sessionId =
      pickString(info, "id", "sessionId", "taskId") ?? extractRawEventSessionId(rawEvent);

    // Current SDK: time.created / time.updated are epoch ms
    const timeObj = asRecord(info.time);
    const createdMs = pickNumber(timeObj, "created");
    const updatedMs = pickNumber(timeObj, "updated");

    await writer.writeSession({
      sessionId,
      taskId: pickString(info, "taskId") ?? sessionId,
      // Session type has no mode/model/status/cost — those come from message.updated
      startedAt: createdMs ? new Date(createdMs) : pickDate(info, "startedAt", "createdAt"),
    });
    return;
  }

  // Handle message.updated — AssistantMessage carries cost, tokens, mode, model, finish
  if (rawEvent.type === "message.updated") {
    const info = asRecord(properties.info);
    const sessionId = pickString(info, "sessionID", "sessionId") ?? extractRawEventSessionId(rawEvent);
    const role = pickString(info, "role");

    // Only assistant messages carry cost/token/mode data
    if (role !== "assistant") return;

    const tokens = asRecord(info.tokens);
    const timeObj = asRecord(info.time);
    const createdMs = pickNumber(timeObj, "created");
    const completedMs = pickNumber(timeObj, "completed");
    const finish = pickString(info, "finish");

    // Determine session status from the finish field
    // finish values: undefined (still running), "end" (completed), "abort", "error", etc.
    let status: string | undefined;
    if (finish === "end") status = "completed";
    else if (finish === "abort" || finish === "error") status = finish;
    else if (finish) status = finish;

    await writer.writeSession({
      sessionId,
      taskId: pickString(info, "taskId") ?? sessionId,
      mode: pickString(info, "mode"),
      model: pickString(info, "modelID"),
      status,
      totalCost: pickNumber(info, "cost"),
      tokensIn: pickNumber(tokens, "input"),
      tokensOut: pickNumber(tokens, "output"),
      tokensReasoning: pickNumber(tokens, "reasoning"),
      completedAt: completedMs ? new Date(completedMs) : undefined,
      outcome: finish,
    });

    await writer.writeTask({
      taskId: pickString(info, "taskId") ?? sessionId,
      mode: pickString(info, "mode") ?? "unknown",
      model: pickString(info, "modelID") ?? undefined,
      status,
      costUsd: pickNumber(info, "cost") ?? undefined,
      startedAt: createdMs ? new Date(createdMs) : new Date(),
      completedAt: completedMs ? new Date(completedMs) : undefined,
    });

    return;
  }
}

/** Process a single SSE event through the classify → write pipeline. */
async function processEvent(
  client: OcClient,
  writer: DoltWriter,
  config: DaemonConfig,
  event: unknown
): Promise<void> {
  const rawEvent = event as RawEvent;
  const observedAt = new Date();
  const rawEventWriter = writer as DoltWriter & {
    writeRawEvent?: (event: {
      sourceHash: string;
      sessionId: string;
      eventType: string;
      eventTs?: Date;
      observedAt: Date;
      payloadJson: string;
    }) => Promise<void>;
  };
  if (typeof rawEventWriter.writeRawEvent === "function") {
    await rawEventWriter.writeRawEvent({
      sourceHash: computeRawEventSourceHash(rawEvent),
      sessionId: extractRawEventSessionId(rawEvent),
      eventType: rawEvent.type,
      eventTs: extractRawEventTs(rawEvent),
      observedAt,
      payloadJson: JSON.stringify(rawEvent),
    });
  }
  await projectSessionEvent(writer, rawEvent);

  const punch = classifyEvent(rawEvent);
  if (!punch) return;

  await writer.writePunch(punch);
  const properties = asRecord(rawEvent.properties);

  const part = asRecord(properties.part);
  const partType = pickString(part, "type");

  if (punch.punchType === "message" || partType === "text") {
    const role = resolveMessageRole(part, properties);
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
      argsSummary: summarizeArgs(args),
      status,
      error: pickString(state, "error"),
      durationMs: pickNumber(part, "durationMs"),
      cost: punch.cost,
      ts: pickTimestamp(part),
    });
  }

  if (punch.punchKey === "session_completed") {
    await recordSessionChildren(client, writer, punch.taskId);
    // For message.updated events, mode is on the AssistantMessage info directly
    // For session.updated events (legacy), mode was on the session info
    const info = asRecord(properties.info);
    const mode = pickString(info, "mode");
    await validateSessionCheckpoint(writer, config, punch.taskId, mode);
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
            await processEvent(client, writer, config, event);
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
