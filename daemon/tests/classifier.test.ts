import { describe, expect, it } from "vitest";

import { classifyEvent, type RawEvent, toSnakeCase } from "../src/classifier/index.js";

function makeEvent(type: string, properties: Record<string, unknown> = {}): RawEvent {
  return { type, properties };
}

describe("toSnakeCase", () => {
  it("converts camelCase to snake_case", () => {
    expect(toSnakeCase("editFile")).toBe("edit_file");
    expect(toSnakeCase("updateTodoList")).toBe("update_todo_list");
  });

  it("keeps already_snake_case unchanged", () => {
    expect(toSnakeCase("already_snake")).toBe("already_snake");
  });

  it("converts PascalCase to snake_case", () => {
    expect(toSnakeCase("ReadFile")).toBe("read_file");
  });

  it("keeps single words as lowercase single words", () => {
    expect(toSnakeCase("read")).toBe("read");
  });
});

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
    expect(result?.punchKey).toBe("read_file");
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
    expect(result?.punchKey).toBe("edit_file");
  });

  it("maps task tool calls to child_spawn using subagent_type from input (real-time SSE path)", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-child",
          tool: "task",
          input: { subagent_type: "process-orchestrator" },
          state: { status: "completed" },
        },
      })
    );

    expect(result?.punchType).toBe("child_spawn");
    expect(result?.punchKey).toBe("process-orchestrator");
  });

  it("maps task tool calls to child_spawn using subagent_type from state.input (replay path)", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-child-replay",
          tool: "task",
          state: { status: "completed", input: { subagent_type: "architect" } },
        },
      })
    );

    expect(result?.punchType).toBe("child_spawn");
    expect(result?.punchKey).toBe("architect");
  });

  it("falls back to unknown_child when subagent_type is absent in both input and state.input", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-child-unknown",
          tool: "task",
          state: { status: "completed" },
        },
      })
    );

    expect(result?.punchType).toBe("child_spawn");
    expect(result?.punchKey).toBe("unknown_child");
  });

  it("prefers input.subagent_type over state.input.subagent_type when both are present", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-child-both",
          tool: "task",
          input: { subagent_type: "code" },
          state: { status: "completed", input: { subagent_type: "architect" } },
        },
      })
    );

    expect(result?.punchType).toBe("child_spawn");
    expect(result?.punchKey).toBe("code");
  });

  it("maps bash gate commands to gate_pass", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-gate",
          tool: "bash",
          input: { command: "ruff check ." },
          state: { status: "completed" },
        },
      })
    );

    expect(result?.punchType).toBe("gate_pass");
    expect(result?.punchKey).toBe("ruff-check");
  });

  it("maps failed bash gate commands to gate_fail", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-gate-fail",
          tool: "bash",
          input: { command: "pytest -q" },
          state: { status: "error" },
        },
      })
    );

    expect(result?.punchType).toBe("gate_fail");
    expect(result?.punchKey).toBe("pytest");
  });

  it("maps non-gate bash commands to command_exec", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-command",
          tool: "bash",
          input: { command: "ls -la" },
          state: { status: "completed" },
        },
      })
    );

    expect(result?.punchType).toBe("command_exec");
    expect(result?.punchKey).toBe("bash");
  });

  it("maps MCP tools to mcp_call", () => {
    const result = classifyEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "tool",
          sessionID: "daemon-mcp",
          tool: "augment-context-engine_codebase-retrieval",
          state: { status: "completed" },
        },
      })
    );

    expect(result?.punchType).toBe("mcp_call");
    expect(result?.punchKey).toBe("codebase___retrieval");
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

  it("maps non-completed session.updated to session_lifecycle/session_updated", () => {
    const nonCompletedSession = classifyEvent(
      makeEvent("session.updated", {
        info: { id: "id-5", projectID: "p1", status: "running" },
      })
    );

    expect(nonCompletedSession).not.toBeNull();
    expect(nonCompletedSession?.taskId).toBe("id-5");
    expect(nonCompletedSession?.punchType).toBe("session_lifecycle");
    expect(nonCompletedSession?.punchKey).toBe("session_updated");
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

  it("maps message.updated with finish=end to step_complete/session_completed", () => {
    const result = classifyEvent(
      makeEvent("message.updated", {
        info: { sessionID: "ses-1", role: "assistant", finish: "end", mode: "code" },
      })
    );
    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("ses-1");
    expect(result?.punchType).toBe("step_complete");
    expect(result?.punchKey).toBe("session_completed");
  });

  it("maps message.updated with finish=abort to session_lifecycle", () => {
    const result = classifyEvent(
      makeEvent("message.updated", {
        info: { sessionID: "ses-2", role: "assistant", finish: "abort" },
      })
    );
    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("ses-2");
    expect(result?.punchType).toBe("session_lifecycle");
    expect(result?.punchKey).toBe("session_abort");
  });

  it("returns null for message.updated without finish field", () => {
    const result = classifyEvent(
      makeEvent("message.updated", {
        info: { sessionID: "ses-3", role: "assistant" },
      })
    );
    expect(result).toBeNull();
  });

  it("returns null for message.updated from non-assistant role", () => {
    const result = classifyEvent(
      makeEvent("message.updated", {
        info: { sessionID: "ses-4", role: "user", finish: "end" },
      })
    );
    expect(result).toBeNull();
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
