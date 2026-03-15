import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCatchUp } from "../src/lifecycle/catchup.js";

const {
  connectMock,
  disconnectMock,
  createDoltWriterMock,
  subscribeMock,
  sessionListMock,
  sessionMessagesMock,
  sessionChildrenMock,
  createOpencodeClientMock,
  classifyEventMock,
} = vi.hoisted(() => {
  const connectMock = vi.fn();
  const disconnectMock = vi.fn();
  const createDoltWriterMock = vi.fn(() => ({
    connect: connectMock,
    disconnect: disconnectMock,
    writeRawEvent: vi.fn(),
    writePunch: vi.fn(),
    writeSession: vi.fn(),
    writeTask: vi.fn(),
    writeMessage: vi.fn(),
    writeToolCall: vi.fn(),
    writeCheckpoint: vi.fn(),
    writeChildRelation: vi.fn(),
    syncChildRelsFromPunches: vi.fn().mockResolvedValue(0),
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

  const classifyEventMock = vi.fn();

  return {
    connectMock,
    disconnectMock,
    createDoltWriterMock,
    subscribeMock,
    sessionListMock,
    sessionMessagesMock,
    sessionChildrenMock,
    createOpencodeClientMock,
    classifyEventMock,
  };
});

vi.mock("../src/writer/index.js", () => ({
  createDoltWriter: createDoltWriterMock,
}));

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

vi.mock("../src/classifier/index.js", () => ({
  classifyEvent: classifyEventMock,
}));

import { createDaemon } from "../src/lifecycle/daemon.js";

function stalledStream(): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<unknown>>(() => undefined),
      };
    },
  };
}

function singleEventThenDelayedEndStream(
  event: { type: string; properties: Record<string, unknown> },
  endDelayMs: number
): AsyncIterable<unknown> {
  let step = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (step === 0) {
            step += 1;
            return Promise.resolve({ done: false, value: event });
          }
          if (step === 1) {
            step += 1;
            return new Promise<IteratorResult<unknown>>((resolve) => {
              setTimeout(() => resolve({ done: true, value: undefined }), endDelayMs);
            });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

describe("runCatchUp sinceMs", () => {
  it("filters sessions by sinceMs when provided", async () => {
    const sinceMs = 5_000;
    const sessionList = vi.fn().mockResolvedValue({
      data: [
        { id: "old-session", time: { updated: 4_000, created: 3_500 } },
        { id: "new-session-1", time: { updated: 6_000, created: 5_500 } },
        { id: "new-session-2", updatedAt: "1970-01-01T00:00:07.000Z" },
      ],
      error: undefined,
    });
    const sessionMessages = vi.fn().mockResolvedValue({ data: [], error: undefined });
    const sessionChildren = vi.fn().mockResolvedValue({ data: [], error: undefined });

    const client = {
      session: {
        list: sessionList,
        messages: sessionMessages,
        children: sessionChildren,
      },
    };
    const writer = {
      writeSession: vi.fn().mockResolvedValue(undefined),
      writePunch: vi.fn().mockResolvedValue(undefined),
      writeMessage: vi.fn().mockResolvedValue(undefined),
      writeToolCall: vi.fn().mockResolvedValue(undefined),
      writeChildRelation: vi.fn().mockResolvedValue(undefined),
      syncChildRelsFromPunches: vi.fn().mockResolvedValue(0),
    };

    const processed = await runCatchUp(client as never, writer as never, { sinceMs });

    expect(processed).toBe(2);
    expect(sessionMessages).toHaveBeenCalledTimes(2);
    expect(sessionMessages).toHaveBeenCalledWith({ path: { id: "new-session-1" } });
    expect(sessionMessages).toHaveBeenCalledWith({ path: { id: "new-session-2" } });
    expect(sessionMessages).not.toHaveBeenCalledWith({ path: { id: "old-session" } });
  });
});

describe("daemon reconnect hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    connectMock.mockResolvedValue(undefined);
    disconnectMock.mockResolvedValue(undefined);
    classifyEventMock.mockReturnValue(null);

    sessionListMock.mockResolvedValue({ data: [], error: undefined });
    sessionMessagesMock.mockResolvedValue({ data: [], error: undefined });
    sessionChildrenMock.mockResolvedValue({ data: [], error: undefined });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forces reconnect when stream is silent for 5 minutes", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    subscribeMock
      .mockResolvedValueOnce({ stream: stalledStream() })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "factory",
      doltUser: "root",
    });

    const startPromise = daemon.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
    await startPromise;

    expect(warnSpy).toHaveBeenCalledWith(
      "[oc-daemon] No SSE events received for 300000ms while connected; forcing reconnect."
    );
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });

  it("logs reconnect gap duration from last seen event", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    subscribeMock
      .mockResolvedValueOnce({
        stream: singleEventThenDelayedEndStream(
          { type: "file.edited", properties: {} },
          2_500
        ),
      })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const daemon = createDaemon({
      kiloHost: "127.0.0.1",
      kiloPort: 4096,
      doltHost: "127.0.0.1",
      doltPort: 3307,
      doltDatabase: "factory",
      doltUser: "root",
    });

    const startPromise = daemon.start();
    await vi.advanceTimersByTimeAsync(2_500 + 1_000);
    await startPromise;

    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] Reconnect gap duration: 2500ms.");
  });
});
