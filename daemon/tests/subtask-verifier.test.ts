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

describe("SubtaskVerifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    endMock.mockResolvedValue(undefined);
    createConnectionMock.mockResolvedValue({
      execute: executeMock,
      end: endMock,
    });
  });

  it("all children valid", async () => {
    executeMock
      .mockResolvedValueOnce([[{ child_id: "child-1" }, { child_id: "child-2" }]])
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
      .mockResolvedValueOnce([[{ count: 2 }]]);

    const verifier = new SubtaskVerifier(new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" }));
    await verifier.connect();
    const result = await verifier.verifySubtasks("parent-1", "card-1");

    expect(result.parentTaskId).toBe("parent-1");
    expect(result.children).toHaveLength(2);
    expect(result.allChildrenValid).toBe(true);
  });

  it("one child invalid", async () => {
    executeMock
      .mockResolvedValueOnce([[{ child_id: "child-1" }, { child_id: "child-2" }]])
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
      .mockResolvedValueOnce([[{ count: 0 }]]);

    const verifier = new SubtaskVerifier(new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" }));
    await verifier.connect();
    const result = await verifier.verifySubtasks("parent-2", "card-2");

    expect(result.children).toHaveLength(2);
    expect(result.children[0].validation.status).toBe("pass");
    expect(result.children[1].validation.status).toBe("fail");
    expect(result.allChildrenValid).toBe(false);
  });

  it("no children is vacuously valid", async () => {
    executeMock.mockResolvedValueOnce([[]]);

    const verifier = new SubtaskVerifier(new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" }));
    await verifier.connect();
    const result = await verifier.verifySubtasks("parent-empty", "card-3");

    expect(result.children).toEqual([]);
    expect(result.allChildrenValid).toBe(true);
  });

  it("single child passing", async () => {
    executeMock
      .mockResolvedValueOnce([[{ child_id: "child-only" }]])
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
      .mockResolvedValueOnce([[{ count: 1 }]]);

    const verifier = new SubtaskVerifier(new PunchCardValidator({ host: "127.0.0.1", port: 3307, database: "plant" }));
    await verifier.connect();
    const result = await verifier.verifySubtasks("parent-3", "card-4");

    expect(result.children).toHaveLength(1);
    expect(result.children[0].childId).toBe("child-only");
    expect(result.children[0].validation.status).toBe("pass");
    expect(result.allChildrenValid).toBe(true);
  });
});
