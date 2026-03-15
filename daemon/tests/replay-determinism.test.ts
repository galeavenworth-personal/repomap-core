import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { replaySessionFromLog } from "../src/lifecycle/replay.js";

function makeWriterMock() {
  return {
    writePunch: vi.fn().mockResolvedValue(undefined),
    writeSession: vi.fn().mockResolvedValue(undefined),
    writeMessage: vi.fn().mockResolvedValue(undefined),
    writeToolCall: vi.fn().mockResolvedValue(undefined),
  };
}

describe("replay determinism", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("derives identical punches for repeated replay", async () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "bash",
            input: { command: "ruff check ." },
            state: { status: "completed" },
            tokens: { input: 10, output: 5 },
            ts: 101,
          },
          {
            type: "text",
            text: "done",
            tokens: { input: 2, output: 3 },
            ts: 102,
          },
        ],
      },
    ];

    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({ data: messages, error: undefined }),
      },
    };

    const writer = makeWriterMock();

    const first = await replaySessionFromLog("ses-deterministic", client, writer as never);
    const firstCalls = writer.writePunch.mock.calls.map((call) => call[0]);

    const second = await replaySessionFromLog("ses-deterministic", client, writer as never);
    const secondCalls = writer.writePunch.mock.calls.slice(firstCalls.length).map((call) => call[0]);

    const firstSerialized = first.derivedPunches.map((punch) => ({
      taskId: punch.taskId,
      punchType: punch.punchType,
      punchKey: punch.punchKey,
      sourceHash: punch.sourceHash,
      observedAt: punch.observedAt.toISOString(),
    }));
    const secondSerialized = second.derivedPunches.map((punch) => ({
      taskId: punch.taskId,
      punchType: punch.punchType,
      punchKey: punch.punchKey,
      sourceHash: punch.sourceHash,
      observedAt: punch.observedAt.toISOString(),
    }));

    expect(firstSerialized).toEqual(secondSerialized);
    expect(firstCalls).toEqual(secondCalls);
    expect(first.punchesDerived).toBe(second.punchesDerived);
  });

  it("does not write in dry-run mode", async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant" },
              parts: [
                {
                  type: "tool",
                  tool: "bash",
                  input: { command: "pytest" },
                  state: { status: "completed" },
                  ts: 999,
                },
              ],
            },
          ],
          error: undefined,
        }),
      },
    };

    const writer = makeWriterMock();

    const result = await replaySessionFromLog("ses-dry-run", client, writer as never, {
      dryRun: true,
    });

    expect(result.punchesDerived).toBeGreaterThan(0);
    expect(result.rowsWritten).toBe(0);
    expect(writer.writePunch).not.toHaveBeenCalled();
    expect(writer.writeSession).not.toHaveBeenCalled();
    expect(writer.writeMessage).not.toHaveBeenCalled();
    expect(writer.writeToolCall).not.toHaveBeenCalled();
  });
});
