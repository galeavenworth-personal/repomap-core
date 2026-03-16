
import { createOpencodeClient } from "@opencode-ai/sdk/client";

import { classifyEvent, RawEvent } from "../classifier/index.js";
import { asRecord, pickDate, pickNumber, pickString, pickTimestamp } from "../infra/record-utils.js";
import { DoltWriter } from "../writer/index.js";
import { writeTextMessagePart, writeToolPart } from "./write-parts.js";

type Client = ReturnType<typeof createOpencodeClient>;

interface Session {
  id: string;
  // Current SDK shape: time.created / time.updated as epoch ms
  time?: { created?: number; updated?: number };
  // Legacy fields (may not exist in current SDK)
  updatedAt?: string;
  status?: string;
  createdAt?: string;
  parentID?: string;
  title?: string;
  [key: string]: unknown;
}

interface Message {
  parts?: Record<string, unknown>[];
  role?: string;
  [key: string]: unknown;
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
    const wrapper = asRecord(message);
    // SDK returns {info, parts} — unwrap
    const msgInfo = asRecord(wrapper.info);
    const parts = (wrapper.parts as Record<string, unknown>[]) || [];
    const messageRole = pickString(msgInfo, "role") ?? "assistant";
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
  const createdMs = session.time?.created;
  await writer.writeSession({
    sessionId: session.id,
    taskId: session.id,
    status: session.status,
    startedAt: createdMs ? new Date(createdMs) : pickDate(session, "createdAt"),
  });
  await replayLifecycleEvents(session, writer);
  await replayMessageParts(client, session, writer);
  await replayChildren(client, session, writer);
}

interface RunCatchUpOptions {
  sinceMs?: number;
}

function resolveUpdatedMs(session: Session): number | undefined {
  const updatedMs = session.time?.updated;
  if (typeof updatedMs === "number" && Number.isFinite(updatedMs)) {
    return updatedMs;
  }
  if (session.updatedAt) {
    const parsed = new Date(session.updatedAt).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export async function runCatchUp(
  client: Client,
  writer: DoltWriter,
  options?: RunCatchUpOptions
): Promise<number> {
  console.log("[oc-daemon] Starting batch catch-up...");

  try {
    const { data: sessions, error } = await client.session.list();
    if (error) {
      console.error("[oc-daemon] Catch-up failed to list sessions:", error);
      return 0;
    }

    const oneDayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
    const sinceMs = options?.sinceMs ?? oneDayAgoMs;
    const recentSessions = (sessions as unknown as Session[]).filter((s) => {
      const updatedMs = resolveUpdatedMs(s);
      return typeof updatedMs === "number" && updatedMs >= sinceMs;
    });

    const catchUpMode = options?.sinceMs
      ? `since ${new Date(sinceMs).toISOString()}`
      : "within last 24h";
    console.log(
      `[oc-daemon] Found ${recentSessions.length} sessions to catch up (${catchUpMode}).`
    );

    for (const session of recentSessions) {
      await catchUpSession(client, session, writer);
    }

    const inserted = await writer.syncChildRelsFromPunches();
    console.log(`[oc-daemon] Synced ${inserted} child_rels rows from child_spawn punches.`);

    console.log("[oc-daemon] Catch-up complete.");
    return recentSessions.length;
  } catch (err) {
    console.error("[oc-daemon] Catch-up error:", err);
    return 0;
  }
}
