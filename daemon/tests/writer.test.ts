import { beforeEach, describe, expect, it, vi } from "vitest";

const { createConnectionMock, executeMock, endMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn(),
  executeMock: vi.fn(),
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
    endMock.mockResolvedValue(undefined);
    createConnectionMock.mockResolvedValue({
      execute: executeMock,
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
});
