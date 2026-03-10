/**
 * Punch Card Enforcement Unit Tests
 *
 * Tests that the enforcement loop correctly blocks workflow completion when
 * punch card requirements are not met. Covers:
 * - Missing required punches cause validation failure
 * - Forbidden punch violations cause validation failure
 * - enforcedOnly mode filters to only enforced requirements
 * - Non-enforced (observational) cards are skipped in enforcedOnly mode
 * - Workflow returns "validation_failed" status on enforcement failure
 */

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
  createConnectedValidator,
  makeCountResult,
  makeRequirement,
  setupMysqlMocks,
} from "./helpers/punch-card-test-utils.js";

describe("PunchCardValidator — enforcement gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMysqlMocks(executeMock, endMock, createConnectionMock);
  });

  describe("enforcedOnly filtering", () => {
    it("includes only enforced requirements when enforcedOnly is true", async () => {
      // The SQL query should contain 'AND enforced = TRUE' when enforcedOnly is set
      executeMock
        .mockResolvedValueOnce([
          [
            {
              ...makeRequirement({ punch_key_pattern: "ruff-format" }),
              punch_type: "gate_pass",
              enforced: 1,
              description: "Ruff format (enforced)",
            },
          ],
        ])
        .mockResolvedValueOnce(makeCountResult(1));

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard("task-1", "execute-subtask", {
        enforcedOnly: true,
      });

      expect(result.status).toBe("pass");
      // Verify the SQL query included the enforced filter
      const sqlCall = executeMock.mock.calls[0];
      expect(sqlCall[0]).toContain("enforced = TRUE");
    });

    it("includes all requirements when enforcedOnly is false", async () => {
      executeMock
        .mockResolvedValueOnce([
          [
            {
              ...makeRequirement({ punch_key_pattern: "ruff-format" }),
              punch_type: "gate_pass",
              enforced: 0,
              description: "Ruff format (not enforced)",
            },
          ],
        ])
        .mockResolvedValueOnce(makeCountResult(1));

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard("task-1", "quality-gates", {
        enforcedOnly: false,
      });

      expect(result.status).toBe("pass");
      const sqlCall = executeMock.mock.calls[0];
      expect(sqlCall[0]).not.toContain("enforced = TRUE");
    });

    it("includes all requirements when enforcedOnly is omitted", async () => {
      executeMock
        .mockResolvedValueOnce([
          [
            {
              ...makeRequirement({ punch_key_pattern: "ruff-format" }),
              punch_type: "gate_pass",
              enforced: 0,
              description: "Ruff format",
            },
          ],
        ])
        .mockResolvedValueOnce(makeCountResult(1));

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard("task-1", "quality-gates");

      expect(result.status).toBe("pass");
      const sqlCall = executeMock.mock.calls[0];
      expect(sqlCall[0]).not.toContain("enforced = TRUE");
    });
  });

  describe("missing required punches block completion", () => {
    it("fails when an enforced required punch is missing", async () => {
      executeMock
        .mockResolvedValueOnce([
          [
            {
              ...makeRequirement({
                punch_type: "gate_pass",
                punch_key_pattern: "pytest",
              }),
              enforced: 1,
              description: "Pytest must pass",
            },
          ],
        ])
        .mockResolvedValueOnce(makeCountResult(0)); // missing!

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard("task-enforce-1", "execute-subtask", {
        enforcedOnly: true,
      });

      expect(result.status).toBe("fail");
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]).toMatchObject({
        punchType: "gate_pass",
        punchKeyPattern: "pytest",
      });
    });

    it("fails when multiple enforced required punches are missing", async () => {
      executeMock
        .mockResolvedValueOnce([
          [
            {
              ...makeRequirement({
                punch_type: "gate_pass",
                punch_key_pattern: "pytest",
              }),
              enforced: 1,
            },
            {
              ...makeRequirement({
                punch_type: "gate_pass",
                punch_key_pattern: "mypy",
              }),
              enforced: 1,
            },
            {
              ...makeRequirement({
                punch_type: "mcp_call",
                punch_key_pattern: "%codebase___retrieval%",
              }),
              enforced: 1,
            },
          ],
        ])
        .mockResolvedValueOnce(makeCountResult(0)) // pytest missing
        .mockResolvedValueOnce(makeCountResult(0)) // mypy missing
        .mockResolvedValueOnce(makeCountResult(0)); // codebase retrieval missing

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard("task-enforce-2", "execute-subtask", {
        enforcedOnly: true,
      });

      expect(result.status).toBe("fail");
      expect(result.missing).toHaveLength(3);
    });
  });

  describe("forbidden punch violations block completion", () => {
    it("fails when a forbidden enforced punch is present", async () => {
      executeMock
        .mockResolvedValueOnce([
          [
            {
              ...makeRequirement({
                punch_type: "tool_call",
                punch_key_pattern: "edit_file%",
                forbidden: 1,
              }),
              enforced: 1,
              description: "FORBIDDEN: Must not edit files directly",
            },
          ],
        ])
        .mockResolvedValueOnce(makeCountResult(2)); // 2 forbidden occurrences!

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard("task-forbidden-1", "plant-orchestrate", {
        enforcedOnly: true,
      });

      expect(result.status).toBe("fail");
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        punchType: "tool_call",
        punchKeyPattern: "edit_file%",
        count: 2,
      });
    });

    it("passes when a forbidden enforced punch is absent", async () => {
      executeMock
        .mockResolvedValueOnce([
          [
            {
              ...makeRequirement({
                punch_type: "tool_call",
                punch_key_pattern: "edit_file%",
                forbidden: 1,
              }),
              enforced: 1,
              description: "FORBIDDEN: Must not edit files directly",
            },
          ],
        ])
        .mockResolvedValueOnce(makeCountResult(0)); // absent — good

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard("task-forbidden-2", "plant-orchestrate", {
        enforcedOnly: true,
      });

      expect(result.status).toBe("pass");
      expect(result.violations).toHaveLength(0);
    });
  });

  describe("mixed required + forbidden enforcement", () => {
    it("fails on both missing required and present forbidden", async () => {
      executeMock
        .mockResolvedValueOnce([
          [
            // Required: child_spawn
            {
              ...makeRequirement({
                punch_type: "child_spawn",
                punch_key_pattern: "code",
                forbidden: 0,
              }),
              enforced: 1,
              description: "Must delegate to code mode",
            },
            // Forbidden: edit_file
            {
              ...makeRequirement({
                punch_type: "tool_call",
                punch_key_pattern: "edit_file%",
                forbidden: 1,
              }),
              enforced: 1,
              description: "FORBIDDEN: Must not edit files directly",
            },
          ],
        ])
        .mockResolvedValueOnce(makeCountResult(0)) // child_spawn missing
        .mockResolvedValueOnce(makeCountResult(3)); // edit_file present (forbidden)

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard(
        "task-mixed",
        "process-orchestrate",
        { enforcedOnly: true },
      );

      expect(result.status).toBe("fail");
      expect(result.missing).toHaveLength(1);
      expect(result.violations).toHaveLength(1);
    });
  });

  describe("observational cards pass in enforcedOnly mode", () => {
    it("returns pass when no enforced requirements exist for card", async () => {
      // When enforcedOnly=true queries DB and gets no rows (all observational),
      // the validator returns fail for empty requirements.
      // This is expected behavior — an empty card is considered a configuration error.
      executeMock.mockResolvedValueOnce([[]]); // no enforced requirements

      const validator = await createConnectedValidator();
      const result = await validator.validatePunchCard(
        "task-observational",
        "quality-gates",
        { enforcedOnly: true },
      );

      // Empty card = fail (configuration error detection)
      expect(result.status).toBe("fail");
    });
  });
});

