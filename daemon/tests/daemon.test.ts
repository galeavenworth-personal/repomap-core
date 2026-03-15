import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  disconnectMock,
  writePunchMock,
  writeSessionMock,
  writeMessageMock,
  writeToolCallMock,
  writeCheckpointMock,
  validateFromKiloLogMock,
  syncChildRelsFromPunchesMock,
  writeChildRelationMock,
  createDoltWriterMock,
  classifyEventMock,
  createEventSourceMock,
  createOpencodeClientMock,
  sessionListMock,
  sessionMessagesMock,
  sessionChildrenMock,
} = vi.hoisted(() => {
  const connectMock = vi.fn();
  const disconnectMock = vi.fn();
  const writePunchMock = vi.fn();
  const writeSessionMock = vi.fn();
  const writeTaskMock = vi.fn();
  const writeMessageMock = vi.fn();
  const writeToolCallMock = vi.fn();
  const writeCheckpointMock = vi.fn();
  const validateFromKiloLogMock = vi.fn();
  const syncChildRelsFromPunchesMock = vi.fn();
  const writeChildRelationMock = vi.fn();
  const createDoltWriterMock = vi.fn(() => ({
    connect: connectMock,
    writePunch: writePunchMock,
    writeSession: writeSessionMock,
    writeTask: writeTaskMock,
    writeMessage: writeMessageMock,
    writeToolCall: writeToolCallMock,
    writeCheckpoint: writeCheckpointMock,
    writeChildRelation: writeChildRelationMock,
    syncChildRelsFromPunches: syncChildRelsFromPunchesMock,
    disconnect: disconnectMock,
  }));
  const classifyEventMock = vi.fn();
  const createEventSourceMock = vi.fn();
  const sessionListMock = vi.fn();
  const sessionMessagesMock = vi.fn();
  const sessionChildrenMock = vi.fn();
  const createOpencodeClientMock = vi.fn(() => ({
    session: {
      list: sessionListMock,
      messages: sessionMessagesMock,
      children: sessionChildrenMock,
    },
  }));
  return {
    connectMock,
    disconnectMock,
    writePunchMock,
    writeSessionMock,
    writeMessageMock,
    writeToolCallMock,
    writeCheckpointMock,
    validateFromKiloLogMock,
    syncChildRelsFromPunchesMock,
    writeChildRelationMock,
    createDoltWriterMock,
    classifyEventMock,
    createEventSourceMock,
    createOpencodeClientMock,
    sessionListMock,
    sessionMessagesMock,
    sessionChildrenMock,
  };
});

vi.mock("../src/writer/index.js", () => ({
  createDoltWriter: createDoltWriterMock,
}));

vi.mock("../src/classifier/index.js", () => ({
  classifyEvent: classifyEventMock,
}));

vi.mock("../src/governor/kilo-verified-validator.js", () => ({
  validateFromKiloLog: validateFromKiloLogMock,
}));

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

vi.mock("eventsource-client", () => ({
  createEventSource: createEventSourceMock,
}));

import { createDaemon } from "../src/lifecycle/daemon.js";

