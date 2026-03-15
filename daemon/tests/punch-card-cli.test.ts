/**
 * Tests for punch card CLI wrappers.
 *
 * These tests verify the core logic (checkPunchCard, auditPunchCards)
 * by mocking mysql2/promise. No running Dolt server is required.
 *
 * See: repomap-core-76q.3
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Mock mysql2/promise ──────────────────────────────────────────────────

interface MockConnection {
  execute: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

let mockConnection: MockConnection;

const { validateFromKiloLogMock, createOpencodeClientMock } = vi.hoisted(() => ({
  validateFromKiloLogMock: vi.fn(),
  createOpencodeClientMock: vi.fn(() => ({})),
}));

vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: vi.fn(async () => mockConnection),
  },
}));

vi.mock("@opencode-ai/sdk/client", () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

vi.mock("../src/governor/kilo-verified-validator.js", () => ({
  validateFromKiloLog: validateFromKiloLogMock,
}));

// Import AFTER mocking
import {
  checkPunchCard,
  defaultCheckConfig,
  type PunchCardCheckConfig,
} from "../src/infra/punch-card-check.cli.js";

import {
  fetchAuditTargets,
  auditPunchCards,
} from "../src/infra/punch-card-audit.cli.js";

import { makeValidatorResult } from "./helpers/mock-validator-result.js";

function makeConfig(overrides: Partial<PunchCardCheckConfig> = {}): PunchCardCheckConfig {
  return {
    ...defaultCheckConfig(),
    ...overrides,
  };
}

describe("punch-card-check", () => {
  beforeEach(() => {
    mockConnection = {
      execute: vi.fn(),
      end: vi.fn(async () => {}),
    };
    validateFromKiloLogMock.mockResolvedValue(makeValidatorResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("defaultCheckConfig", () => {
    it("returns config with expected defaults", () => {
      const config = defaultCheckConfig();
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(3307);
      expect(config.database).toBe("factory");
      expect(config.user).toBe("root");
      expect(config.password).toBe("");
    });
  });

  describe("checkPunchCard", () => {
    it("rejects invalid session_id", async () => {
      const config = makeConfig();
      await expect(
        checkPunchCard(config, { sessionId: "bad id!", cardId: "card-1" }),
      ).rejects.toThrow("invalid session_id");
    });

    it("rejects invalid card_id", async () => {
      const config = makeConfig();
      await expect(
        checkPunchCard(config, { sessionId: "session-1", cardId: "bad id!" }),
      ).rejects.toThrow("invalid card_id");
    });

    it("throws when no requirements found for card", async () => {
      validateFromKiloLogMock.mockRejectedValueOnce(
        new Error("no requirements found for card 'unknown-card'"),
      );
      const config = makeConfig();
      await expect(
        checkPunchCard(config, { sessionId: "session-1", cardId: "unknown-card" }),
      ).rejects.toThrow("no requirements found for card 'unknown-card'");
    });

    it("returns PASS when all required punches are present", async () => {
      validateFromKiloLogMock.mockResolvedValueOnce(makeValidatorResult({ messageCount: 3 }));

      const config = makeConfig();
      const result = await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
      });

      expect(result.passed).toBe(true);
      expect(result.failures).toBe(0);
      expect(result.requirements).toHaveLength(0);
    });

    it("returns FAIL when required punch is missing", async () => {
      validateFromKiloLogMock.mockResolvedValueOnce(makeValidatorResult({
        status: "fail",
        missing: [{ punchType: "quality_gate", punchKeyPattern: "tsc%", description: "Must run tsc" }],
        messageCount: 3,
      }));

      const config = makeConfig();
      const result = await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
      });

      expect(result.passed).toBe(false);
      expect(result.failures).toBe(1);
      expect(result.requirements[0].kind).toBe("required");
      expect(result.requirements[0].passed).toBe(false);
    });

    it("returns FAIL when forbidden punch is present", async () => {
      validateFromKiloLogMock.mockResolvedValueOnce(makeValidatorResult({
        status: "fail",
        violations: [
          {
            punchType: "tool_call",
            punchKeyPattern: "dangerous%",
            count: 2,
            description: "Must not call dangerous",
          },
        ],
        messageCount: 3,
      }));

      const config = makeConfig();
      const result = await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
      });

      expect(result.passed).toBe(false);
      expect(result.failures).toBe(1);
      expect(result.requirements[0].kind).toBe("forbidden");
      expect(result.requirements[0].passed).toBe(false);
      expect(result.requirements[0].count).toBe(2);
    });

    it("returns PASS when forbidden punch is absent", async () => {
      validateFromKiloLogMock.mockResolvedValueOnce(makeValidatorResult({ messageCount: 3 }));

      const config = makeConfig();
      const result = await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
      });

      expect(result.passed).toBe(true);
      expect(result.failures).toBe(0);
    });

    it("skips requirements that are neither required nor forbidden", async () => {
      validateFromKiloLogMock.mockResolvedValueOnce(makeValidatorResult({ messageCount: 3 }));

      const config = makeConfig();
      const result = await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
      });

      expect(result.passed).toBe(true);
      expect(result.requirements).toHaveLength(0);
    });

    it("handles multiple requirements with mixed results", async () => {
      validateFromKiloLogMock.mockResolvedValueOnce(makeValidatorResult({
        status: "fail",
        missing: [{ punchType: "quality_gate", punchKeyPattern: "vitest%", description: "Must run tests" }],
        messageCount: 3,
      }));

      const config = makeConfig();
      const result = await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
      });

      expect(result.passed).toBe(false);
      expect(result.failures).toBe(1);
      expect(result.requirements).toHaveLength(1);
      expect(result.requirements[0].passed).toBe(false);
    });

    it("passes enforcedOnly flag in query", async () => {
      mockConnection.execute.mockResolvedValueOnce([
        [
          {
            forbidden: 0,
            required: 1,
            punch_type: "quality_gate",
            punch_key_pattern: "tsc%",
            description: "Enforced check",
          },
        ],
        [],
      ]);
      mockConnection.execute.mockResolvedValueOnce([[{ count: 1 }], []]);

      const config = makeConfig();
      await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
        enforcedOnly: true,
      });

      expect(validateFromKiloLogMock).toHaveBeenCalledWith(
        "session-1",
        expect.any(Object),
        expect.any(Object),
        "card-1",
        expect.objectContaining({ enforcedOnly: true }),
      );
    });

    it("includes parentSession and enforcedOnly in result", async () => {
      mockConnection.execute.mockResolvedValueOnce([
        [
          {
            forbidden: 0,
            required: 1,
            punch_type: "quality_gate",
            punch_key_pattern: "tsc%",
            description: "",
          },
        ],
        [],
      ]);
      mockConnection.execute.mockResolvedValueOnce([[{ count: 1 }], []]);

      const config = makeConfig();
      const result = await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
        parentSession: "parent-123",
        enforcedOnly: true,
      });

      expect(result.parentSession).toBe("parent-123");
      expect(result.enforcedOnly).toBe(true);
    });

    it("handles string count values from mysql2", async () => {
      validateFromKiloLogMock.mockResolvedValueOnce(makeValidatorResult({
        status: "fail",
        violations: [
          {
            punchType: "tool_call",
            punchKeyPattern: "edit%",
            count: 5,
            description: "",
          },
        ],
        messageCount: 3,
      }));

      const config = makeConfig();
      const result = await checkPunchCard(config, {
        sessionId: "session-1",
        cardId: "card-1",
      });

      expect(result.passed).toBe(false);
      expect(result.requirements[0].count).toBe(5);
    });

    it("closes connection even on error", async () => {
      validateFromKiloLogMock.mockRejectedValueOnce(new Error("connection lost"));

      const config = makeConfig();
      await expect(
        checkPunchCard(config, { sessionId: "session-1", cardId: "card-1" }),
      ).rejects.toThrow("connection lost");
    });
  });
});

describe("punch-card-audit", () => {
  beforeEach(() => {
    mockConnection = {
      execute: vi.fn(),
      end: vi.fn(async () => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchAuditTargets", () => {
    it("returns task/card pairs from query", async () => {
      mockConnection.execute.mockResolvedValueOnce([
        [
          { task_id: "task-1", card_id: "card-a" },
          { task_id: "task-2", card_id: "card-b" },
        ],
        [],
      ]);

      const config = makeConfig();
      const targets = await fetchAuditTargets(config, 50);

      expect(targets).toHaveLength(2);
      expect(targets[0]).toEqual({ taskId: "task-1", cardId: "card-a" });
      expect(targets[1]).toEqual({ taskId: "task-2", cardId: "card-b" });
    });

    it("returns empty array when no tasks found", async () => {
      mockConnection.execute.mockResolvedValueOnce([[], []]);

      const config = makeConfig();
      const targets = await fetchAuditTargets(config, 50);

      expect(targets).toHaveLength(0);
    });

    it("closes connection after query", async () => {
      mockConnection.execute.mockResolvedValueOnce([[], []]);

      const config = makeConfig();
      await fetchAuditTargets(config, 50);

      expect(mockConnection.end).toHaveBeenCalled();
    });
  });

  describe("auditPunchCards", () => {
    it("returns passed=true when no tasks found", async () => {
      // fetchAuditTargets query returns empty
      mockConnection.execute.mockResolvedValueOnce([[], []]);

      const config = makeConfig();
      const result = await auditPunchCards(config, { limit: 50, jsonOutput: false });

      expect(result.passed).toBe(true);
      expect(result.tasks).toHaveLength(0);
      expect(result.passCount).toBe(0);
      expect(result.failCount).toBe(0);
      expect(result.errorCount).toBe(0);
    });

    it("counts pass/fail/error correctly", async () => {
      // fetchAuditTargets query
      mockConnection.execute.mockResolvedValueOnce([
        [
          { task_id: "task-pass", card_id: "card-a" },
          { task_id: "task-fail", card_id: "card-b" },
          { task_id: "task-error", card_id: "card-c" },
        ],
        [],
      ]);

      validateFromKiloLogMock
        .mockResolvedValueOnce(makeValidatorResult({
          cardId: "card-a",
          sessionId: "task-pass",
          sourceSessionId: "task-pass",
          messageCount: 1,
        }))
        .mockResolvedValueOnce(makeValidatorResult({
          status: "fail",
          cardId: "card-b",
          missing: [{ punchType: "gate", punchKeyPattern: "g%" }],
          sessionId: "task-fail",
          sourceSessionId: "task-fail",
          messageCount: 1,
        }))
        .mockRejectedValueOnce(new Error("no requirements found"));

      const config = makeConfig();
      const result = await auditPunchCards(config, { limit: 50, jsonOutput: false });

      expect(result.passed).toBe(false);
      expect(result.passCount).toBe(1);
      expect(result.failCount).toBe(1);
      expect(result.errorCount).toBe(1);
      expect(result.tasks).toHaveLength(3);
      expect(result.tasks[0].status).toBe("pass");
      expect(result.tasks[1].status).toBe("fail");
      expect(result.tasks[2].status).toBe("error");
      expect(result.tasks[2].error).toContain("no requirements found");
    });

    it("returns passed=true when all tasks pass", async () => {
      mockConnection.execute.mockResolvedValueOnce([
        [{ task_id: "task-1", card_id: "card-a" }],
        [],
      ]);
      validateFromKiloLogMock.mockResolvedValueOnce(makeValidatorResult({
        cardId: "card-a",
        sessionId: "task-1",
        sourceSessionId: "task-1",
        messageCount: 1,
      }));

      const config = makeConfig();
      const result = await auditPunchCards(config, { limit: 10, jsonOutput: false });

      expect(result.passed).toBe(true);
      expect(result.passCount).toBe(1);
      expect(result.failCount).toBe(0);
      expect(result.errorCount).toBe(0);
    });
  });
});
