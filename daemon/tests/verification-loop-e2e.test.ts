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
  createConnectedValidator,
  createConnectedVerifier,
  makeChildIds,
  makeCountResult,
  makeRequirement,
  setupMysqlMocks,
} from "./helpers/punch-card-test-utils.js";

describe("verification loop e2e", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMysqlMocks(executeMock, endMock, createConnectionMock);
  });

  it("full pipeline: parent with children, all valid", async () => {
    executeMock
      // parent validator: requirements + count
      .mockResolvedValueOnce([
        [
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(2))
      // subtask verifier: child ids
      .mockResolvedValueOnce(makeChildIds("child-1", "child-2"))
      // child-1 validation
      .mockResolvedValueOnce([
        [
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1))
      // child-2 validation
      .mockResolvedValueOnce([
        [
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1));

    const parentValidator = await createConnectedValidator();
    const parentResult = await parentValidator.validatePunchCard("parent-1", "card-parent");

    const subtaskVerifier = await createConnectedVerifier();
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
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1))
      // subtask verifier: one child
      .mockResolvedValueOnce(makeChildIds("child-fail"))
      // child validation requirements + missing count
      .mockResolvedValueOnce([
        [
          makeRequirement({ punch_key_pattern: "edit_file%" }),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(0));

    const parentValidator = await createConnectedValidator();
    const parentResult = await parentValidator.validatePunchCard("parent-2", "card-parent");

    const subtaskVerifier = await createConnectedVerifier();
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
          makeRequirement(),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1))
      // subtask verifier: one child
      .mockResolvedValueOnce(makeChildIds("child-violates"))
      // child validation requirements + forbidden count > 0
      .mockResolvedValueOnce([
        [
          makeRequirement({ punch_key_pattern: "apply_diff%", forbidden: 1 }),
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(2));

    const parentValidator = await createConnectedValidator();
    const parentResult = await parentValidator.validatePunchCard("parent-3", "card-parent");

    const subtaskVerifier = await createConnectedVerifier();
    const subtaskResult = await subtaskVerifier.verifySubtasks("parent-3", "card-child");

    expect(parentResult.status).toBe("pass");
    expect(subtaskResult.allChildrenValid).toBe(false);
    expect(subtaskResult.children[0].validation.violations).toHaveLength(1);
    expect(subtaskResult.children[0].validation.violations[0].count).toBe(2);
  });
});