/** Helper: create an async iterable EventSource client mock. */
function mockEventSource(
  events: Array<{
    data: { type: string; properties: Record<string, unknown> };
    event?: string;
    id?: string;
  }>
) {
  return {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("createDaemon", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(undefined);
    disconnectMock.mockResolvedValue(undefined);
    writePunchMock.mockResolvedValue(undefined);
    writeSessionMock.mockResolvedValue(undefined);
    writeMessageMock.mockResolvedValue(undefined);
    writeToolCallMock.mockResolvedValue(undefined);
    writeCheckpointMock.mockResolvedValue(undefined);
    validateFromKiloLogMock.mockResolvedValue({
      status: "pass",
      cardId: "plant-orchestrate",
      sessionId: "session-checkpoint",
      sourceSessionId: "session-checkpoint",
      messageCount: 0,
      derivationPath: "kilo-sse:/event -> session.messages -> classifyEvent(message.part.updated) -> punch-card-evaluation",
      trustLevel: "verified",
      missing: [],
      violations: [],
    });
    syncChildRelsFromPunchesMock.mockResolvedValue(0);
    writeChildRelationMock.mockResolvedValue(undefined);
    sessionListMock.mockResolvedValue({ data: [] });
    sessionMessagesMock.mockResolvedValue({ data: [] });
    sessionChildrenMock.mockResolvedValue({ data: [] });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mode: "plant-manager" }),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns object with start and stop methods", () => {
    createEventSourceMock.mockReturnValue(mockEventSource([]));
    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "factory",
      doltUser: "root",
    });

    expect(typeof daemon.start).toBe("function");
    expect(typeof daemon.stop).toBe("function");
  });

  it("creates the SDK client with correct baseUrl", () => {
    createEventSourceMock.mockReturnValue(mockEventSource([]));
    createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "factory",
      doltUser: "root",
    });

    expect(createOpencodeClientMock).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4096",
    });
  });

  it("start() connects to Dolt, subscribes to SSE, and processes events", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const testEvents = [
      {
        type: "message.part.updated",
        properties: {
          sessionId: "t1",
          part: {
            type: "tool",
            tool: "readFile",
            sessionID: "t1",
            state: { status: "completed" },
            input: { path: "README.md" },
            ts: 100,
          },
        },
      },
      { type: "file.edited", properties: {} },
      {
        type: "session.updated",
        properties: { info: { id: "t2", status: "completed", mode: "code", model: "gpt" } },
      },
    ];

    createEventSourceMock.mockReturnValue(
      mockEventSource(testEvents.map((event) => ({ data: event })))
    );

    // Classify returns punch for recognized events, null for unknown
    classifyEventMock
      .mockReturnValueOnce({
        taskId: "t1",
        punchType: "tool_call",
        punchKey: "readFile",
        observedAt: new Date(),
        sourceHash: "abc123",
      })
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        taskId: "t2",
        punchType: "step_complete",
        punchKey: "task_exit",
        observedAt: new Date(),
        sourceHash: "def456",
      });

    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "factory",
      doltUser: "root",
    });

    await daemon.start();

    // Verify Dolt connection
    expect(connectMock).toHaveBeenCalledTimes(1);

    // Verify EventSource client creation
    expect(createEventSourceMock).toHaveBeenCalledTimes(1);

    // Verify all 3 events were classified
    expect(classifyEventMock).toHaveBeenCalledTimes(3);

    // Verify only 2 punches were written (unknown.event classified as null)
    expect(writePunchMock).toHaveBeenCalledTimes(2);
    expect(writeToolCallMock).toHaveBeenCalledTimes(1);
    expect(writeSessionMock).toHaveBeenCalledTimes(1);

    // Verify log messages
    expect(logSpy).toHaveBeenCalledWith(
      "[oc-daemon] Connecting to kilo serve at 127.0.0.1:4096"
    );
    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] Subscribing to SSE event stream...");
  });

  it("start() runs catch-up for recent sessions", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    // Mock recent session
    sessionListMock.mockResolvedValue({
      data: [
        { id: "s1", updatedAt: new Date().toISOString(), status: "completed" },
        { id: "s2", updatedAt: "2020-01-01T00:00:00Z", status: "completed" }, // Old, should be ignored
      ],
      error: undefined,
    });

    sessionMessagesMock.mockResolvedValue({ data: [], error: undefined });

    createEventSourceMock.mockReturnValue(mockEventSource([]));

    // Need to mock classifyEvent to return something for session.updated
    classifyEventMock.mockReturnValue({
       taskId: "s1",
       punchType: "step_complete",
       punchKey: "session_completed",
       observedAt: new Date(),
       sourceHash: "catchup-hash"
    });

    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "factory",
      doltUser: "root",
    });

    await daemon.start();

    // Verify session list called
    expect(sessionListMock).toHaveBeenCalled();
    
    // Verify messages fetched for s1 (recent) but not s2 (old)
    expect(sessionMessagesMock).toHaveBeenCalledWith({ path: { id: "s1" } });
    expect(sessionMessagesMock).not.toHaveBeenCalledWith({ path: { id: "s2" } });

    // Verify punch written
    expect(writePunchMock).toHaveBeenCalledWith(expect.objectContaining({ taskId: "s1" }));
    expect(writeSessionMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
    expect(syncChildRelsFromPunchesMock).toHaveBeenCalledTimes(1);
  });

  it("stop() aborts the stream and disconnects from Dolt", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    createEventSourceMock.mockReturnValue(mockEventSource([]));

    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "factory",
      doltUser: "root",
    });

    await daemon.stop();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] Shutting down...");
    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] Shutdown complete.");
  });

  it("writes checkpoint after session completion when card mapping exists", async () => {
    createEventSourceMock.mockReturnValue(
      mockEventSource([
        {
          data: {
            type: "session.updated",
            properties: { info: { id: "session-checkpoint", status: "completed" } },
          },
        },
      ])
    );

    classifyEventMock.mockReturnValue({
      taskId: "session-checkpoint",
      punchType: "step_complete",
      punchKey: "session_completed",
      observedAt: new Date(),
      sourceHash: "checkpoint-hash",
    });

    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "factory",
      doltUser: "root",
    });

    await daemon.start();

    expect(validateFromKiloLogMock).toHaveBeenCalledWith(
      "session-checkpoint",
      expect.any(Object),
      expect.objectContaining({
        host: "127.0.0.1",
        port: 3307,
        database: "factory",
      }),
      "plant-orchestrate",
      expect.objectContaining({ sourceSessionId: "session-checkpoint" }),
    );
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "session-checkpoint",
        cardId: "plant-orchestrate",
        status: "pass",
      })
    );
  });
});
