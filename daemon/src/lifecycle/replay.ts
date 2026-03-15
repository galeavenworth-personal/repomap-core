import { classifyEvent, type Punch } from "../classifier/index.js";
import type { DoltWriter } from "../writer/index.js";

type SessionMessagesClient = {
  session: {
    messages(args: { path: { id: string } }): Promise<{ data?: unknown[]; error?: unknown }>;
    list?: () => Promise<{ data?: unknown[]; error?: unknown }>;
  };
};

export interface ReplaySessionRecord {
  id: string;
  status?: string;
  createdAt?: string;
  time?: {
    created?: number;
    updated?: number;
  };
  [key: string]: unknown;
}

export interface ReplaySessionOptions {
  dryRun?: boolean;
  verbose?: boolean;
  session?: ReplaySessionRecord;
  log?: (message: string) => void;
}

export interface ReplaySessionResult {
  sessionId: string;
  messagesReplayed: number;
  punchesDerived: number;
  rowsWritten: number;
  derivedPunches: Punch[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function pickDate(record: Record<string, unknown>, ...keys: string[]): Date | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickTimestamp(record: Record<string, unknown>): number {
  const ts = pickNumber(record, "ts", "timestamp", "createdAtMs");
  if (typeof ts === "number") {
    return ts;
  }

  const timeObj = record.time;
  if (timeObj && typeof timeObj === "object") {
    const t = timeObj as Record<string, unknown>;
    const nested = pickNumber(t, "start", "end", "created", "updated", "completed");
    if (typeof nested === "number") {
      return nested;
    }
  }

  const createdAt = pickDate(record, "createdAt", "updatedAt");
  return createdAt ? createdAt.getTime() : Date.now();
}

function summarizeArgs(args: unknown): string | undefined {
  if (typeof args === "string") {
    return args;
  }
  if (args) {
    return JSON.stringify(args).slice(0, 1024);
  }
  return undefined;
}

async function resolveSessionRecord(
  client: SessionMessagesClient,
  sessionId: string,
  provided?: ReplaySessionRecord,
): Promise<ReplaySessionRecord | undefined> {
  if (provided) {
    return provided;
  }
  if (!client.session.list) {
    return undefined;
  }

  const { data, error } = await client.session.list();
  if (error || !Array.isArray(data)) {
    return undefined;
  }

  for (const candidate of data) {
    const record = asRecord(candidate);
    if (record.id === sessionId) {
      return record as ReplaySessionRecord;
    }
  }
  return undefined;
}

export async function replaySessionFromLog(
  sessionId: string,
  client: SessionMessagesClient,
  writer?: DoltWriter,
  options: ReplaySessionOptions = {},
): Promise<ReplaySessionResult> {
  const dryRun = options.dryRun === true;
  const verbose = options.verbose === true;
  const log = options.log ?? (() => undefined);

  if (!dryRun && !writer) {
    throw new Error("DoltWriter is required unless --dry-run is enabled.");
  }

  let rowsWritten = 0;
  const derivedPunches: Punch[] = [];

  const sessionRecord = await resolveSessionRecord(client, sessionId, options.session);
  if (sessionRecord && writer && !dryRun) {
    const createdMs = sessionRecord.time?.created;
    await writer.writeSession({
      sessionId,
      taskId: sessionId,
      status: sessionRecord.status,
      startedAt: createdMs ? new Date(createdMs) : pickDate(sessionRecord, "createdAt"),
    });
    rowsWritten += 1;
  }

  const { data: messages, error } = await client.session.messages({
    path: { id: sessionId },
  });

  if (error) {
    throw new Error(`kilo session.messages failed for '${sessionId}'`);
  }

  const safeMessages = Array.isArray(messages) ? messages : [];
  for (const message of safeMessages) {
    const wrapper = asRecord(message);
    const msgInfo = asRecord(wrapper.info);
    const messageRole = pickString(msgInfo, "role") ?? "assistant";
    const rawParts = wrapper.parts;
    const parts = Array.isArray(rawParts) ? rawParts : [];

    for (const part of parts) {
      const partRecord = asRecord(part);
      const punch = classifyEvent({
        type: "message.part.updated",
        properties: { part: { ...partRecord, sessionID: sessionId } },
      });

      if (punch) {
        derivedPunches.push(punch);
        if (verbose) {
          log(`[replay] ${sessionId} ${punch.punchType}/${punch.punchKey} ${punch.sourceHash}`);
        }
        if (writer && !dryRun) {
          await writer.writePunch(punch);
          rowsWritten += 1;
        }
      }

      const partType = pickString(partRecord, "type");
      if (partType === "text") {
        const text = pickString(partRecord, "text", "content") ?? "";
        if (writer && !dryRun) {
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
          rowsWritten += 1;
        }
      } else if (partType === "tool") {
        const state = asRecord(partRecord.state);
        const toolName = pickString(partRecord, "tool") ?? punch?.punchKey ?? "unknown_tool";
        if (writer && !dryRun) {
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
          rowsWritten += 1;
        }
      }
    }
  }

  return {
    sessionId,
    messagesReplayed: safeMessages.length,
    punchesDerived: derivedPunches.length,
    rowsWritten,
    derivedPunches,
  };
}
