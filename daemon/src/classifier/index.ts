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
  /** Hash of the content being read/processed (not the event envelope).
   *  Used by the loop detector's cache_plateau heuristic to detect
   *  repeated reads of the same content. Falls back to sourceHash if absent. */
  contentHash?: string;
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
      .sort((a, b) => a.localeCompare(b))
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

/** Classify a "message.part.updated" event by its part type. */
function classifyPartUpdated(event: RawEvent, now: Date): Punch | null {
  const part = event.properties.part as Record<string, unknown> | undefined;
  if (!part || typeof part.type !== "string") return null;

  const base = {
    taskId: extractTaskId(event),
    observedAt: now,
    sourceHash: computeSourceHash(event),
  };

  if (part.type === "tool") {
    return classifyToolPart(part, base);
  }

  const staticMap: Record<string, { punchType: string; punchKey: string; withMetrics: boolean }> = {
    "step-start": { punchType: "step_complete", punchKey: "step_start_observed", withMetrics: false },
    "step-finish": { punchType: "step_complete", punchKey: "step_finished", withMetrics: true },
    "text": { punchType: "message", punchKey: "text_response", withMetrics: true },
  };

  const mapping = staticMap[part.type];
  if (!mapping) return null;

  return {
    ...base,
    punchType: mapping.punchType,
    punchKey: mapping.punchKey,
    ...(mapping.withMetrics ? extractMetrics(part) : {}),
  };
}

/** Classify a tool-type part: only mint punches on terminal states. */
function classifyToolPart(
  part: Record<string, unknown>,
  base: { taskId: string; observedAt: Date; sourceHash: string }
): Punch | null {
  const state = part.state as Record<string, unknown> | undefined;
  const status = state?.status as string | undefined;
  if (status !== "completed" && status !== "error") return null;

  const toolName = typeof part.tool === "string" ? part.tool : "unknown_tool";
  return {
    ...base,
    punchType: "tool_call",
    punchKey: toolName,
    ...extractMetrics(part),
  };
}

/** Classify a "session.updated" event: only completed sessions produce punches. */
function classifySessionUpdated(event: RawEvent, now: Date): Punch | null {
  const info = event.properties.info as Record<string, unknown> | undefined;
  const status = info?.status as string | undefined;
  if (status !== "completed") return null;

  return {
    taskId: extractTaskId(event),
    punchType: "step_complete",
    punchKey: "session_completed",
    observedAt: now,
    sourceHash: computeSourceHash(event),
  };
}

const SESSION_LIFECYCLE_EVENTS = new Set([
  "session.created",
  "session.deleted",
  "session.idle",
  "session.error",
]);

/** Classify a session lifecycle event (created/deleted/idle/error). */
function classifySessionLifecycle(event: RawEvent, now: Date): Punch | null {
  if (!SESSION_LIFECYCLE_EVENTS.has(event.type)) return null;

  const keySuffix = event.type.split(".")[1];
  return {
    taskId: extractTaskId(event),
    punchType: "session_lifecycle",
    punchKey: `session_${keySuffix}`,
    observedAt: now,
    sourceHash: computeSourceHash(event),
  };
}

/**
 * Classify a raw SSE event into a Punch, or return null if the event
 * is not punch-worthy.
 */
export function classifyEvent(event: RawEvent): Punch | null {
  const now = new Date();

  if (event.type === "message.part.updated") {
    return classifyPartUpdated(event, now);
  }
  if (event.type === "session.updated") {
    return classifySessionUpdated(event, now);
  }
  return classifySessionLifecycle(event, now);
}
