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
import { SubtaskVerifier } from "../src/governor/subtask-verifier.js";

describe("verification loop e2e", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endMock.mockResolvedValue(undefined);
    createConnectionMock.mockResolvedValue({
      execute: executeMock,
      end: endMock,
    });
  });

  it("full pipeline: parent with children, all valid", async () => {
    executeMock
      // parent validator: requirements + count
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "read_file%",
            required: 1,
            forbidden: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 2 }]])
      // subtask verifier: child ids
      .mockResolvedValueOnce([[{ child_id: "child-1" }, { child_id: "child-2" }]])
      // child-1 validation
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "read_file%",
            required: 1,
            forbidden: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 1 }]])
      // child-2 validation
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "read_file%",
            required: 1,
            forbidden: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 1 }]]);

    const cfg = { host: "127.0.0.1", port: 3307, database: "plant" };
    const parentValidator = new PunchCardValidator(cfg);
    await parentValidator.connect();
    const parentResult = await parentValidator.validatePunchCard("parent-1", "card-parent");

    const subtaskVerifier = new SubtaskVerifier(new PunchCardValidator(cfg));
    await subtaskVerifier.connect();
    const subtaskResult = await subtaskVerifier.verifySubtasks("parent-1", "card-child");

    expect(parentResult.status).toBe("pass");
    expect(subtaskResult.allChildrenValid).toBe(true);
    expect(subtaskResult.children).toHaveLength(2);
  });

  it("validation blocks parent completion when child fails", async () => {
    executeMock
      // parent validator: requirements + count
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "read_file%",
            required: 1,
            forbidden: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 1 }]])
      // subtask verifier: one child
      .mockResolvedValueOnce([[{ child_id: "child-fail" }]])
      // child validation requirements + missing count
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "edit_file%",
            required: 1,
            forbidden: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 0 }]]);

    const cfg = { host: "127.0.0.1", port: 3307, database: "plant" };
    const parentValidator = new PunchCardValidator(cfg);
    await parentValidator.connect();
    const parentResult = await parentValidator.validatePunchCard("parent-2", "card-parent");

    const subtaskVerifier = new SubtaskVerifier(new PunchCardValidator(cfg));
    await subtaskVerifier.connect();
    const subtaskResult = await subtaskVerifier.verifySubtasks("parent-2", "card-child");

    expect(parentResult.status).toBe("pass");
    expect(subtaskResult.allChildrenValid).toBe(false);
    expect(subtaskResult.children[0].validation.status).toBe("fail");
  });

  it("forbidden punch violation detected in pipeline", async () => {
    executeMock
      // parent validator: requirements + count
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "read_file%",
            required: 1,
            forbidden: 0,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 1 }]])
      // subtask verifier: one child
      .mockResolvedValueOnce([[{ child_id: "child-violates" }]])
      // child validation requirements + forbidden count > 0
      .mockResolvedValueOnce([
        [
          {
            punch_type: "tool_call",
            punch_key_pattern: "apply_diff%",
            required: 1,
            forbidden: 1,
          },
        ],
      ])
      .mockResolvedValueOnce([[{ count: 2 }]]);

    const cfg = { host: "127.0.0.1", port: 3307, database: "plant" };
    const parentValidator = new PunchCardValidator(cfg);
    await parentValidator.connect();
    const parentResult = await parentValidator.validatePunchCard("parent-3", "card-parent");

    const subtaskVerifier = new SubtaskVerifier(new PunchCardValidator(cfg));
    await subtaskVerifier.connect();
    const subtaskResult = await subtaskVerifier.verifySubtasks("parent-3", "card-child");

    expect(parentResult.status).toBe("pass");
    expect(subtaskResult.allChildrenValid).toBe(false);
    expect(subtaskResult.children[0].validation.violations).toHaveLength(1);
    expect(subtaskResult.children[0].validation.violations[0].count).toBe(2);
  });
});
