import { type Punch } from "../classifier/index.js";
import { asRecord, pickNumber, pickString, pickTimestamp, summarizeArgs } from "../infra/record-utils.js";
import type { DoltWriter } from "../writer/index.js";

export async function writeTextMessagePart(
  writer: DoltWriter,
  sessionId: string,
  partRecord: Record<string, unknown>,
  messageRole: string,
  punch: Punch | null,
): Promise<void> {
  const text = pickString(partRecord, "text", "content") ?? "";
  await writer.writeMessage({
    sessionId,
    role: pickString(partRecord, "role") ?? messageRole,
    contentType: "text",
    contentPreview: text.slice(0, 512),
    ts: pickTimestamp(partRecord),
    cost: pickNumber(partRecord, "cost") ?? punch?.cost,
    tokensIn: pickNumber(asRecord(partRecord.tokens), "input") ?? punch?.tokensInput,
    tokensOut: pickNumber(asRecord(partRecord.tokens), "output") ?? punch?.tokensOutput,
  });
}

export async function writeToolPart(
  writer: DoltWriter,
  sessionId: string,
  partRecord: Record<string, unknown>,
  punch: Punch | null,
): Promise<void> {
  const state = asRecord(partRecord.state);
  const toolName = pickString(partRecord, "tool") ?? punch?.punchKey ?? "unknown_tool";
  await writer.writeToolCall({
    sessionId,
    toolName,
    argsSummary: summarizeArgs(partRecord.input),
    status: pickString(state, "status"),
    error: pickString(state, "error"),
    durationMs: pickNumber(partRecord, "durationMs"),
    cost: pickNumber(partRecord, "cost") ?? punch?.cost,
    ts: pickTimestamp(partRecord),
  });
}
