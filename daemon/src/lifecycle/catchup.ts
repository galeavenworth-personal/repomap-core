
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
    const parts = (message as unknown as Message).parts || [];
    for (const part of parts) {
      const punch = classifyEvent({
        type: "message.part.updated",
        properties: { part: { ...part, sessionID: session.id } },
      });
      if (punch) await writer.writePunch(punch);
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

    console.log("[oc-daemon] Catch-up complete.");
  } catch (err) {
    console.error("[oc-daemon] Catch-up error:", err);
  }
}
