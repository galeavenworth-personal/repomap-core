/**
 * Tests for Dolt punch card schema management.
 *
 * These tests verify the core logic by mocking mysql2 connections.
 * Integration tests that require a running Dolt server are marked with .skip.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Connection } from "mysql2/promise";

// Mock mysql2/promise before importing the module under test
vi.mock("mysql2/promise", () => {
  const mockConnection = {
    query: vi.fn().mockResolvedValue([[]]),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return {
    default: {
      createConnection: vi.fn().mockResolvedValue(mockConnection),
    },
  };
});

import mysql from "mysql2/promise";
import {
  type DoltSchemaConfig,
  defaultSchemaConfig,
  ensureDatabase,
  idempotentDoltCommit,
  initSchema,
  applyMigration,
  _internals,
} from "../src/infra/dolt-schema.js";

function makeTestConfig(
  overrides: Partial<DoltSchemaConfig> = {},
): DoltSchemaConfig {
  return {
    ...defaultSchemaConfig(),
    ...overrides,
  };
}

/** Get the mock connection returned by createConnection. */
async function getMockConnection(): Promise<Connection> {
  const conn = await mysql.createConnection({} as never);
  return conn;
}

describe("DoltSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("defaultSchemaConfig", () => {
    it("returns a config with required fields", () => {
      const config = defaultSchemaConfig();
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(3307);
      expect(config.user).toBe("root");
      expect(config.password).toBe("");
      expect(config.database).toBe("punch_cards");
      expect(typeof config.repoRoot).toBe("string");
      expect(config.repoRoot.length).toBeGreaterThan(0);
    });
  });

  describe("_internals", () => {
    it("has 8 table DDL statements", () => {
      expect(_internals.TABLE_DDL).toHaveLength(8);
    });

    it("has a VIEW_DDL string containing cost_aggregate", () => {
      expect(_internals.VIEW_DDL).toContain("cost_aggregate");
      expect(_internals.VIEW_DDL).toContain("task_tree");
    });

    it("has 11 seed INSERT statements", () => {
      expect(_internals.SEED_STATEMENTS).toHaveLength(11);
    });

    it("seed statements cover all 11 punch card definitions", () => {
      const seeds = _internals.SEED_STATEMENTS.join("\n");
      const expectedCards = [
        "quality-gates",
        "land-plane",
        "orchestrate",
        "validate-plant",
        "prep-task",
        "codebase-exploration",
        "fix-ci",
        "fitter-line-health",
        "friction-audit",
        "refactor",
        "respond-to-pr-review",
      ];
      for (const card of expectedCards) {
        expect(seeds).toContain(card);
      }
    });

    it("table DDL covers all 8 tables", () => {
      const ddl = _internals.TABLE_DDL.join("\n");
      const expectedTables = [
        "tasks",
        "punches",
        "punch_cards",
        "checkpoints",
        "child_relationships",
        "sessions",
        "messages",
        "tool_calls",
      ];
      for (const table of expectedTables) {
        expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      }
    });
  });

  describe("ensureDatabase", () => {
    it("executes CREATE DATABASE IF NOT EXISTS", async () => {
      const config = makeTestConfig();
      const conn = await getMockConnection();

      await ensureDatabase(config);

      expect(mysql.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          host: config.host,
          port: config.port,
          multipleStatements: true,
        }),
      );
      expect(conn.query).toHaveBeenCalledWith(
        "CREATE DATABASE IF NOT EXISTS `punch_cards`",
      );
      expect(conn.end).toHaveBeenCalled();
    });
  });

  describe("idempotentDoltCommit", () => {
    it("calls DOLT_ADD and DOLT_COMMIT", async () => {
      const conn = await getMockConnection();
      const mockQuery = vi.mocked(conn.query);
      mockQuery.mockResolvedValueOnce([[]]);  // DOLT_ADD
      mockQuery.mockResolvedValueOnce([[{ hash: "abc123" }]]);  // DOLT_COMMIT

      const result = await idempotentDoltCommit(conn, "test commit");

      expect(mockQuery).toHaveBeenCalledWith("CALL DOLT_ADD('.')");
      expect(mockQuery).toHaveBeenCalledWith(
        "CALL DOLT_COMMIT('-m', 'test commit')",
      );
      expect(result).toBe("abc123");
    });

    it("returns null when nothing to commit", async () => {
      const conn = await getMockConnection();
      const mockQuery = vi.mocked(conn.query);
      mockQuery.mockResolvedValueOnce([[]]);  // DOLT_ADD
      mockQuery.mockRejectedValueOnce(new Error("nothing to commit"));  // DOLT_COMMIT

      const result = await idempotentDoltCommit(conn, "test commit");

      expect(result).toBeNull();
    });

    it("rethrows non-nothing-to-commit errors", async () => {
      const conn = await getMockConnection();
      const mockQuery = vi.mocked(conn.query);
      mockQuery.mockResolvedValueOnce([[]]);  // DOLT_ADD
      mockQuery.mockRejectedValueOnce(new Error("connection refused"));

      await expect(
        idempotentDoltCommit(conn, "test commit"),
      ).rejects.toThrow("connection refused");
    });

    it("escapes single quotes in commit messages", async () => {
      const conn = await getMockConnection();
      const mockQuery = vi.mocked(conn.query);
      mockQuery.mockResolvedValueOnce([[]]);  // DOLT_ADD
      mockQuery.mockResolvedValueOnce([[{ hash: "def456" }]]);  // DOLT_COMMIT

      await idempotentDoltCommit(conn, "it's a test");

      expect(mockQuery).toHaveBeenCalledWith(
        "CALL DOLT_COMMIT('-m', 'it''s a test')",
      );
    });
  });

  describe("initSchema", () => {
    it("creates database, tables, view, seeds, and commits", async () => {
      const config = makeTestConfig();
      const conn = await getMockConnection();
      const mockQuery = vi.mocked(conn.query);

      // Setup mock responses for the sequence:
      // 1. CREATE DATABASE (server connection)
      // 2. conn.end (server connection)
      // 3. 8 table DDLs
      // 4. 1 view DDL
      // 5. 11 seed INSERTs
      // 6. DOLT_ADD
      // 7. DOLT_COMMIT (nothing to commit)
      // 8. SHOW TABLES
      const showTablesResult = [
        [
          { "Tables_in_punch_cards": "tasks" },
          { "Tables_in_punch_cards": "punches" },
          { "Tables_in_punch_cards": "punch_cards" },
          { "Tables_in_punch_cards": "checkpoints" },
          { "Tables_in_punch_cards": "child_relationships" },
          { "Tables_in_punch_cards": "sessions" },
          { "Tables_in_punch_cards": "messages" },
          { "Tables_in_punch_cards": "tool_calls" },
          { "Tables_in_punch_cards": "cost_aggregate" },
        ],
      ];

      // Reset mock to set up the full sequence
      mockQuery.mockReset();
      // CREATE DATABASE
      mockQuery.mockResolvedValueOnce([[]]);
      // 8 table DDLs
      for (let i = 0; i < 8; i++) {
        mockQuery.mockResolvedValueOnce([[]]);
      }
      // view DDL
      mockQuery.mockResolvedValueOnce([[]]);
      // 11 seed INSERTs
      for (let i = 0; i < 11; i++) {
        mockQuery.mockResolvedValueOnce([[]]);
      }
      // DOLT_ADD
      mockQuery.mockResolvedValueOnce([[]]);
      // DOLT_COMMIT — nothing to commit
      mockQuery.mockRejectedValueOnce(new Error("nothing to commit"));
      // SHOW TABLES
      mockQuery.mockResolvedValueOnce(showTablesResult);

      const log = vi.fn();
      const result = await initSchema(config, log);

      expect(result.action).toBe("created");
      expect(result.tables).toHaveLength(9); // 8 tables + 1 view
      expect(result.tables).toContain("tasks");
      expect(result.tables).toContain("cost_aggregate");
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Ensured database"),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Created/verified 8 tables"),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Seeded 11 punch card definitions"),
      );
    });

    it("returns failed on connection error", async () => {
      const config = makeTestConfig({ port: 19999 });
      const mockCreateConnection = vi.mocked(mysql.createConnection);
      mockCreateConnection.mockRejectedValueOnce(new Error("connection refused"));

      const log = vi.fn();
      const result = await initSchema(config, log);

      expect(result.action).toBe("failed");
      expect(result.message).toContain("connection refused");
    });
  });

  describe("applyMigration", () => {
    it("returns failed when migration file does not exist", async () => {
      const config = makeTestConfig();
      const log = vi.fn();

      const result = await applyMigration(
        config,
        "/nonexistent/migration.sql",
        "test migration",
        log,
      );

      expect(result.action).toBe("failed");
      expect(result.message).toContain("no such file");
    });

    it("reads and applies SQL file via mysql2", async () => {
      const config = makeTestConfig();
      const conn = await getMockConnection();
      const mockQuery = vi.mocked(conn.query);

      // Reset for full sequence
      mockQuery.mockReset();
      // CREATE DATABASE
      mockQuery.mockResolvedValueOnce([[]]);
      // SQL migration content
      mockQuery.mockResolvedValueOnce([[]]);
      // DOLT_ADD
      mockQuery.mockResolvedValueOnce([[]]);
      // DOLT_COMMIT
      mockQuery.mockResolvedValueOnce([[{ hash: "mig123" }]]);

      const log = vi.fn();
      const result = await applyMigration(
        config,
        ".kilocode/schema/punch-card-schema-migration.sql",
        "Apply migration",
        log,
      );

      expect(result.action).toBe("applied");
      expect(result.message).toContain("mig123");
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Read migration file"),
      );
    });

    it("returns no_changes when nothing to commit", async () => {
      const config = makeTestConfig();
      const conn = await getMockConnection();
      const mockQuery = vi.mocked(conn.query);

      // Reset for full sequence
      mockQuery.mockReset();
      // CREATE DATABASE
      mockQuery.mockResolvedValueOnce([[]]);
      // SQL migration content
      mockQuery.mockResolvedValueOnce([[]]);
      // DOLT_ADD
      mockQuery.mockResolvedValueOnce([[]]);
      // DOLT_COMMIT — nothing to commit
      mockQuery.mockRejectedValueOnce(new Error("nothing to commit"));

      const log = vi.fn();
      const result = await applyMigration(
        config,
        ".kilocode/schema/punch-card-schema-migration.sql",
        "Apply migration",
        log,
      );

      expect(result.action).toBe("no_changes");
    });
  });

  // Live integration tests — require running Dolt server
  describe("integration (live server)", () => {
    it.skipIf(!process.env.DOLT_LIVE)(
      "initializes schema on a live server",
      async () => {
        vi.restoreAllMocks(); // Use real mysql2
        const config = defaultSchemaConfig();
        const result = await initSchema(config);
        expect(result.action).not.toBe("failed");
        expect(result.tables.length).toBeGreaterThan(0);
      },
    );

    it.skipIf(!process.env.DOLT_LIVE)(
      "applies migration on a live server",
      async () => {
        vi.restoreAllMocks();
        const config = defaultSchemaConfig();
        const result = await applyMigration(
          config,
          ".kilocode/schema/punch-card-schema-migration.sql",
        );
        expect(result.action).not.toBe("failed");
      },
    );
  });
});
