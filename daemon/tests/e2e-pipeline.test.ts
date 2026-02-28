import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  connectMock,
  disconnectMock,
  writePunchMock,
  writeSessionMock,
  writeMessageMock,
  writeToolCallMock,
  syncChildRelsFromPunchesMock,
  writeChildRelationMock,
  createDoltWriterMock,
  subscribeMock,
  createOpencodeClientMock,
  sessionListMock,
  sessionMessagesMock,
  sessionChildrenMock,
} = vi.hoisted(() => {
  const connectMock = vi.fn();
  const disconnectMock = vi.fn();
  const writePunchMock = vi.fn();
  const writeSessionMock = vi.fn();
  const writeMessageMock = vi.fn();
  const writeToolCallMock = vi.fn();
  const syncChildRelsFromPunchesMock = vi.fn();
  const writeChildRelationMock = vi.fn();
  const createDoltWriterMock = vi.fn(() => ({
    connect: connectMock,
    writePunch: writePunchMock,
    writeSession: writeSessionMock,
    writeMessage: writeMessageMock,
    writeToolCall: writeToolCallMock,
    writeChildRelation: writeChildRelationMock,
    syncChildRelsFromPunches: syncChildRelsFromPunchesMock,
    disconnect: disconnectMock,
  }));
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
    writeSessionMock,
    writeMessageMock,
    writeToolCallMock,
    syncChildRelsFromPunchesMock,
    writeChildRelationMock,
    createDoltWriterMock,
    subscribeMock,
    createOpencodeClientMock,
    sessionListMock,
    sessionMessagesMock,
    sessionChildrenMock,
  };
});

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

vi.mock("../src/writer/index.js", () => ({
  createDoltWriter: createDoltWriterMock,
}));

import { createDaemon } from "../src/lifecycle/daemon.js";

async function* mockEventStream(
  events: Array<{ type: string; properties: Record<string, unknown> }>
) {
  for (const event of events) {
    yield event;
  }
}

const config = {
  kiloHost: "127.0.0.1",
  kiloPort: 4096,
  doltHost: "127.0.0.1",
  doltPort: 3307,
  doltDatabase: "plant",
  doltUser: "root",
};

describe("e2e pipeline integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    connectMock.mockResolvedValue(undefined);
    disconnectMock.mockResolvedValue(undefined);
    writePunchMock.mockResolvedValue(undefined);
    writeSessionMock.mockResolvedValue(undefined);
    writeMessageMock.mockResolvedValue(undefined);
    writeToolCallMock.mockResolvedValue(undefined);
    syncChildRelsFromPunchesMock.mockResolvedValue(0);
    writeChildRelationMock.mockResolvedValue(undefined);
    sessionListMock.mockResolvedValue({ data: [] });
    sessionMessagesMock.mockResolvedValue({ data: [] });
    sessionChildrenMock.mockResolvedValue({ data: [] });
  });

  it("full pipeline: SSE → classify → write", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            callID: "call-1",
            tool: "readFile",
            state: { status: "completed" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            callID: "call-1",
            tool: "readFile",
            state: { status: "running" },
          },
        },
      },
      {
        type: "session.updated",
        properties: {
          info: { id: "sess-1", projectID: "p1", status: "completed" },
        },
      },
      { type: "file.edited", properties: {} },
    ];

    subscribeMock
      .mockResolvedValueOnce({ stream: mockEventStream(events) })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const daemon = createDaemon(config);
    await daemon.start();

    expect(writePunchMock).toHaveBeenCalledTimes(2);

    const firstPunch = writePunchMock.mock.calls[0]?.[0] as {
      taskId: string;
      punchType: string;
      punchKey: string;
      observedAt: Date;
      sourceHash: string;
    };
    expect(firstPunch.punchType).toBe("tool_call");
    expect(firstPunch.punchKey).toBe("readFile");
    expect(firstPunch.taskId).toBe("sess-1");
    expect(firstPunch.observedAt).toBeInstanceOf(Date);
    expect(firstPunch.sourceHash).toMatch(/^[a-f0-9]{64}$/);

    const secondPunch = writePunchMock.mock.calls[1]?.[0] as {
      taskId: string;
      punchType: string;
      punchKey: string;
      observedAt: Date;
      sourceHash: string;
    };
    expect(secondPunch.punchType).toBe("step_complete");
    expect(secondPunch.punchKey).toBe("session_completed");
    expect(secondPunch.taskId).toBe("sess-1");
    expect(secondPunch.observedAt).toBeInstanceOf(Date);
    expect(secondPunch.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("pipeline wiring: null classifier results are skipped", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: { type: "reasoning", sessionID: "sess-1", text: "thinking..." },
        },
      },
      {
        type: "session.updated",
        properties: {
          info: { id: "sess-1", projectID: "p1" },
          status: "running",
        },
      },
      { type: "file.edited", properties: {} },
    ];

    subscribeMock
      .mockResolvedValueOnce({ stream: mockEventStream(events) })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const daemon = createDaemon(config);
    await daemon.start();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(writePunchMock).not.toHaveBeenCalled();
  });

  it("session lifecycle: realistic sequence produces correct punch count", async () => {
    const events = [
      { type: "session.created", properties: { info: { id: "sess-1" } } },
      {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            callID: "call-1",
            tool: "readFile",
            state: { status: "running" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            callID: "call-1",
            tool: "readFile",
            state: { status: "running" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            callID: "call-1",
            tool: "readFile",
            state: { status: "completed" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { type: "step-start", sessionID: "sess-1" },
        },
      },
      {
        type: "session.updated",
        properties: {
          info: { id: "sess-1", projectID: "p1", status: "completed" },
        },
      },
    ];

    subscribeMock
      .mockResolvedValueOnce({ stream: mockEventStream(events) })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const daemon = createDaemon(config);
    await daemon.start();

    expect(writePunchMock).toHaveBeenCalledTimes(4);
  });

  it("error resilience: writer failure propagates (logs and retries)", async () => {
    const events = [
      {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            callID: "call-1",
            tool: "readFile",
            state: { status: "completed" },
          },
        },
      },
    ];

    subscribeMock
      .mockResolvedValueOnce({ stream: mockEventStream(events) })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    
    writePunchMock.mockRejectedValueOnce(new Error("Dolt connection lost"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const daemon = createDaemon(config);

    // Should not throw, but catch and retry (loop ends on AbortError)
    await daemon.start();

    expect(consoleError).toHaveBeenCalledWith(
      "[oc-daemon] SSE stream error:",
      expect.objectContaining({ message: "Dolt connection lost" })
    );
  });

  it("error resilience: empty stream triggers reconnect", async () => {
    subscribeMock
      .mockResolvedValueOnce({ stream: mockEventStream([]) })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const daemon = createDaemon(config);
    await daemon.start();

    // Connects, stream ends (empty), loops, connects again (throws abort)
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(writePunchMock).not.toHaveBeenCalled();
  });
});
