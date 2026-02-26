import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const endMock = vi.hoisted(() => vi.fn());
const createConnectionMock = vi.hoisted(() => vi.fn());

vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: createConnectionMock,
  },
}));

import { PunchCardValidator } from "../src/governor/punch-card-validator.js";

describe("PunchCardValidator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endMock.mockResolvedValue(undefined);
    createConnectionMock.mockResolvedValue({
      execute: executeMock,
      end: endMock,
    });
  });

  it("passes when all required punches exist", async () => {
    executeMock
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "read_file%",
            required: 1,
            forbidden: 0,
            description: "must read file",
          },
          {
            punch_type: "tool_call",
            punch_key_pattern: "edit_file%",
            required: 1,
            forbidden: 0,
            description: "must edit file",
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 1 }]])
      .mockResolvedValueOnce([[{ count: 2 }]]);

    const validator = new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" });
    await validator.connect();
    const result = await validator.validatePunchCard("task-1", "card-1");

    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("fails when a required punch is missing", async () => {
    executeMock
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "read_file%",
            required: 1,
            forbidden: 0,
            description: "must read file",
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 0 }]]);

    const validator = new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" });
    await validator.connect();
    const result = await validator.validatePunchCard("task-2", "card-2");

    expect(result.status).toBe("fail");
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({
      punchType: "tool_call",
      punchKeyPattern: "read_file%",
    });
  });

  it("fails when a forbidden required punch exists", async () => {
    executeMock
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "apply_diff%",
            required: 1,
            forbidden: 1,
            description: "must not apply diff",
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 3 }]]);

    const validator = new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" });
    await validator.connect();
    const result = await validator.validatePunchCard("task-3", "card-3");

    expect(result.status).toBe("fail");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      punchType: "tool_call",
      punchKeyPattern: "apply_diff%",
      count: 3,
    });
  });

  it("skips optional requirements", async () => {
    executeMock.mockResolvedValueOnce([
      [
        {
          punch_type: "tool_call",
          punch_key_pattern: "optional%",
          required: 0,
          forbidden: 0,
          description: "optional",
        },
      ],
    ]);

    const validator = new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" });
    await validator.connect();
    const result = await validator.validatePunchCard("task-4", "card-4");

    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("tool adherence is within range", async () => {
    executeMock.mockResolvedValueOnce([[{ count: 2 }]]);

    const validator = new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" });
    await validator.connect();
    const result = await validator.checkToolAdherence("task-5", [1, 3]);

    expect(result.editCount).toBe(2);
    expect(result.withinRange).toBe(true);
  });

  it("tool adherence fails when below range", async () => {
    executeMock.mockResolvedValueOnce([[{ count: 0 }]]);

    const validator = new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" });
    await validator.connect();
    const result = await validator.checkToolAdherence("task-6", [1, 3]);

    expect(result.editCount).toBe(0);
    expect(result.withinRange).toBe(false);
  });

  it("empty card returns fail", async () => {
    executeMock.mockResolvedValueOnce([[]]);

    const validator = new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" });
    await validator.connect();
    const result = await validator.validatePunchCard("task-7", "card-empty");

    expect(result.status).toBe("fail");
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
  });
});