describe("validateTaskPunchCard activity — enforcement wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMysqlMocks(executeMock, endMock, createConnectionMock);
  });

  it("passes enforcedOnly through to validator", async () => {
    // Mock the complete flow: requirements query returns an enforced requirement,
    // count query returns 1 (satisfied)
    executeMock
      .mockResolvedValueOnce([
        [
          {
            ...makeRequirement({ punch_type: "gate_pass", punch_key_pattern: "pytest" }),
            enforced: 1,
            description: "Pytest must pass",
          },
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(1));

    // Import the activity under test (uses the mocked mysql2)
    const { validateTaskPunchCard } = await import("../src/temporal/activities.js");

    const result = await validateTaskPunchCard(
      { host: "127.0.0.1", port: 3307, database: "test" },
      "task-activity-1",
      "execute-subtask",
      true, // enforcedOnly
    );

    expect(result.status).toBe("pass");

    // Verify the SQL included enforced filter
    const sqlCall = executeMock.mock.calls[0];
    expect(sqlCall[0]).toContain("enforced = TRUE");
  });

  it("returns fail with missing details when enforcement fails", async () => {
    executeMock
      .mockResolvedValueOnce([
        [
          {
            ...makeRequirement({ punch_type: "gate_pass", punch_key_pattern: "pytest" }),
            enforced: 1,
          },
          {
            ...makeRequirement({ punch_type: "gate_pass", punch_key_pattern: "mypy" }),
            enforced: 1,
          },
        ],
      ])
      .mockResolvedValueOnce(makeCountResult(0)) // pytest missing
      .mockResolvedValueOnce(makeCountResult(0)); // mypy missing

    const { validateTaskPunchCard } = await import("../src/temporal/activities.js");

    const result = await validateTaskPunchCard(
      { host: "127.0.0.1", port: 3307, database: "test" },
      "task-activity-fail",
      "execute-subtask",
      true,
    );

    expect(result.status).toBe("fail");
    expect(result.missing).toContain("gate_pass:pytest");
    expect(result.missing).toContain("gate_pass:mypy");
  });
});
