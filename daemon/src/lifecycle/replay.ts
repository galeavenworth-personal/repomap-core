import { classifyEvent, type Punch } from "../classifier/index.js";
import { asRecord, pickDate, pickString } from "../infra/record-utils.js";
import type { DoltWriter } from "../writer/index.js";
import { writeTextMessagePart, writeToolPart } from "./write-parts.js";

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

async function replayMessagePart(
  sessionId: string,
  partRecord: Record<string, unknown>,
  messageRole: string,
  writer: DoltWriter | undefined,
  dryRun: boolean,
  verbose: boolean,
  log: (message: string) => void,
): Promise<{ punch: Punch | null; rowsWritten: number }> {
  let rowsWritten = 0;

  const punch = classifyEvent({
    type: "message.part.updated",
    properties: { part: { ...partRecord, sessionID: sessionId } },
  });

  if (punch) {
    if (verbose) {
      log(`[replay] ${sessionId} ${punch.punchType}/${punch.punchKey} ${punch.sourceHash}`);
    }
    if (writer && !dryRun) {
      await writer.writePunch(punch);
      rowsWritten += 1;
    }
  }

  const partType = pickString(partRecord, "type");
  if (partType === "text" && writer && !dryRun) {
    await writeTextMessagePart(writer, sessionId, partRecord, messageRole, punch);
    rowsWritten += 1;
  } else if (partType === "tool" && writer && !dryRun) {
    await writeToolPart(writer, sessionId, partRecord, punch);
    rowsWritten += 1;
  }

  return { punch, rowsWritten };
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
      const result = await replayMessagePart(
        sessionId,
        partRecord,
        messageRole,
        writer,
        dryRun,
        verbose,
        log,
      );
      if (result.punch) {
        derivedPunches.push(result.punch);
      }
      rowsWritten += result.rowsWritten;
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
