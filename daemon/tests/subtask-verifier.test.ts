import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());
const endMock = vi.hoisted(() => vi.fn());
const createConnectionMock = vi.hoisted(() => vi.fn());

vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: createConnectionMock,
  },
}));

import {
  createConnectedVerifier,
  makeChildIds,
  makeCountResult,
  makeRequirement,
  setupMysqlMocks,
} from "./helpers/punch-card-test-utils.js";

describe("SubtaskVerifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMysqlMocks(executeMock, endMock, createConnectionMock);
  });

  it("all children valid", async () => {
    executeMock
      .mockResolvedValueOnce(makeChildIds("child-1", "child-2"))
      .mockResolvedValueOnce([
        [
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1))
      .mockResolvedValueOnce([
        [
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(2));

    const verifier = await createConnectedVerifier();
    const result = await verifier.verifySubtasks("parent-1", "card-1");

    expect(result.parentTaskId).toBe("parent-1");
    expect(result.children).toHaveLength(2);
    expect(result.allChildrenValid).toBe(true);
  });

  it("one child invalid", async () => {
    executeMock
      .mockResolvedValueOnce(makeChildIds("child-1", "child-2"))
      .mockResolvedValueOnce([
        [
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1))
      .mockResolvedValueOnce([
        [
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(0));

    const verifier = await createConnectedVerifier();
    const result = await verifier.verifySubtasks("parent-2", "card-2");

    expect(result.children).toHaveLength(2);
    expect(result.children[0].validation.status).toBe("pass");
    expect(result.children[1].validation.status).toBe("fail");
    expect(result.allChildrenValid).toBe(false);
  });

  it("no children is vacuously valid", async () => {
    executeMock.mockResolvedValueOnce([[]]);

    const verifier = await createConnectedVerifier();
    const result = await verifier.verifySubtasks("parent-empty", "card-3");

    expect(result.children).toEqual([]);
    expect(result.allChildrenValid).toBe(true);
  });

  it("single child passing", async () => {
    executeMock
      .mockResolvedValueOnce(makeChildIds("child-only"))
      .mockResolvedValueOnce([
        [
          makeRequirement({ punch_key_pattern: "edit_file%" }),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1));

    const verifier = await createConnectedVerifier();
    const result = await verifier.verifySubtasks("parent-3", "card-4");

    expect(result.children).toHaveLength(1);
    expect(result.children[0].childId).toBe("child-only");
    expect(result.children[0].validation.status).toBe("pass");
    expect(result.allChildrenValid).toBe(true);
  });
});
