import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as catchupModule from "../src/lifecycle/catchup.js";

const {
  connectMock,
  disconnectMock,
  createDoltWriterMock,
  createEventSourceMock,
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

  const classifyEventMock = vi.fn();

  return {
    connectMock,
    disconnectMock,
    createDoltWriterMock,
    createEventSourceMock,
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

vi.mock("eventsource-client", () => ({
  createEventSource: createEventSourceMock,
}));

import { createDaemon } from "../src/lifecycle/daemon.js";

function eventSourceFromEvents(
  events: Array<{ data: { type: string; properties: Record<string, unknown> }; event?: string; id?: string }>
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

    const processed = await catchupModule.runCatchUp(client as never, writer as never, { sinceMs });

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

  it("runs reconnect catch-up when stream reconnects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createEventSourceMock.mockImplementation((options: { onConnect?: () => void; onDisconnect?: () => void }) => {
      options.onConnect?.();
      options.onDisconnect?.();
      options.onConnect?.();
      return eventSourceFromEvents([
        {
          data: { type: "file.edited", properties: {} },
        },
      ]);
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

    expect(logSpy).toHaveBeenCalledWith("[oc-daemon] Reconnect catch-up skipped (no prior event timestamp).");
    expect(createEventSourceMock).toHaveBeenCalledTimes(1);
  });

  it("logs reconnect gap duration from last seen event", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createEventSourceMock.mockImplementation((options: { onConnect?: () => void; onDisconnect?: () => void }) => {
      options.onConnect?.();
      return {
        close: vi.fn(),
        [Symbol.asyncIterator]() {
          let step = 0;
          return {
            next: () => {
              if (step === 0) {
                step += 1;
                return Promise.resolve({
                  done: false,
                  value: { data: { type: "file.edited", properties: {} } },
                });
              }
              if (step === 1) {
                step += 1;
                return new Promise((resolve) => {
                  setTimeout(() => {
                    options.onDisconnect?.();
                    options.onConnect?.();
                    resolve({ done: true, value: undefined });
                  }, 2_500);
                });
              }
              return Promise.resolve({ done: true, value: undefined });
            },
          } as AsyncIterator<{
            data: { type: string; properties: Record<string, unknown> };
            event?: string;
            id?: string;
          }>;
        },
      };
    });

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
