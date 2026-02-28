
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { DoltWriter } from "../writer/index.js";
import { classifyEvent, RawEvent } from "../classifier/index.js";

type Client = ReturnType<typeof createOpencodeClient>;

interface Session {
  id: string;
  updatedAt: string;
  status: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface Message {
  parts?: Record<string, unknown>[];
  role?: string;
  [key: string]: unknown;
}

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
  const createdAt = pickDate(record, "createdAt", "updatedAt");
  return createdAt ? createdAt.getTime() : Date.now();
}

function summarizeArgs(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  if (args) return JSON.stringify(args).slice(0, 1024);
  return undefined;
}

async function writeTextMessagePart(
  writer: DoltWriter,
  sessionId: string,
  partRecord: Record<string, unknown>,
  messageRole: string,
  punch: ReturnType<typeof classifyEvent>
): Promise<void> {
  const text = pickString(partRecord, "text", "content") ?? "";
  await writer.writeMessage({
    sessionId,
    role: pickString(partRecord, "role") ?? messageRole,
    contentType: "text",
    contentPreview: text.slice(0, 512),
    ts: pickTimestamp(partRecord),
    cost: pickNumber(partRecord, "cost") ?? punch?.cost,
    tokensIn: pickNumber(asRecord(partRecord.tokens), "input") ?? punch?.tokensInput,
    tokensOut: pickNumber(asRecord(partRecord.tokens), "output") ?? punch?.tokensOutput,
  });
}

async function writeToolPart(
  writer: DoltWriter,
  sessionId: string,
  partRecord: Record<string, unknown>,
  punch: ReturnType<typeof classifyEvent>
): Promise<void> {
  const state = asRecord(partRecord.state);
  const args = partRecord.input;
  const toolName = pickString(partRecord, "tool") ?? punch?.punchKey ?? "unknown_tool";
  await writer.writeToolCall({
    sessionId,
    toolName,
    argsSummary: summarizeArgs(args),
    status: pickString(state, "status"),
    error: pickString(state, "error"),
    durationMs: pickNumber(partRecord, "durationMs"),
    cost: pickNumber(partRecord, "cost") ?? punch?.cost,
    ts: pickTimestamp(partRecord),
  });
}

/** Emit synthetic lifecycle punches for a session (created + updated). */
async function replayLifecycleEvents(session: Session, writer: DoltWriter): Promise<void> {
  const createdPunch = classifyEvent({
    type: "session.created",
    properties: { info: session },
  });
  if (createdPunch) await writer.writePunch(createdPunch);

  const updatedPunch = classifyEvent({
    type: "session.updated",
    properties: { info: session },
  });
  if (updatedPunch) await writer.writePunch(updatedPunch);
}

/** Replay message parts as synthetic events for a session. */
async function replayMessageParts(
  client: Client,
  session: Session,
  writer: DoltWriter
): Promise<void> {
  const { data: messages, error: msgError } = await client.session.messages({
    path: { id: session.id },
  });
  if (msgError || !messages) return;

  for (const message of messages) {
    const typedMessage = message as unknown as Message;
    const parts = typedMessage.parts || [];
    const messageRole = typedMessage.role ?? "assistant";
    for (const part of parts) {
      const partRecord = asRecord(part);
      const punch = classifyEvent({
        type: "message.part.updated",
        properties: { part: { ...partRecord, sessionID: session.id } },
      });
      if (punch) await writer.writePunch(punch);

      const partType = pickString(partRecord, "type");
      if (partType === "text") {
        await writeTextMessagePart(writer, session.id, partRecord, messageRole, punch);
      } else if (partType === "tool") {
        await writeToolPart(writer, session.id, partRecord, punch);
      }
    }
  }
}

/** Record parent→child session relationships. */
async function replayChildren(
  client: Client,
  session: Session,
  writer: DoltWriter
): Promise<void> {
  const { data: children, error: childError } = await client.session.children({
    path: { id: session.id },
  });
  if (childError || !children) return;

  for (const child of children) {
    await writer.writeChildRelation(session.id, child.id);
  }
}

/** Process a single session during catch-up. */
async function catchUpSession(client: Client, session: Session, writer: DoltWriter): Promise<void> {
  await writer.writeSession({
    sessionId: session.id,
    taskId: session.id,
    status: session.status,
    startedAt: pickDate(session, "createdAt"),
    completedAt: session.status === "completed" ? pickDate(session, "updatedAt") : undefined,
  });
  await replayLifecycleEvents(session, writer);
  await replayMessageParts(client, session, writer);
  await replayChildren(client, session, writer);
}

export async function runCatchUp(client: Client, writer: DoltWriter) {
  console.log("[oc-daemon] Starting batch catch-up...");

  try {
    const { data: sessions, error } = await client.session.list();
    if (error) {
      console.error("[oc-daemon] Catch-up failed to list sessions:", error);
      return;
    }

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSessions = (sessions as unknown as Session[]).filter(
      (s) => new Date(s.updatedAt) > oneDayAgo
    );

    console.log(`[oc-daemon] Found ${recentSessions.length} sessions to catch up.`);

    for (const session of recentSessions) {
      await catchUpSession(client, session, writer);
    }

    const inserted = await writer.syncChildRelsFromPunches();
    console.log(`[oc-daemon] Synced ${inserted} child_rels rows from child_spawn punches.`);

    console.log("[oc-daemon] Catch-up complete.");
  } catch (err) {
    console.error("[oc-daemon] Catch-up error:", err);
  }
}
