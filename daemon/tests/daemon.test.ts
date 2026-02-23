import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  disconnectMock,
  writePunchMock,
  writeChildRelationMock,
  createDoltWriterMock,
  classifyEventMock,
  subscribeMock,
  createOpencodeClientMock,
  sessionListMock,
  sessionMessagesMock,
  sessionChildrenMock,
} = vi.hoisted(() => {
  const connectMock = vi.fn();
  const disconnectMock = vi.fn();
  const writePunchMock = vi.fn();
  const writeChildRelationMock = vi.fn();
  const createDoltWriterMock = vi.fn(() => ({
    connect: connectMock,
    writePunch: writePunchMock,
    writeChildRelation: writeChildRelationMock,
    disconnect: disconnectMock,
  }));
  const classifyEventMock = vi.fn();
  const subscribeMock = vi.fn();
  const sessionListMock = vi.fn();
  const sessionMessagesMock = vi.fn();
  const sessionChildrenMock = vi.fn();
  const createOpencodeClientMock = vi.fn(() => ({
    event: { subscribe: subscribeMock },
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
    writeChildRelationMock,
    createDoltWriterMock,
    classifyEventMock,
    subscribeMock,
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

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

import { createDaemon } from "../src/lifecycle/daemon.js";

/** Helper: create an async generator from an array of events */
async function* mockEventStream(
  events: Array<{ type: string; properties: Record<string, unknown> }>
) {
  for (const event of events) {
    yield event;
  }
}

describe("createDaemon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(undefined);
    disconnectMock.mockResolvedValue(undefined);
    writePunchMock.mockResolvedValue(undefined);
    writeChildRelationMock.mockResolvedValue(undefined);
    sessionListMock.mockResolvedValue({ data: [] });
    sessionMessagesMock.mockResolvedValue({ data: [] });
    sessionChildrenMock.mockResolvedValue({ data: [] });
  });

  it("returns object with start and stop methods", () => {
    subscribeMock.mockResolvedValue({ stream: mockEventStream([]) });
    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "plant",
      doltUser: "root",
    });

    expect(typeof daemon.start).toBe("function");
    expect(typeof daemon.stop).toBe("function");
  });

  it("creates the SDK client with correct baseUrl", () => {
    subscribeMock.mockResolvedValue({ stream: mockEventStream([]) });
    createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "plant",
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
          part: { type: "tool", toolName: "readFile" },
        },
      },
      { type: "file.edited", properties: {} },
      {
        type: "session.updated",
        properties: { id: "t2", status: "completed" },
      },
    ];

    subscribeMock
      .mockResolvedValueOnce({ stream: mockEventStream(testEvents) })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

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
      doltDatabase: "plant",
      doltUser: "root",
    });

    await daemon.start();

    // Verify Dolt connection
    expect(connectMock).toHaveBeenCalledTimes(1);

    // Verify SSE subscription (called twice: once successful, then reconnects and throws AbortError)
    expect(subscribeMock).toHaveBeenCalledTimes(2);

    // Verify all 3 events were classified
    expect(classifyEventMock).toHaveBeenCalledTimes(3);

    // Verify only 2 punches were written (unknown.event classified as null)
    expect(writePunchMock).toHaveBeenCalledTimes(2);

    // Verify log messages
    expect(logSpy).toHaveBeenCalledWith(
      "[oc-daemon] Connecting to kilo serve at 127.0.0.1:4096"
    );
    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] Subscribing to SSE event stream...");
    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] SSE stream ended. Reconnecting...");
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

    subscribeMock
      .mockResolvedValueOnce({ stream: mockEventStream([]) })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

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
      doltDatabase: "plant",
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
  });

  it("stop() aborts the stream and disconnects from Dolt", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    subscribeMock.mockResolvedValue({ stream: mockEventStream([]) });

    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "plant",
      doltUser: "root",
    });

    await daemon.stop();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] Shutting down...");
    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] Shutdown complete.");
  });
});
