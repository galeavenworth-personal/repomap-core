import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  disconnectMock,
  writeSessionMock,
  writeMessageMock,
  writeToolCallMock,
  createDoltWriterMock,
} = vi.hoisted(() => {
  const connectMock = vi.fn();
  const disconnectMock = vi.fn();
  const writeSessionMock = vi.fn();
  const writeMessageMock = vi.fn();
  const writeToolCallMock = vi.fn();
  const createDoltWriterMock = vi.fn(() => ({
    connect: connectMock,
    disconnect: disconnectMock,
    writeSession: writeSessionMock,
    writeMessage: writeMessageMock,
    writeToolCall: writeToolCallMock,
  }));
  return {
    connectMock,
    disconnectMock,
    writeSessionMock,
    writeMessageMock,
    writeToolCallMock,
    createDoltWriterMock,
  };
});

vi.mock("../src/writer/index.js", () => ({
  createDoltWriter: createDoltWriterMock,
}));

import { runBackfill } from "../src/backfill/kilo-store.js";

describe("kilo-store backfill", () => {
  let tempRoot = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(undefined);
    disconnectMock.mockResolvedValue(undefined);
    writeSessionMock.mockResolvedValue(undefined);
    writeMessageMock.mockResolvedValue(undefined);
    writeToolCallMock.mockResolvedValue(undefined);
    tempRoot = await mkdtemp(join(tmpdir(), "kilo-backfill-"));
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("ingests sessions, text messages, and tool calls from task directories", async () => {
    const sessionDir = join(tempRoot, "123e4567-e89b-12d3-a456-426614174000");
    await mkdir(sessionDir, { recursive: true });

    await writeFile(
      join(sessionDir, "ui_messages.json"),
      JSON.stringify([
        {
          type: "say.api_req_started",
          ts: 100,
          text: JSON.stringify({
            tokensIn: 10,
            tokensOut: 20,
            tokensReasoning: 5,
            cost: 0.01,
            inferenceProvider: "gpt-5.3-codex",
          }),
        },
        { type: "say.text", ts: 101, text: "assistant response" },
        {
          type: "ask.use_mcp_server",
          ts: 102,
          toolName: "codebase___retrieval",
          text: "{\"query\":\"x\"}",
        },
      ])
    );

    await writeFile(
      join(sessionDir, "api_conversation_history.json"),
      JSON.stringify([
        {
          role: "user",
          content: "hello",
          ts: 103,
          tool_use: [
            {
              name: "read_file",
              status: "completed",
              args: { path: "README.md" },
              cost: 0.001,
            },
          ],
        },
      ])
    );

    const result = await runBackfill(tempRoot);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).toHaveBeenCalledTimes(1);

    expect(writeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "123e4567-e89b-12d3-a456-426614174000",
        model: "gpt-5.3-codex",
      })
    );
    expect(writeMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", contentPreview: "assistant response" })
    );
    expect(writeToolCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "codebase___retrieval" })
    );

    expect(result.sessions).toBe(1);
    expect(result.messages).toBeGreaterThanOrEqual(2);
    expect(result.toolCalls).toBeGreaterThanOrEqual(2);
  });
});
