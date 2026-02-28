import { beforeEach, describe, expect, it, vi } from "vitest";

const { createConnectionMock, executeMock, queryMock, endMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn(),
  executeMock: vi.fn(),
  queryMock: vi.fn(),
  endMock: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: createConnectionMock,
  },
}));

import { createDoltWriter } from "../src/writer/index.js";

describe("createDoltWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue(undefined);
    queryMock.mockResolvedValue([[]]);
    endMock.mockResolvedValue(undefined);
    createConnectionMock.mockResolvedValue({
      execute: executeMock,
      query: queryMock,
      end: endMock,
    });
  });

  it("connect() calls mysql.createConnection with correct config", async () => {
    const writer = createDoltWriter({ host: "127.0.0.1", port: 3307, database: "plant", user: "root" });

    await writer.connect();

    expect(createConnectionMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 3307,
      database: "plant",
      user: "root",
    });
  });

  it("writePunch() calls connection.execute with correct SQL and params", async () => {
    const writer = createDoltWriter({ host: "127.0.0.1", port: 3307, database: "plant" });
    const observedAt = new Date("2026-02-21T00:00:00.000Z");

    await writer.connect();
    await writer.writePunch({
      taskId: "daemon-f9x",
      punchType: "tool_call",
      punchKey: "readFile",
      observedAt,
      sourceHash: "abc123",
    });

    expect(executeMock).toHaveBeenCalledWith(
      `INSERT INTO punches (task_id, punch_type, punch_key, observed_at, source_hash, cost, tokens_input, tokens_output, tokens_reasoning)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM punches WHERE source_hash = ?)`,
      [
        "daemon-f9x",
        "tool_call",
        "readFile",
        observedAt,
        "abc123",
        null,
        null,
        null,
        null,
        "abc123",
      ]
    );
  });

  it("writePunch() throws if called before connect", async () => {
    const writer = createDoltWriter({ host: "127.0.0.1", port: 3307, database: "plant" });

    await expect(
      writer.writePunch({
        taskId: "daemon-f9x",
        punchType: "tool_call",
        punchKey: "readFile",
        observedAt: new Date(),
        sourceHash: "abc123",
      })
    ).rejects.toThrow("Not connected to Dolt");
  });

  it("disconnect() calls end() and writePunch() throws after disconnect", async () => {
    const writer = createDoltWriter({ host: "127.0.0.1", port: 3307, database: "plant" });

    await writer.connect();
    await writer.disconnect();

    expect(endMock).toHaveBeenCalledTimes(1);

    await expect(
      writer.writePunch({
        taskId: "daemon-f9x",
        punchType: "tool_call",
        punchKey: "readFile",
        observedAt: new Date(),
        sourceHash: "abc123",
      })
    ).rejects.toThrow("Not connected to Dolt");
  });

  it("writeSession() upserts session row", async () => {
    const writer = createDoltWriter({ host: "127.0.0.1", port: 3307, database: "plant" });

    await writer.connect();
    await writer.writeSession({
      sessionId: "s-1",
      taskId: "task-1",
      mode: "code",
      model: "gpt-x",
      status: "completed",
      totalCost: 1.2,
      tokensIn: 10,
      tokensOut: 20,
      tokensReasoning: 30,
      startedAt: new Date("2026-02-01T00:00:00Z"),
      completedAt: new Date("2026-02-01T00:01:00Z"),
      outcome: "ok",
    });

    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO sessions"),
      expect.arrayContaining(["s-1", "task-1", "code", "gpt-x", "completed", 1.2])
    );
  });

  it("writeMessage() deduplicates by (session_id, ts, role)", async () => {
    const writer = createDoltWriter({ host: "127.0.0.1", port: 3307, database: "plant" });

    await writer.connect();
    await writer.writeMessage({
      sessionId: "s-2",
      role: "assistant",
      contentType: "text",
      contentPreview: "hello",
      ts: 123,
    });

    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT IGNORE INTO messages"),
      ["s-2", "assistant", "text", "hello", 123, null, null, null, "s-2", 123, "assistant"]
    );
  });

  it("writeToolCall() deduplicates by (session_id, ts, tool_name)", async () => {
    const writer = createDoltWriter({ host: "127.0.0.1", port: 3307, database: "plant" });

    await writer.connect();
    await writer.writeToolCall({
      sessionId: "s-3",
      toolName: "read_file",
      argsSummary: "{\"path\":\"x\"}",
      status: "completed",
      durationMs: 10,
      ts: 456,
    });

    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT IGNORE INTO tool_calls"),
      [
        "s-3",
        "read_file",
        "{\"path\":\"x\"}",
        "completed",
        null,
        10,
        null,
        456,
        "s-3",
        456,
        "read_file",
      ]
    );
  });

  it("syncChildRelsFromPunches() inserts child relations and returns inserted count", async () => {
    const writer = createDoltWriter({ host: "127.0.0.1", port: 3307, database: "plant" });
    queryMock.mockResolvedValue([
      [
        { task_id: "parent-1", punch_key: "child-1" },
        { task_id: "parent-2", punch_key: "child-2" },
      ],
    ]);
    executeMock.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT IGNORE INTO child_rels")) {
        return [{ affectedRows: 1 }];
      }
      return undefined;
    });

    await writer.connect();
    const inserted = await writer.syncChildRelsFromPunches();

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM punches")
    );
    expect(inserted).toBe(2);
  });
});
