import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, endMock, createConnectionMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  endMock: vi.fn(),
  createConnectionMock: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  default: { createConnection: createConnectionMock },
}));

import { validateFromKiloLog } from "../src/governor/kilo-verified-validator.js";

const DOLT_CONFIG = {
  host: "127.0.0.1",
  port: 3307,
  database: "factory",
  user: "root",
  password: "",
};

function makeClient(messages: unknown[]) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages, error: null }),
    },
  };
}

function makeRequirementRow(overrides: Partial<{
  punch_type: string;
  punch_key_pattern: string;
  required: number;
  forbidden: number;
  enforced: number;
  description: string;
}> = {}) {
  return {
    punch_type: "tool_call",
    punch_key_pattern: "read_file%",
    required: 1,
    forbidden: 0,
    enforced: 1,
    description: "required read",
    ...overrides,
  };
}

function makeToolPart(tool: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "tool",
    tool,
    state: { status: "completed" },
    ...overrides,
  };
}

function makeToolMessage(parts: Record<string, unknown>[]) {
  return { parts };
}

/** Run a full validate-from-kilo-log cycle with mock requirements + messages. */
async function runValidation(
  sessionId: string,
  requirements: ReturnType<typeof makeRequirementRow>[],
  messages: unknown[],
  cardId = "execute-subtask",
  opts?: { sourceSessionId?: string; enforcedOnly?: boolean },
) {
  executeMock.mockResolvedValueOnce([requirements]);
  const client = makeClient(messages);
  return validateFromKiloLog(sessionId, client, DOLT_CONFIG, cardId, opts);
}

