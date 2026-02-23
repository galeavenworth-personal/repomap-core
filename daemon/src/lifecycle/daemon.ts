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
  const punch = classifyEvent(event as RawEvent);
  if (!punch) return;

  await writer.writePunch(punch);
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
