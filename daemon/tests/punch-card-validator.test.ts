import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, endMock, createConnectionMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  endMock: vi.fn(),
  createConnectionMock: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({
  default: { createConnection: createConnectionMock },
}));

import {
  chainValidation,
  createConnectedValidator,
  makeCountResult,
  makeRequirement,
  setupMysqlMocks,
} from "./helpers/punch-card-test-utils.js";

describe("PunchCardValidator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMysqlMocks(executeMock, endMock, createConnectionMock);
  });

  it("passes when all required punches exist", async () => {
    executeMock
      .mockResolvedValueOnce([
        [
          {
            ...makeRequirement(),
            description: "must read file",
          },
          {
            ...makeRequirement({ punch_key_pattern: "edit_file%" }),
            description: "must edit file",
          },
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1))
      .mockResolvedValueOnce(makeCountResult(2));

    const validator = await createConnectedValidator();
    const result = await validator.validatePunchCard("task-1", "card-1");

    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("fails when a required punch is missing", async () => {
    chainValidation(executeMock, { count: 0 });

    const validator = await createConnectedValidator();
    const result = await validator.validatePunchCard("task-2", "card-2");

    expect(result.status).toBe("fail");
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toMatchObject({
      punchType: "tool_call",
      punchKeyPattern: "read_file%",
    });
  });

  it("fails when a forbidden required punch exists", async () => {
    chainValidation(executeMock, {
      requirements: [{ punch_key_pattern: "apply_diff%", forbidden: 1 }],
      count: 3,
    });

    const validator = await createConnectedValidator();
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
          ...makeRequirement({ punch_key_pattern: "optional%", required: 0 }),
          description: "optional",
        },
      ],
    ]);

    const validator = await createConnectedValidator();
    const result = await validator.validatePunchCard("task-4", "card-4");

    expect(result.status).toBe("pass");
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("tool adherence is within range", async () => {
    executeMock.mockResolvedValueOnce(makeCountResult(2));

    const validator = await createConnectedValidator();
    const result = await validator.checkToolAdherence("task-5", [1, 3]);

    expect(result.editCount).toBe(2);
    expect(result.withinRange).toBe(true);
  });

  it("tool adherence fails when below range", async () => {
    executeMock.mockResolvedValueOnce(makeCountResult(0));

    const validator = await createConnectedValidator();
    const result = await validator.checkToolAdherence("task-6", [1, 3]);

    expect(result.editCount).toBe(0);
    expect(result.withinRange).toBe(false);
  });

  it("empty card returns fail", async () => {
    executeMock.mockResolvedValueOnce([[]]);

    const validator = await createConnectedValidator();
    const result = await validator.validatePunchCard("task-7", "card-empty");

    expect(result.status).toBe("fail");
    expect(result.missing).toEqual([]);
    expect(result.violations).toEqual([]);
  });
});
