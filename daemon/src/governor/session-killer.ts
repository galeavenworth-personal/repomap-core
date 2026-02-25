/**
 * Session Killer — Abort runaway sessions via kilo serve SDK.
 *
 * Uses the native `session.abort()` API to stop a runaway session,
 * then records a `governor_kill` punch in Dolt for the audit trail.
 *
 * Idempotent: killing an already-dead session is a no-op (returns
 * the confirmation with a note in the reason).
 */

import { createHash } from "node:crypto";
import { createOpencodeClient } from "@opencode-ai/sdk/client";

import type { DoltWriter } from "../writer/index.js";
import type {
  KillConfirmation,
  LoopDetection,
  SessionMetrics,
} from "./types.js";

export interface SessionKillerConfig {
  kiloHost: string;
  kiloPort: number;
}

export interface SessionKillerDeps {
  config: SessionKillerConfig;
  writer?: DoltWriter;
}

/**
 * Abort a runaway session and record the kill event.
 *
 * Steps:
 *   1. Call session.abort() via SDK (idempotent — 404 means already dead)
 *   2. Record a governor_kill punch in Dolt (if writer provided)
 *   3. Return KillConfirmation with final metrics
 */
export async function killSession(
  deps: SessionKillerDeps,
  detection: LoopDetection
): Promise<KillConfirmation> {
  const client = createOpencodeClient({
    baseUrl: `http://${deps.config.kiloHost}:${deps.config.kiloPort}`,
  });

  const killedAt = new Date();
  let alreadyDead = false;

  // Step 1: Abort the session via SDK
  try {
    const response = await client.session.abort({
      path: { id: detection.sessionId },
    });

    if (response.error) {
      // 404 means session already gone — treat as successful kill
      const errObj = response.error as { status?: number };
      if (errObj.status === 404) {
        alreadyDead = true;
        console.log(
          `[governor] Session ${detection.sessionId} already terminated (404)`
        );
      } else {
        throw new Error(
          `session.abort failed: ${JSON.stringify(response.error)}`
        );
      }
    } else {
      console.log(
        `[governor] Session ${detection.sessionId} aborted (${detection.classification})`
      );
    }
  } catch (err: unknown) {
    // Network or unexpected errors — still record the kill attempt
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[governor] Abort call failed for ${detection.sessionId}: ${msg}`
    );
    // Re-throw only if it's not a "not found" style error
    if (!msg.includes("404") && !msg.includes("not found")) {
      throw err;
    }
    alreadyDead = true;
  }

  // Step 2: Record the governor_kill punch
  if (deps.writer) {
    try {
      await deps.writer.writePunch({
        taskId: detection.sessionId,
        punchType: "governor_kill",
        punchKey: detection.classification,
        observedAt: killedAt,
        sourceHash: computeKillHash(detection),
        cost: detection.metrics.totalCost,
      });
      console.log(
        `[governor] Kill punch recorded for ${detection.sessionId}`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[governor] Failed to record kill punch: ${msg}`
      );
      // Don't throw — the kill itself succeeded
    }
  }

  const reason = alreadyDead
    ? `${detection.reason} (session was already terminated)`
    : detection.reason;

  return {
    sessionId: detection.sessionId,
    killedAt,
    trigger: { ...detection, reason },
    finalMetrics: { ...detection.metrics },
  };
}

/** Compute a deterministic hash for the kill event (for idempotent Dolt insert). */
function computeKillHash(detection: LoopDetection): string {
  const payload = JSON.stringify({
    type: "governor_kill",
    sessionId: detection.sessionId,
    classification: detection.classification,
    stepCount: detection.metrics.stepCount,
    totalCost: detection.metrics.totalCost,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Retrieve final session metrics from kilo serve.
 * Returns the metrics from the detection if the session is already gone.
 */
export async function getSessionMetrics(
  config: SessionKillerConfig,
  sessionId: string,
  fallbackMetrics: SessionMetrics
): Promise<SessionMetrics> {
  try {
    const client = createOpencodeClient({
      baseUrl: `http://${config.kiloHost}:${config.kiloPort}`,
    });

    const { data: messages } = await client.session.messages({
      path: { id: sessionId },
    });

    if (!messages) return fallbackMetrics;

    let toolCalls = 0;
    let stepCount = 0;
    const flatParts = flattenParts(messages);

    for (const part of flatParts) {
      if (part.type === "tool") toolCalls++;
      if (part.type === "step-finish") stepCount++;
    }

    return {
      ...fallbackMetrics,
      toolCalls,
      stepCount: Math.max(stepCount, fallbackMetrics.stepCount),
    };
  } catch {
    return fallbackMetrics;
  }
}

/** Flatten nested message groups into individual parts. */
function flattenParts(messages: unknown): Array<Record<string, unknown>> {
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
