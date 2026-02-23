import { describe, expect, it } from "vitest";

import { classifyEvent, type RawEvent } from "../src/classifier/index.js";

function makeEvent(type: string, properties: Record<string, unknown> = {}): RawEvent {
  return { type, properties };
}

describe("classifyEvent", () => {
  it("returns null for unrecognized event types", () => {
    const result = classifyEvent(makeEvent("unknown.event", { taskId: "daemon-1" }));
    expect(result).toBeNull();
  });

  it("maps message.part.updated tool parts to tool_call", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-f9x",
          callID: "call-1",
          tool: "readFile",
          state: { status: "completed" },
        },
      })
    );

    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("daemon-f9x");
    expect(result?.punchType).toBe("tool_call");
    expect(result?.punchKey).toBe("readFile");
    expect(result?.observedAt).toBeInstanceOf(Date);
    expect(result?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns null for pending tool calls", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-pending",
          callID: "call-pending",
          tool: "readFile",
          state: { status: "pending" },
        },
      })
    );

    expect(result).toBeNull();
  });

  it("returns null for running tool calls", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-running",
          callID: "call-running",
          tool: "readFile",
          state: { status: "running" },
        },
      })
    );

    expect(result).toBeNull();
  });

  it('defaults to "unknown_tool" when tool is missing', () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-fallback",
          callID: "call-2",
          state: { status: "completed" },
        },
      })
    );

    expect(result).not.toBeNull();
    expect(result?.punchKey).toBe("unknown_tool");
  });

  it("maps error tool calls to tool_call", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-error",
          callID: "call-error",
          tool: "editFile",
          state: { status: "error" },
        },
      })
    );

    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("daemon-error");
    expect(result?.punchType).toBe("tool_call");
    expect(result?.punchKey).toBe("editFile");
  });

  it("extracts task ID from message part sessionID or defaults unknown", () => {
    const fromPartSessionID = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "id-3",
          callID: "call-3",
          tool: "x",
          state: { status: "completed" },
        },
      })
    );
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: { type: "tool", callID: "call-4", tool: "x", state: { status: "completed" } },
      })
    );

    expect(fromPartSessionID?.taskId).toBe("id-3");
    expect(result?.taskId).toBe("unknown");
  });

  it("maps message.part.updated step-start parts to step_complete", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: { type: "step-start", sessionID: "daemon-step" },
      })
    );

    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("daemon-step");
    expect(result?.punchType).toBe("step_complete");
    expect(result?.punchKey).toBe("step_start_observed");
  });

  it("maps session.updated completed to step_complete", () => {
    const result = classifyEvent(
      makeEvent("session.updated", {
        info: { id: "session-1", projectID: "p1", status: "completed" },
      })
    );

    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("session-1");
    expect(result?.punchType).toBe("step_complete");
    expect(result?.punchKey).toBe("session_completed");
  });

  it("returns null for non-punch-worthy part and session states", () => {
    const nonCompletedSession = classifyEvent(
      makeEvent("session.updated", {
        info: { id: "id-5", projectID: "p1", status: "running" },
      })
    );

    expect(nonCompletedSession).toBeNull();
  });

  it("maps message.part.updated text parts to message/text_response", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: { type: "text", sessionID: "id-text" },
      })
    );
    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("id-text");
    expect(result?.punchType).toBe("message");
    expect(result?.punchKey).toBe("text_response");
  });

  it("maps message.part.updated step-finish parts to step_complete/step_finished", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: { type: "step-finish", sessionID: "id-step-finish" },
      })
    );
    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("id-step-finish");
    expect(result?.punchType).toBe("step_complete");
    expect(result?.punchKey).toBe("step_finished");
  });

  it("maps session lifecycle events", () => {
    const created = classifyEvent(makeEvent("session.created", { info: { id: "s-1" } }));
    expect(created?.taskId).toBe("s-1");
    expect(created?.punchType).toBe("session_lifecycle");
    expect(created?.punchKey).toBe("session_created");

    const deleted = classifyEvent(makeEvent("session.deleted", { info: { id: "s-1" } }));
    expect(deleted?.taskId).toBe("s-1");
    expect(deleted?.punchType).toBe("session_lifecycle");
    expect(deleted?.punchKey).toBe("session_deleted");

    const idle = classifyEvent(makeEvent("session.idle", { info: { id: "s-1" } }));
    expect(idle?.taskId).toBe("s-1");
    expect(idle?.punchType).toBe("session_lifecycle");
    expect(idle?.punchKey).toBe("session_idle");

    const error = classifyEvent(makeEvent("session.error", { info: { id: "s-1" } }));
    expect(error?.taskId).toBe("s-1");
    expect(error?.punchType).toBe("session_lifecycle");
    expect(error?.punchKey).toBe("session_error");
  });
});
