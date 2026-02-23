
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

export async function runCatchUp(client: Client, writer: DoltWriter) {
  console.log("[oc-daemon] Starting batch catch-up...");

  try {
    const { data: sessions, error } = await client.session.list();
    if (error) {
      console.error("[oc-daemon] Catch-up failed to list sessions:", error);
      return;
    }
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Filter sessions updated in last 24h
    // Cast to internal interface to avoid type issues if SDK types are incomplete or strict
    const recentSessions = (sessions as unknown as Session[]).filter((s) => {
      const updated = new Date(s.updatedAt);
      return updated > oneDayAgo;
    });

    console.log(`[oc-daemon] Found ${recentSessions.length} sessions to catch up.`);

    for (const session of recentSessions) {
      // 1. Simulate session.created?
      const createdEvent: RawEvent = {
        type: "session.created",
        properties: { info: session },
      };
      const createdPunch = classifyEvent(createdEvent);
      if (createdPunch) await writer.writePunch(createdPunch);

      // 2. Simulate session.updated (completion)
      const updatedEvent: RawEvent = {
        type: "session.updated",
        properties: { info: session },
      };
      const updatedPunch = classifyEvent(updatedEvent);
      if (updatedPunch) await writer.writePunch(updatedPunch);

      // 3. Fetch messages
      const { data: messages, error: msgError } = await client.session.messages({
        path: { id: session.id },
      });
      if (msgError || !messages) continue;

      for (const message of messages) {
        const parts = (message as unknown as Message).parts || [];

        for (const part of parts) {
          // Inject sessionID into part
          const partWithSession = { ...part, sessionID: session.id };

          const event: RawEvent = {
            type: "message.part.updated",
            properties: { part: partWithSession },
          };

          const punch = classifyEvent(event);
          if (punch) await writer.writePunch(punch);
        }
      }

      // 4. Fetch children
      const { data: children, error: childError } = await client.session.children({
        path: { id: session.id },
      });
      if (!childError && children) {
        for (const child of children) {
          await writer.writeChildRelation(session.id, child.id);
        }
      }
    }
    console.log("[oc-daemon] Catch-up complete.");
  } catch (err) {
    console.error("[oc-daemon] Catch-up error:", err);
  }
}
