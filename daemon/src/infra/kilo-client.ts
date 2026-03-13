import { sleep, timestamp } from "./utils.js";
import type { FactoryDispatchConfig, Logger, PromptPayload } from "./factory-dispatch.js";

/** A message part from the kilo session message API. */
export interface MessagePart {
  type: string;
  text?: string;
  reason?: string;
  state?: { status?: string };
  [key: string]: unknown;
}

/** A message from the kilo session message API. */
export interface SessionMessage {
  info?: { role?: string };
  parts?: MessagePart[];
  [key: string]: unknown;
}

/** A child session object from the kilo children API. */
export interface ChildSession {
  id: string;
  [key: string]: unknown;
}

/**
 * Create a new kilo session. Returns the session ID.
 */
export async function createSession(
  baseUrl: string,
  title: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const resp = await fetchFn(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });

  if (!resp.ok) {
    throw new Error(`Failed to create session (HTTP ${resp.status})`);
  }

  const data = (await resp.json()) as { id: string };
  if (!data.id) {
    throw new Error("Session response missing 'id' field");
  }

  return data.id;
}

/**
 * Dispatch a prompt to a session asynchronously.
 * Uses the prompt_async endpoint so we can monitor via polling.
 */
export async function dispatchPrompt(
  baseUrl: string,
  sessionId: string,
  payload: PromptPayload,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const resp = await fetchFn(`${baseUrl}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Any 2xx is success
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Prompt dispatch failed (HTTP ${resp.status})`);
  }
}

/**
 * Check if a session's messages indicate it is done processing.
 * A session is done when it has a terminal step-finish (end_turn/stop, not tool-calls)
 * and no running/pending tools.
 */
export function isSessionDone(messages: SessionMessage[]): boolean {
  let hasTerminalFinish = false;
  let hasRunningTools = false;

  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      if (part.type === "tool") {
        const status = part.state?.status;
        if (status === "running" || status === "pending") {
          hasRunningTools = true;
        }
      }
      if (part.type === "step-finish") {
        const reason = part.reason ?? "";
        if (reason === "tool-calls") {
          hasTerminalFinish = false; // reset — more work coming
        } else if (reason === "end_turn" || reason === "stop" || reason === "max_tokens" || reason === "") {
          hasTerminalFinish = true;
        }
      }
    }
  }

  return hasTerminalFinish && !hasRunningTools;
}

/**
 * Fetch the children of a session. Returns array of child session objects.
 */
export async function fetchChildren(
  baseUrl: string,
  sessionId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ChildSession[]> {
  try {
    const resp = await fetchFn(`${baseUrl}/session/${sessionId}/children`);
    if (!resp.ok) return [];
    return (await resp.json()) as ChildSession[];
  } catch {
    return [];
  }
}

/**
 * Fetch session messages.
 */
export async function fetchMessages(
  baseUrl: string,
  sessionId: string,
  fetchFn: typeof fetch = fetch,
): Promise<SessionMessage[]> {
  try {
    const resp = await fetchFn(`${baseUrl}/session/${sessionId}/message`);
    if (!resp.ok) return [];
    return (await resp.json()) as SessionMessage[];
  } catch {
    return [];
  }
}

/**
 * Check if ALL child sessions are done (no running/pending tools).
 */
export async function areAllChildrenDone(
  baseUrl: string,
  children: ChildSession[],
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  for (const child of children) {
    if (!child.id) continue;
    const messages = await fetchMessages(baseUrl, child.id, fetchFn);
    // Check if any tool is running/pending
    const hasRunning = messages.some((msg) =>
      (msg.parts ?? []).some(
        (p) => p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending"),
      ),
    );
    if (hasRunning) return false;
  }
  return true;
}

export interface MonitorResult {
  completed: boolean;
  elapsed: number;
  childCount: number;
}

/**
 * Monitor a session for completion with idle detection and child monitoring.
 */
export async function monitorSession(
  baseUrl: string,
  sessionId: string,
  config: FactoryDispatchConfig,
  log: Logger,
  fetchFn: typeof fetch = fetch,
): Promise<MonitorResult> {
  log(`${timestamp()} Monitoring session (poll=${config.pollInterval}s, timeout=${config.maxWait}s)...`);

  let elapsed = 0;
  let lastChildCount = 0;
  let idleCount = 0;

  while (elapsed < config.maxWait) {
    await sleep(config.pollInterval * 1000);
    elapsed += config.pollInterval;

    // Count children
    const children = await fetchChildren(baseUrl, sessionId, fetchFn);
    const childCount = children.length;

    if (childCount !== lastChildCount) {
      log(`${timestamp()} Children spawned: ${childCount} (was ${lastChildCount})`);
      lastChildCount = childCount;
    }

    // Check session messages
    const messages = await fetchMessages(baseUrl, sessionId, fetchFn);
    let doneStatus: "yes" | "no" | "error";
    try {
      doneStatus = isSessionDone(messages) ? "yes" : "no";
    } catch {
      doneStatus = "error";
    }

    if (doneStatus === "yes") {
      idleCount++;
      if (idleCount < config.idleConfirm) {
        log(`${timestamp()} [${elapsed}s] Idle check ${idleCount}/${config.idleConfirm}, confirming...`);
        await sleep(config.pollInterval * 1000);
        elapsed += config.pollInterval;
        if (elapsed >= config.maxWait) break;
        continue;
      }

      // Confirmed idle — verify all children are done
      let allChildrenDone = true;
      if (childCount > 0) {
        allChildrenDone = await areAllChildrenDone(baseUrl, children, fetchFn);
      }

      if (allChildrenDone) {
        log(
          `${timestamp()} All sessions idle (${idleCount}/${config.idleConfirm} confirmations) — completed in ${elapsed}s`,
        );
        return { completed: true, elapsed, childCount: lastChildCount };
      }
      // Children still running, reset
      idleCount = 0;
    } else {
      idleCount = 0;
    }

    if (doneStatus === "error") {
      log(`${timestamp()} [${elapsed}s] Warning: status check failed, retrying...`);
    } else {
      log(`${timestamp()} [${elapsed}s] Parent done: ${doneStatus}, children: ${childCount}, idle: ${idleCount}/${config.idleConfirm}`);
    }
  }

  return { completed: false, elapsed, childCount: lastChildCount };
}

/**
 * Extract the final assistant response text from session messages.
 * First looks for substantial text (>100 chars), then falls back to any text.
 */
export function extractResult(messages: SessionMessage[]): string | null {
  // First pass: find last assistant message with substantial text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "assistant") continue;
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string" && part.text.length > 100) {
        return part.text;
      }
    }
  }

  // Fallback: any assistant text
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "assistant") continue;
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return part.text;
      }
    }
  }

  return null;
}
