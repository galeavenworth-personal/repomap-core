import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createDoltWriter } from "../writer/index.js";

interface SessionAccumulator {
  model?: string;
  totalCost: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  startedAt?: Date;
  completedAt?: Date;
}

interface Counters {
  sessions: number;
  messages: number;
  toolCalls: number;
}

function expandHome(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return path.join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

async function readJsonIfExists(filePath: string): Promise<unknown[] | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseApiReqStartedText(text: unknown): {
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensReasoning?: number;
  model?: string;
} {
  if (typeof text !== "string") return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      cost: asNumber(parsed.cost),
      tokensIn: asNumber(parsed.tokensIn),
      tokensOut: asNumber(parsed.tokensOut),
      tokensReasoning: asNumber(parsed.tokensReasoning),
      model: asString(parsed.inferenceProvider) ?? asString(parsed.model),
    };
  } catch {
    return {};
  }
}

function applyApiRequestMetrics(
  session: SessionAccumulator,
  metrics: ReturnType<typeof parseApiReqStartedText>,
  ts: number
): void {
  session.totalCost += metrics.cost ?? 0;
  session.tokensIn += metrics.tokensIn ?? 0;
  session.tokensOut += metrics.tokensOut ?? 0;
  session.tokensReasoning += metrics.tokensReasoning ?? 0;
  if (metrics.model) session.model ??= metrics.model;
  if (!session.startedAt) session.startedAt = new Date(ts);
  session.completedAt = new Date(ts);
}

function roleFromUiType(type: string): "user" | "assistant" {
  return type === "ask.text" ? "user" : "assistant";
}

function parseToolUses(row: Record<string, unknown>): unknown[] {
  if (Array.isArray(row.tool_use)) {
    return row.tool_use;
  }
  if (Array.isArray(row.toolUse)) {
    return row.toolUse;
  }
  return [];
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

async function ingestUiMessages(
  sessionId: string,
  uiMessages: unknown[],
  writer: ReturnType<typeof createDoltWriter>,
  session: SessionAccumulator
): Promise<{ messages: number; toolCalls: number }> {
  let messages = 0;
  let toolCalls = 0;

  for (const item of uiMessages) {
    const row = asRecord(item);
    const type = asString(row.type) ?? "";
    const text = row.text;
    const ts = toTimestamp(row.ts ?? row.timestamp ?? row.createdAt);

    if (type === "say.api_req_started") {
      applyApiRequestMetrics(session, parseApiReqStartedText(text), ts);
      continue;
    }

    if (type === "say.text" || type === "ask.text") {
      await writer.writeMessage({
        sessionId,
        role: roleFromUiType(type),
        contentType: "text",
        contentPreview: asString(text)?.slice(0, 512),
        ts,
      });
      messages += 1;
      continue;
    }

    if (type === "ask.use_mcp_server" || type === "say.mcp_server_response") {
      const parsed = parseApiReqStartedText(text);
      await writer.writeToolCall({
        sessionId,
        toolName: asString(asRecord(row).toolName) ?? "mcp_server",
        argsSummary: typeof text === "string" ? text.slice(0, 1024) : undefined,
        status: type === "say.mcp_server_response" ? "completed" : "started",
        cost: parsed.cost,
        ts,
      });
      toolCalls += 1;
    }
  }

  return { messages, toolCalls };
}

async function ingestApiConversationHistory(
  sessionId: string,
  history: unknown[],
  writer: ReturnType<typeof createDoltWriter>
): Promise<{ messages: number; toolCalls: number }> {
  let messages = 0;
  let toolCalls = 0;

  for (const turn of history) {
    const row = asRecord(turn);
    const role = asString(row.role);
    const ts = toTimestamp(row.ts ?? row.timestamp ?? row.createdAt);

    const content = row.content;
    if (role && typeof content === "string" && content.length > 0) {
      await writer.writeMessage({
        sessionId,
        role,
        contentType: "text",
        contentPreview: content.slice(0, 512),
        ts,
      });
      messages += 1;
    }

    const toolUses = parseToolUses(row);
    for (const toolUse of toolUses) {
      const toolRow = asRecord(toolUse);
      const toolName = asString(toolRow.name) ?? asString(toolRow.tool) ?? "unknown_tool";
      const status = asString(toolRow.status) ?? "completed";
      const args = toolRow.args;

      await writer.writeToolCall({
        sessionId,
        toolName,
        argsSummary: summarizeArgs(args),
        status,
        error: asString(toolRow.error),
        durationMs: asNumber(toolRow.durationMs),
        cost: asNumber(toolRow.cost),
        ts,
      });
      toolCalls += 1;
    }
  }

  return { messages, toolCalls };
}

export async function runBackfill(taskStoreArg?: string): Promise<Counters> {
  const taskStorePath = expandHome(
    taskStoreArg ?? "~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/"
  );

  const writer = createDoltWriter({
    host: process.env.DOLT_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.DOLT_PORT || "3307", 10),
    database: process.env.DOLT_DATABASE || "punch_cards",
    user: process.env.DOLT_USER || "root",
    password: process.env.DOLT_PASSWORD || undefined,
  });

  const counters: Counters = { sessions: 0, messages: 0, toolCalls: 0 };

  await writer.connect();
  try {
    const entries = await readdir(taskStorePath, { withFileTypes: true });
    const taskDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    for (const sessionId of taskDirs) {
      const dirPath = path.join(taskStorePath, sessionId);
      const uiMessagesPath = path.join(dirPath, "ui_messages.json");
      const apiHistoryPath = path.join(dirPath, "api_conversation_history.json");

      const session: SessionAccumulator = {
        totalCost: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensReasoning: 0,
      };

      const uiMessages = await readJsonIfExists(uiMessagesPath);
      if (uiMessages) {
        const fromUi = await ingestUiMessages(sessionId, uiMessages, writer, session);
        counters.messages += fromUi.messages;
        counters.toolCalls += fromUi.toolCalls;
      }

      const history = await readJsonIfExists(apiHistoryPath);
      if (history) {
        const fromHistory = await ingestApiConversationHistory(sessionId, history, writer);
        counters.messages += fromHistory.messages;
        counters.toolCalls += fromHistory.toolCalls;
      }

      await writer.writeSession({
        sessionId,
        taskId: sessionId,
        model: session.model,
        status: session.completedAt ? "completed" : "running",
        totalCost: session.totalCost,
        tokensIn: session.tokensIn,
        tokensOut: session.tokensOut,
        tokensReasoning: session.tokensReasoning,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
      });

      counters.sessions += 1;
    }
  } finally {
    await writer.disconnect();
  }

  return counters;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const taskStoreArg = process.argv[2];
  const result = await runBackfill(taskStoreArg);
  console.log(
    `Backfill complete: ${result.sessions} sessions, ${result.messages} messages, ${result.toolCalls} tool_calls ingested`
  );
}
