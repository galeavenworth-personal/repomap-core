import { asRecord } from "../../src/infra/record-utils.js";

function hasNonTerminalStepFinish(part: Record<string, unknown>): boolean {
  if (part.type !== "step-finish") return false;
  const finishReason = asRecord(part.finishReason).type ?? part.finishReason;
  const reason = finishReason ?? part.reason;
  return reason === "tool-calls";
}

function hasRunningOrPendingTool(part: Record<string, unknown>): boolean {
  if (part.type !== "tool") return false;
  const state = asRecord(part.state);
  return state.status === "running" || state.status === "pending";
}

export function isSessionTerminal(messages: unknown[]): boolean {
  let hasTerminalStepFinish = false;
  let hasActiveTool = false;

  for (const message of messages) {
    const msg = asRecord(message);
    const parts = Array.isArray(msg.parts) ? (msg.parts as unknown[]) : [];

    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (part.type === "step-finish" && !hasNonTerminalStepFinish(part)) {
        hasTerminalStepFinish = true;
      }
      if (hasRunningOrPendingTool(part)) {
        hasActiveTool = true;
      }
    }
  }

  return hasTerminalStepFinish && !hasActiveTool;
}