describe("validateFromKiloLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endMock.mockResolvedValue(undefined);
    createConnectionMock.mockResolvedValue({
      execute: executeMock,
      end: endMock,
    });
  });

  it("passes when all required punches are derived from session messages", async () => {
    const result = await runValidation("ses-pass", [
      makeRequirementRow({ punch_key_pattern: "read_file%" }),
      makeRequirementRow({ punch_type: "gate_pass", punch_key_pattern: "ruff-check", description: "ruff" }),
    ], [{
      role: "assistant",
      parts: [
        makeToolPart("readFile"),
        makeToolPart("bash", { input: { command: "ruff check ." } }),
      ],
    }]);

    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("derives gate_pass from session.messages replay shape (state.input.command)", async () => {
    const result = await runValidation("ses-replay-shape", [
      makeRequirementRow({ punch_type: "gate_pass", punch_key_pattern: "ruff-format", description: "ruff format" }),
    ], [
      makeToolMessage([
        makeToolPart("bash", { input: null, state: { status: "completed", input: { command: "ruff format --check ." } } }),
        { type: "step-finish" },
      ]),
    ]);

    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
  });

  it("does not derive task_exit when session has no step-finish parts", async () => {
    const result = await runValidation("ses-abandoned", [
      makeRequirementRow({ punch_type: "step_complete", punch_key_pattern: "task_exit", description: "must complete" }),
    ], [makeToolMessage([makeToolPart("readFile")])]);

    expect(result.status).toBe("fail");
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({ punchType: "step_complete", punchKeyPattern: "task_exit" });
  });

  it("fails when a required punch is missing", async () => {
    const result = await runValidation("ses-missing", [
      makeRequirementRow({ punch_key_pattern: "edit_file%" }),
    ], [makeToolMessage([makeToolPart("readFile")])]);

    expect(result.status).toBe("fail");
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({ punchType: "tool_call", punchKeyPattern: "edit_file%" });
  });

  it("detects forbidden punch violations", async () => {
    const result = await runValidation("ses-forbidden", [
      makeRequirementRow({ punch_key_pattern: "apply_diff%", forbidden: 1, required: 0, description: "must not apply diff" }),
    ], [makeToolMessage([makeToolPart("applyDiff")])]);

    expect(result.status).toBe("fail");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ punchType: "tool_call", punchKeyPattern: "apply_diff%", count: 1 });
  });

  it("populates chain-of-custody metadata", async () => {
    const result = await runValidation(
      "ses-coc",
      [makeRequirementRow({ punch_key_pattern: "read%" })],
      [makeToolMessage([makeToolPart("readFile")]), makeToolMessage([])],
      "execute-subtask",
      { sourceSessionId: "ses-parent", enforcedOnly: true },
    );

    expect(result.sessionId).toBe("ses-coc");
    expect(result.sourceSessionId).toBe("ses-parent");
    expect(result.messageCount).toBe(2);
    expect(result.derivationPath).toContain("session.messages");
    expect(result.trustLevel).toBe("verified");
    expect(executeMock).toHaveBeenCalledWith(expect.stringContaining("AND enforced = TRUE"), [
      "execute-subtask",
    ]);
  });

  it("matches legacy numeric types and context7 wildcard patterns", async () => {
    const result = await runValidation("ses-legacy", [
      makeRequirementRow({ punch_type: "3", punch_key_pattern: "%context7%", description: "legacy mcp requirement" }),
      makeRequirementRow({ punch_type: "4", punch_key_pattern: "mypy", description: "legacy gate requirement" }),
    ], [makeToolMessage([
      makeToolPart("context7_query-docs"),
      makeToolPart("bash", { input: { command: "mypy src" } }),
    ])]);
    expect(result.status).toBe("pass");
  });

  it.each([
    {
      name: "legacy type '6' child_spawn",
      id: "ses-legacy-child",
      req: { punch_type: "6", punch_key_pattern: "%orchestrator%", description: "legacy child_spawn" },
      parts: [makeToolPart("task", { input: { subagent_type: "process-orchestrator" } })],
      card: "plant-orchestrate",
    },
    {
      name: "child_complete:child_return for completed task",
      id: "ses-child-complete",
      req: { punch_type: "child_complete", punch_key_pattern: "child_return", required: 1, description: "child must complete" },
      parts: [makeToolPart("task", { input: { subagent_type: "code" } })],
      card: "process-orchestrate",
    },
    {
      name: "error child yields child_error punch",
      id: "ses-child-error-detected",
      req: { punch_type: "child_complete", punch_key_pattern: "child_error", required: 1, description: "error child detected" },
      parts: [makeToolPart("task", { input: { subagent_type: "code" }, state: { status: "error" } })],
      card: "process-orchestrate",
    },
    {
      name: "legacy type '7' child_complete",
      id: "ses-legacy-child-complete",
      req: { punch_type: "7", punch_key_pattern: "child_return", required: 1, description: "legacy child_complete" },
      parts: [makeToolPart("task", { input: { subagent_type: "code" } })],
      card: "process-orchestrate",
    },
    {
      name: "legacy type '6' child_spawn via state.input replay",
      id: "ses-legacy-child-replay",
      req: { punch_type: "6", punch_key_pattern: "%orchestrator%", description: "legacy child_spawn (replay)" },
      parts: [makeToolPart("task", { input: null, state: { status: "completed", input: { subagent_type: "process-orchestrator" } } })],
      card: "plant-orchestrate",
    },
  ])("passes: $name", async ({ id, req, parts, card }) => {
    const result = await runValidation(id, [makeRequirementRow(req)], [makeToolMessage(parts)], card);
    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
  });

  it("derives child_complete:child_error for errored task tool parts", async () => {
    const result = await runValidation("ses-child-error", [
      makeRequirementRow({ punch_type: "child_complete", punch_key_pattern: "child_return", required: 1, description: "child must complete successfully" }),
    ], [makeToolMessage([
      makeToolPart("task", { input: { subagent_type: "code" }, state: { status: "error" } }),
    ])], "process-orchestrate");
    expect(result.status).toBe("fail");
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({ punchType: "child_complete", punchKeyPattern: "child_return" });
  });

  it("derives one child_complete:child_return per child_spawn", async () => {
    const result = await runValidation("ses-multi-child", [
      makeRequirementRow({ punch_type: "child_spawn", punch_key_pattern: "code", required: 1, description: "must spawn code child" }),
      makeRequirementRow({ punch_type: "child_complete", punch_key_pattern: "child_return", required: 1, description: "child must return" }),
    ], [makeToolMessage([
      makeToolPart("task", { input: { subagent_type: "code" } }),
      makeToolPart("task", { input: { subagent_type: "architect" } }),
    ])], "process-orchestrate");
    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
  });
});
