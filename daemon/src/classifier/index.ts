/**
 * Event Classifier
 *
 * Receives raw SSE events from kilo serve and classifies them into
 * punch types suitable for writing to the Dolt punches table.
 *
 * SSE event types (from OpenCode SDK spec §4.4):
 *   - message.part.updated (part.type="tool") → "tool_call" punch
 *   - message.part.updated (part.type="step-start") → "step_complete" punch
 *   - session.updated (status=completed) → "step_complete" punch (session_complete sentinel)
 *
 * Unrecognized events are silently skipped (no punch minted).
 */

import { createHash } from "node:crypto";

export interface RawEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface Punch {
  taskId: string;
  punchType: string;
  punchKey: string;
  observedAt: Date;
  sourceHash: string;
  cost?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensReasoning?: number;
}

/**
 * Compute a deterministic SHA-256 hash for idempotent punch insertion.
 * Hash is computed from event type + JSON-stringified properties (recursively sorted keys).
 */
function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return obj;
}

function computeSourceHash(event: RawEvent): string {
  const canonical = JSON.stringify(
    sortKeysDeep({
      type: event.type,
      properties: event.properties,
    })
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Extract the session/task ID from event properties.
 * SSE events nest this differently depending on event type.
 */
function extractTaskId(event: RawEvent): string {
  const props = event.properties;

  // message.part.updated: sessionID lives on the part object
  if (event.type === "message.part.updated") {
    const part = props.part as Record<string, unknown> | undefined;
    if (part && typeof part.sessionID === "string") return part.sessionID;
  }

  // session.updated / session.created / session.deleted: session is in properties.info
  if (event.type.startsWith("session.")) {
    const info = props.info as Record<string, unknown> | undefined;
    if (info && typeof info.id === "string") return info.id;
  }

  return "unknown";
}

function extractMetrics(part: Record<string, unknown>) {
  const tokens = part.tokens as Record<string, number> | undefined;
  return {
    cost: typeof part.cost === "number" ? part.cost : undefined,
    tokensInput: typeof tokens?.input === "number" ? tokens.input : undefined,
    tokensOutput: typeof tokens?.output === "number" ? tokens.output : undefined,
    tokensReasoning: typeof tokens?.reasoning === "number" ? tokens.reasoning : undefined,
  };
}

/**
 * Classify a raw SSE event into a Punch, or return null if the event
 * is not punch-worthy.
 */
export function classifyEvent(event: RawEvent): Punch | null {
  const now = new Date();

  // ── message.part.updated: discriminate by part type ──
  if (event.type === "message.part.updated") {
    const part = event.properties.part as Record<string, unknown> | undefined;
    if (!part || typeof part.type !== "string") return null;

    if (part.type === "tool") {
      // Only mint punches on terminal states (completed or error)
      const state = part.state as Record<string, unknown> | undefined;
      const status = state && typeof state.status === "string" ? state.status : undefined;
      if (status !== "completed" && status !== "error") return null;

      const toolName = typeof part.tool === "string" ? part.tool : "unknown_tool";
      return {
        taskId: extractTaskId(event),
        punchType: "tool_call",
        punchKey: toolName,
        observedAt: now,
        sourceHash: computeSourceHash(event),
        ...extractMetrics(part),
      };
    }

    if (part.type === "step-start") {
      return {
        taskId: extractTaskId(event),
        punchType: "step_complete",
        punchKey: "step_start_observed",
        observedAt: now,
        sourceHash: computeSourceHash(event),
      };
    }

    if (part.type === "step-finish") {
      return {
        taskId: extractTaskId(event),
        punchType: "step_complete",
        punchKey: "step_finished",
        observedAt: now,
        sourceHash: computeSourceHash(event),
        ...extractMetrics(part),
      };
    }

    if (part.type === "text") {
      return {
        taskId: extractTaskId(event),
        punchType: "message",
        punchKey: "text_response",
        observedAt: now,
        sourceHash: computeSourceHash(event),
        ...extractMetrics(part),
      };
    }

    // Other part types (reasoning, etc.) — not punch-worthy yet
    return null;
  }

  // ── session.updated: check for completion ──
  if (event.type === "session.updated") {
    // The session status is nested under properties.info in the SDK's Session object
    const info = event.properties.info as Record<string, unknown> | undefined;
    const status = info && typeof info.status === "string" ? info.status : undefined;

    if (status === "completed") {
      return {
        taskId: extractTaskId(event),
        punchType: "step_complete",
        punchKey: "session_completed", // Corrected key to match test expectation
        observedAt: now,
        sourceHash: computeSourceHash(event),
      };
    }

    // Non-completion session updates — not punch-worthy
    return null;
  }

  // ── session.created / deleted / idle / error ──
  if (
    event.type === "session.created" ||
    event.type === "session.deleted" ||
    event.type === "session.idle" ||
    event.type === "session.error"
  ) {
    const keySuffix = event.type.split(".")[1]; // created, deleted, idle, error
    return {
      taskId: extractTaskId(event),
      punchType: "session_lifecycle",
      punchKey: `session_${keySuffix}`,
      observedAt: now,
      sourceHash: computeSourceHash(event),
    };
  }

  // All other event types — not punch-worthy
  return null;
}
