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
    executeMock.mockResolvedValueOnce([
      [
        makeRequirementRow({ punch_key_pattern: "read_file%" }),
        makeRequirementRow({ punch_type: "gate_pass", punch_key_pattern: "ruff-check", description: "ruff" }),
      ],
    ]);

    const client = makeClient([
      {
        role: "assistant",
        parts: [
          {
            type: "tool",
            tool: "readFile",
            state: { status: "completed" },
          },
          {
            type: "tool",
            tool: "bash",
            input: { command: "ruff check ." },
            state: { status: "completed" },
          },
        ],
      },
    ]);

    const result = await validateFromKiloLog("ses-pass", client, DOLT_CONFIG, "execute-subtask");

    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("derives gate_pass from session.messages replay shape (state.input.command)", async () => {
    executeMock.mockResolvedValueOnce([
      [
        makeRequirementRow({
          punch_type: "gate_pass",
          punch_key_pattern: "ruff-format",
          description: "ruff format",
        }),
      ],
    ]);

    const client = makeClient([
      {
        parts: [
          {
            type: "tool",
            tool: "bash",
            input: null,
            state: { status: "completed", input: { command: "ruff format --check ." } },
          },
          {
            type: "step-finish",
          },
        ],
      },
    ]);

    const result = await validateFromKiloLog("ses-replay-shape", client, DOLT_CONFIG, "execute-subtask");

    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
  });

  it("does not derive task_exit when session has no step-finish parts", async () => {
    executeMock.mockResolvedValueOnce([
      [
        makeRequirementRow({
          punch_type: "step_complete",
          punch_key_pattern: "task_exit",
          description: "must complete",
        }),
      ],
    ]);

    const client = makeClient([
      {
        parts: [
          {
            type: "tool",
            tool: "readFile",
            state: { status: "completed" },
          },
        ],
      },
    ]);

    const result = await validateFromKiloLog("ses-abandoned", client, DOLT_CONFIG, "execute-subtask");

    expect(result.status).toBe("fail");
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({
      punchType: "step_complete",
      punchKeyPattern: "task_exit",
    });
  });

  it("fails when a required punch is missing", async () => {
    executeMock.mockResolvedValueOnce([[makeRequirementRow({ punch_key_pattern: "edit_file%" })]]);

    const client = makeClient([
      {
        parts: [
          {
            type: "tool",
            tool: "readFile",
            state: { status: "completed" },
          },
        ],
      },
    ]);

    const result = await validateFromKiloLog("ses-missing", client, DOLT_CONFIG, "execute-subtask");

    expect(result.status).toBe("fail");
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({
      punchType: "tool_call",
      punchKeyPattern: "edit_file%",
    });
  });

  it("detects forbidden punch violations", async () => {
    executeMock.mockResolvedValueOnce([
      [
        makeRequirementRow({
          punch_key_pattern: "apply_diff%",
          forbidden: 1,
          required: 0,
          description: "must not apply diff",
        }),
      ],
    ]);

    const client = makeClient([
      {
        parts: [
          {
            type: "tool",
            tool: "applyDiff",
            state: { status: "completed" },
          },
        ],
      },
    ]);

    const result = await validateFromKiloLog("ses-forbidden", client, DOLT_CONFIG, "execute-subtask");

    expect(result.status).toBe("fail");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      punchType: "tool_call",
      punchKeyPattern: "apply_diff%",
      count: 1,
    });
  });

  it("populates chain-of-custody metadata", async () => {
    executeMock.mockResolvedValueOnce([[makeRequirementRow({ punch_key_pattern: "read%" })]]);

    const client = makeClient([
      {
        parts: [
          {
            type: "tool",
            tool: "readFile",
            state: { status: "completed" },
          },
        ],
      },
      {
        parts: [],
      },
    ]);

    const result = await validateFromKiloLog("ses-coc", client, DOLT_CONFIG, "execute-subtask", {
      sourceSessionId: "ses-parent",
      enforcedOnly: true,
    });

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
    executeMock.mockResolvedValueOnce([
      [
        makeRequirementRow({
          punch_type: "3",
          punch_key_pattern: "%context7%",
          description: "legacy mcp requirement",
        }),
        makeRequirementRow({
          punch_type: "4",
          punch_key_pattern: "mypy",
          description: "legacy gate requirement",
        }),
      ],
    ]);

    const client = makeClient([
      {
        parts: [
          {
            type: "tool",
            tool: "context7_query-docs",
            state: { status: "completed" },
          },
          {
            type: "tool",
            tool: "bash",
            input: { command: "mypy src" },
            state: { status: "completed" },
          },
        ],
      },
    ]);

    const result = await validateFromKiloLog("ses-legacy", client, DOLT_CONFIG, "execute-subtask");
    expect(result.status).toBe("pass");
  });
});
