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
}

export interface Daemon {
  start(): Promise<void>;
  stop(): Promise<void>;
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
  });

  const abortController = new AbortController();

  return {
    async start() {
      // 1. Connect to Dolt
      console.log(
        `[oc-daemon] Connecting to kilo serve at ${config.kiloHost}:${config.kiloPort}`
      );
      await writer.connect();
      console.log(
        `[oc-daemon] Connected to Dolt at ${config.doltHost}:${config.doltPort}`
      );

      // Perform batch catch-up for missed events
      await runCatchUp(client, writer);

      let backoffMs = 1000;
      const maxBackoffMs = 30000;

      // 2. Subscribe to SSE event stream with reconnection loop
      while (!abortController.signal.aborted) {
        try {
          console.log("[oc-daemon] Subscribing to SSE event stream...");
          const { stream } = await client.event.subscribe({
            signal: abortController.signal,
          });

          // Reset backoff on successful connection
          backoffMs = 1000;

          // 3. Process events through classify → write pipeline
          for await (const event of stream) {
            const punch = classifyEvent(event as RawEvent);
            if (punch) {
              await writer.writePunch(punch);

              if (punch.punchKey === "session_completed") {
                try {
                  const { data: children } = await client.session.children({
                    path: { id: punch.taskId },
                  });
                  if (children) {
                    for (const child of children) {
                      await writer.writeChildRelation(punch.taskId, child.id);
                    }
                  }
                } catch (e) {
                  console.error("[oc-daemon] Failed to record children:", e);
                }
              }
            }
          }
          console.log("[oc-daemon] SSE stream ended. Reconnecting...");
        } catch (error: unknown) {
          // AbortError is expected during clean shutdown
          const isAbort =
            (error instanceof DOMException && error.name === "AbortError") ||
            (error instanceof Error && error.name === "AbortError");

          if (isAbort || abortController.signal.aborted) {
            break;
          }

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
