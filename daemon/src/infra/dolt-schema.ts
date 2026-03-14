/**
 * Dolt Punch Card Schema Management
 *
 * Replaces shell-based schema initialization and migration logic from
 * dolt_punch_init.sh and dolt_apply_punch_card_schema.sh with proper
 * MySQL protocol queries via mysql2.
 *
 * Responsibilities:
 *   - Create the factory database if it doesn't exist
 *   - Create all 8 tables and 1 view via DDL
 *   - Seed punch card definitions
 *   - Apply incremental SQL migration files from .kilocode/schema/
 *   - Idempotent Dolt commit via CALL DOLT_COMMIT
 *
 * See: repomap-core-76q.4
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

// ── Configuration ────────────────────────────────────────────────────────

export interface DoltSchemaConfig {
  /** Server host (default: 127.0.0.1) */
  host: string;
  /** Server port (default: 3307) */
  port: number;
  /** MySQL user (default: root) */
  user: string;
  /** MySQL password (default: empty string) */
  password: string;
  /** Database name for punch cards (default: factory) */
  database: string;
  /** Repository root directory (for locating schema files) */
  repoRoot: string;
}

const HOME = process.env.HOME ?? "/home/user";

export function defaultSchemaConfig(): DoltSchemaConfig {
  // Resolve repo root relative to this file: daemon/src/infra/ -> repo root
  const repoRoot =
    process.env.REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  return {
    host: process.env.DOLT_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.DOLT_PORT ?? "3307", 10),
    user: "root",
    password: "",
    database: process.env.DOLT_DATABASE || "factory",
    repoRoot,
  };
}

// ── Types ────────────────────────────────────────────────────────────────

export interface SchemaInitResult {
  action: "created" | "already_exists" | "failed";
  tables: string[];
  message: string;
}

export interface MigrateResult {
  action: "applied" | "no_changes" | "failed";
  file: string;
  message: string;
}

// ── Connection helpers ───────────────────────────────────────────────────

/**
 * Create a mysql2 connection to the Dolt server WITHOUT selecting a database.
 * Used for CREATE DATABASE and other server-level operations.
 */
export async function createServerConnection(
  config: DoltSchemaConfig,
  timeoutMs = 5000,
): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectTimeout: timeoutMs,
    multipleStatements: true,
  });
}

/**
 * Create a mysql2 connection to the Dolt server WITH a specific database selected.
 */
export async function createDatabaseConnection(
  config: DoltSchemaConfig,
  timeoutMs = 5000,
): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: timeoutMs,
    multipleStatements: true,
  });
}

// ── DDL Statements ───────────────────────────────────────────────────────

/**
 * The 8 table DDL statements and 1 view for the factory database.
 * These match the schema from dolt_punch_init.sh exactly.
 */
const TABLE_DDL: string[] = [
  // 1. tasks
  `CREATE TABLE IF NOT EXISTS tasks (
    task_id        VARCHAR(50)  NOT NULL PRIMARY KEY,
    parent_task_id VARCHAR(50)  DEFAULT NULL,
    mode           VARCHAR(30)  NOT NULL,
    model          VARCHAR(50)  NOT NULL DEFAULT 'unknown',
    status         ENUM('running', 'completed', 'failed', 'abandoned') NOT NULL DEFAULT 'running',
    cost_usd       DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
    started_at     DATETIME     NOT NULL,
    completed_at   DATETIME     DEFAULT NULL,
    punch_card_id  VARCHAR(50)  DEFAULT NULL,
    bead_id        VARCHAR(100) DEFAULT NULL,

    INDEX idx_parent (parent_task_id),
    INDEX idx_status (status)
)`,

  // 2. punches
  `CREATE TABLE IF NOT EXISTS punches (
    punch_id    INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id     VARCHAR(50)  NOT NULL,
    punch_type  ENUM(
        'tool_call',
        'command_exec',
        'mcp_call',
        'gate_pass',
        'gate_fail',
        'child_spawn',
        'child_complete',
        'cost_checkpoint',
        'step_complete'
    ) NOT NULL,
    punch_key   VARCHAR(200) NOT NULL,
    observed_at DATETIME     NOT NULL,
    source_hash CHAR(64)     NOT NULL,

    UNIQUE INDEX idx_source_hash (source_hash),
    INDEX idx_task_type (task_id, punch_type),
    INDEX idx_task (task_id)
)`,

  // 3. punch_cards
  `CREATE TABLE IF NOT EXISTS punch_cards (
    card_id           VARCHAR(50)  NOT NULL,
    workflow_name     VARCHAR(50)  NOT NULL,
    punch_type        ENUM(
        'tool_call',
        'command_exec',
        'mcp_call',
        'gate_pass',
        'gate_fail',
        'child_spawn',
        'child_complete',
        'cost_checkpoint',
        'step_complete'
    ) NOT NULL,
    punch_key_pattern VARCHAR(200) NOT NULL,
    required          BOOLEAN      NOT NULL DEFAULT TRUE,
    forbidden         BOOLEAN      NOT NULL DEFAULT FALSE,
    enforced          BOOLEAN      NOT NULL DEFAULT FALSE,
    description       VARCHAR(200) DEFAULT NULL,

    PRIMARY KEY (card_id, punch_type, punch_key_pattern)
)`,

  // 4. checkpoints
  `CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id    INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    task_id          VARCHAR(50)  NOT NULL,
    card_id          VARCHAR(50)  NOT NULL,
    status           ENUM('pass', 'fail') NOT NULL,
    validated_at     DATETIME     NOT NULL,
    dolt_commit_hash CHAR(40)     DEFAULT NULL,
    missing_punches  TEXT         DEFAULT NULL,

    INDEX idx_task (task_id),
    INDEX idx_card (card_id)
)`,

  // 5. child_relationships
  `CREATE TABLE IF NOT EXISTS child_relationships (
    parent_task_id       VARCHAR(50) NOT NULL,
    child_task_id        VARCHAR(50) NOT NULL,
    spawned_at           DATETIME    NOT NULL,
    completed_at         DATETIME    DEFAULT NULL,
    child_card_valid     BOOLEAN     NOT NULL DEFAULT FALSE,
    child_checkpoint_hash CHAR(40)   DEFAULT NULL,

    PRIMARY KEY (parent_task_id, child_task_id),
    INDEX idx_parent (parent_task_id),
    INDEX idx_child (child_task_id)
)`,

  // 6. sessions
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id   VARCHAR(128) NOT NULL PRIMARY KEY,
    task_id      VARCHAR(50)  DEFAULT NULL,
    mode         VARCHAR(50)  DEFAULT NULL,
    model        VARCHAR(100) DEFAULT NULL,
    status       VARCHAR(30)  DEFAULT 'running',
    total_cost   DECIMAL(10,6) DEFAULT 0,
    tokens_in    INT DEFAULT 0,
    tokens_out   INT DEFAULT 0,
    tokens_reasoning INT DEFAULT 0,
    started_at   DATETIME     DEFAULT NULL,
    completed_at DATETIME     DEFAULT NULL,
    outcome      VARCHAR(200) DEFAULT NULL,
    INDEX idx_task (task_id),
    INDEX idx_status (status)
)`,

  // 7. messages
  `CREATE TABLE IF NOT EXISTS messages (
    message_id     INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id     VARCHAR(128) NOT NULL,
    role           VARCHAR(20)  NOT NULL,
    content_type   VARCHAR(30)  DEFAULT 'text',
    content_preview TEXT         DEFAULT NULL,
    ts             BIGINT       NOT NULL,
    cost           DECIMAL(10,6) DEFAULT NULL,
    tokens_in      INT          DEFAULT NULL,
    tokens_out     INT          DEFAULT NULL,
    UNIQUE INDEX idx_session_ts_role (session_id, ts, role),
    INDEX idx_session (session_id),
    INDEX idx_ts (ts)
)`,

  // 8. tool_calls
  `CREATE TABLE IF NOT EXISTS tool_calls (
    call_id       INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
    session_id    VARCHAR(128) NOT NULL,
    tool_name     VARCHAR(100) NOT NULL,
    args_summary  TEXT         DEFAULT NULL,
    status        VARCHAR(20)  DEFAULT NULL,
    error         TEXT         DEFAULT NULL,
    duration_ms   INT          DEFAULT NULL,
    cost          DECIMAL(10,6) DEFAULT NULL,
    ts            BIGINT       NOT NULL,
    UNIQUE KEY uniq_session_ts_tool (session_id, ts, tool_name),
    INDEX idx_session (session_id),
    INDEX idx_tool (tool_name),
    INDEX idx_ts (ts)
)`,
];

/** The cost_aggregate view DDL. */
const VIEW_DDL = `CREATE OR REPLACE VIEW cost_aggregate AS
WITH RECURSIVE task_tree AS (
    SELECT
        task_id AS root_task_id,
        task_id,
        parent_task_id,
        cost_usd,
        0 AS depth
    FROM tasks

    UNION ALL

    SELECT
        tt.root_task_id,
        t.task_id,
        t.parent_task_id,
        t.cost_usd,
        tt.depth + 1
    FROM tasks t
    JOIN task_tree tt ON t.parent_task_id = tt.task_id
    WHERE tt.depth < 10
)
SELECT
    root_task_id,
    SUM(cost_usd) AS total_cost_usd,
    COUNT(*) AS task_count,
    MAX(depth) AS max_depth
FROM task_tree
GROUP BY root_task_id`;

/** Seed INSERT statements for the 11 original punch card definitions. */
const SEED_STATEMENTS: string[] = [
  // quality-gates
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('quality-gates', 'quality-gates', 'gate_pass', 'ruff-format',   TRUE,  'Ruff format check must pass'),
    ('quality-gates', 'quality-gates', 'gate_pass', 'ruff-check',    TRUE,  'Ruff lint check must pass'),
    ('quality-gates', 'quality-gates', 'gate_pass', 'mypy',          TRUE,  'Mypy type check must pass'),
    ('quality-gates', 'quality-gates', 'gate_pass', 'pytest',        TRUE,  'Pytest test suite must pass'),
    ('quality-gates', 'quality-gates', 'cost_checkpoint', '%',       FALSE, 'Cost tracking (optional)')`,

  // land-plane
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('land-plane', 'land-plane', 'gate_pass',      'ruff-format',      TRUE,  'Ruff format check must pass'),
    ('land-plane', 'land-plane', 'gate_pass',      'ruff-check',       TRUE,  'Ruff lint check must pass'),
    ('land-plane', 'land-plane', 'gate_pass',      'mypy',             TRUE,  'Mypy type check must pass'),
    ('land-plane', 'land-plane', 'gate_pass',      'pytest',           TRUE,  'Pytest test suite must pass'),
    ('land-plane', 'land-plane', 'step_complete',  'task_exit',        TRUE,  'Task must reach completion'),
    ('land-plane', 'land-plane', 'tool_call',      'updateTodoList',   TRUE,  'At least one todo update required'),
    ('land-plane', 'land-plane', 'child_spawn',    '%',                FALSE, 'Child task spawning (optional)'),
    ('land-plane', 'land-plane', 'cost_checkpoint', '%',               FALSE, 'Cost tracking (optional)')`,

  // orchestrate
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('orchestrate', 'orchestrate', 'child_spawn',     '%',          TRUE,  'Must spawn at least one child'),
    ('orchestrate', 'orchestrate', 'step_complete',   'task_exit',  TRUE,  'Orchestrator must reach completion'),
    ('orchestrate', 'orchestrate', 'cost_checkpoint', '%',          FALSE, 'Cost tracking (optional)')`,

  // validate-plant
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('validate-plant', 'validate-plant', 'gate_pass',     'workflow-gate',  TRUE,  'Workflow gate must pass'),
    ('validate-plant', 'validate-plant', 'step_complete', 'task_exit',      TRUE,  'Validation must complete')`,

  // prep-task
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('prep-task', 'prep-task', 'mcp_call',         'process_thought',      TRUE,  'Sequential thinking required'),
    ('prep-task', 'prep-task', 'mcp_call',         'codebase___retrieval', TRUE,  'Codebase exploration required'),
    ('prep-task', 'prep-task', 'mcp_call',         'generate_summary',     TRUE,  'Thinking summary required'),
    ('prep-task', 'prep-task', 'mcp_call',         'export_session',       TRUE,  'Session export required'),
    ('prep-task', 'prep-task', 'cost_checkpoint',  '%',                    FALSE, 'Cost tracking (optional)')`,

  // codebase-exploration
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('codebase-exploration', 'codebase-exploration', 'mcp_call',         'codebase___retrieval', TRUE,  'Augment codebase retrieval required'),
    ('codebase-exploration', 'codebase-exploration', 'tool_call',        'read_file',            TRUE,  'File inspection required'),
    ('codebase-exploration', 'codebase-exploration', 'cost_checkpoint',  '%',                    FALSE, 'Cost tracking (optional)')`,

  // fix-ci
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('fix-ci', 'fix-ci', 'gate_pass', 'ruff-format',   TRUE,  'Ruff format check must pass'),
    ('fix-ci', 'fix-ci', 'gate_pass', 'ruff-check',    TRUE,  'Ruff lint check must pass'),
    ('fix-ci', 'fix-ci', 'gate_pass', 'mypy',          TRUE,  'Mypy type check must pass'),
    ('fix-ci', 'fix-ci', 'gate_pass', 'pytest',        TRUE,  'Pytest test suite must pass'),
    ('fix-ci', 'fix-ci', 'cost_checkpoint', '%',       FALSE, 'Cost tracking (optional)')`,

  // fitter-line-health
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('fitter-line-health', 'fitter-line-health', 'gate_pass',      'workflow-gate',  TRUE,  'At least one gate must be restored'),
    ('fitter-line-health', 'fitter-line-health', 'step_complete',  'task_exit',      TRUE,  'Restoration must complete'),
    ('fitter-line-health', 'fitter-line-health', 'cost_checkpoint', '%',             FALSE, 'Cost tracking (optional)')`,

  // friction-audit
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('friction-audit', 'friction-audit', 'mcp_call',         'process_thought',  TRUE,  'Sequential thinking required for audit'),
    ('friction-audit', 'friction-audit', 'step_complete',    'task_exit',        TRUE,  'Audit must complete'),
    ('friction-audit', 'friction-audit', 'cost_checkpoint',  '%',               FALSE, 'Cost tracking (optional)')`,

  // refactor
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('refactor', 'refactor', 'gate_pass',        'ruff-format',          TRUE,  'Ruff format check must pass'),
    ('refactor', 'refactor', 'gate_pass',        'ruff-check',           TRUE,  'Ruff lint check must pass'),
    ('refactor', 'refactor', 'gate_pass',        'mypy',                 TRUE,  'Mypy type check must pass'),
    ('refactor', 'refactor', 'gate_pass',        'pytest',               TRUE,  'Pytest test suite must pass'),
    ('refactor', 'refactor', 'mcp_call',         'process_thought',      TRUE,  'Sequential thinking required for refactoring'),
    ('refactor', 'refactor', 'mcp_call',         'codebase___retrieval', TRUE,  'Codebase exploration required'),
    ('refactor', 'refactor', 'cost_checkpoint',  '%',                    FALSE, 'Cost tracking (optional)')`,

  // respond-to-pr-review
  `INSERT IGNORE INTO punch_cards (card_id, workflow_name, punch_type, punch_key_pattern, required, description) VALUES
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'ruff-format',  TRUE,  'Ruff format check must pass'),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'ruff-check',   TRUE,  'Ruff lint check must pass'),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'mypy',         TRUE,  'Mypy type check must pass'),
    ('respond-to-pr-review', 'respond-to-pr-review', 'gate_pass',        'pytest',       TRUE,  'Pytest test suite must pass'),
    ('respond-to-pr-review', 'respond-to-pr-review', 'cost_checkpoint',  '%',            FALSE, 'Cost tracking (optional)')`,
];

// ── Core Operations ──────────────────────────────────────────────────────

/**
 * Ensure the factory database exists on the Dolt server.
 */
export async function ensureDatabase(config: DoltSchemaConfig): Promise<void> {
  const conn = await createServerConnection(config);
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\``);
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * Execute a Dolt commit with the given message. Idempotent — ignores
 * "nothing to commit" errors.
 *
 * Returns the commit hash if a commit was made, or null if nothing to commit.
 */
export async function idempotentDoltCommit(
  conn: mysql.Connection,
  message: string,
): Promise<string | null> {
  await conn.query("CALL DOLT_ADD('.')");
  try {
    const [rows] = await conn.query(`CALL DOLT_COMMIT('-m', '${message.replaceAll("'", "''")}')`);
    const result = rows as Array<Record<string, string>>;
    if (result.length > 0) {
      return Object.values(result[0])[0] ?? null;
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("nothing to commit")) {
      return null;
    }
    throw err;
  }
}

/**
 * Initialize the full factory schema: 8 tables, 1 view, 11 seed card definitions.
 * Idempotent — uses CREATE TABLE IF NOT EXISTS and INSERT IGNORE.
 */
export async function initSchema(
  config: DoltSchemaConfig,
  log: (msg: string) => void = console.log,
): Promise<SchemaInitResult> {
  try {
    // Ensure database exists
    await ensureDatabase(config);
    log(`Ensured database '${config.database}' exists`);

    // Connect to the database
    const conn = await createDatabaseConnection(config);
    try {
      // Create all tables
      for (const ddl of TABLE_DDL) {
        await conn.query(ddl);
      }
      log(`Created/verified 8 tables`);

      // Create view
      await conn.query(VIEW_DDL);
      log(`Created/verified cost_aggregate view`);

      // Seed punch card definitions
      for (const seed of SEED_STATEMENTS) {
        await conn.query(seed);
      }
      log(`Seeded 11 punch card definitions`);

      // Dolt commit
      const commitHash = await idempotentDoltCommit(conn, "Initialize punch card schema");
      if (commitHash) {
        log(`Committed schema changes: ${commitHash}`);
      } else {
        log(`No new schema changes to commit`);
      }

      // Show tables for verification
      const [rows] = await conn.query("SHOW TABLES");
      const tables = (rows as Array<Record<string, string>>).map(
        (row) => Object.values(row)[0],
      );
      log(`Tables in ${config.database}: ${tables.join(", ")}`);

      return {
        action: "created",
        tables,
        message: `Schema initialized with ${tables.length} tables/views`,
      };
    } finally {
      await conn.end().catch(() => {});
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: "failed",
      tables: [],
      message: `Schema initialization failed: ${msg}`,
    };
  }
}

/**
 * Apply a SQL migration file from .kilocode/schema/ to the factory database.
 * The file is executed as a multi-statement SQL batch via mysql2.
 *
 * @param config - Schema configuration
 * @param migrationFile - Absolute or relative path to the .sql file
 *   (relative paths resolved from config.repoRoot)
 * @param commitMessage - Dolt commit message
 */
export async function applyMigration(
  config: DoltSchemaConfig,
  migrationFile: string,
  commitMessage: string = "Apply punch card schema migration",
  log: (msg: string) => void = console.log,
): Promise<MigrateResult> {
  // Resolve the migration file path
  const filePath = migrationFile.startsWith("/")
    ? migrationFile
    : join(config.repoRoot, migrationFile);

  try {
    const sql = readFileSync(filePath, "utf8");
    log(`Read migration file: ${filePath} (${sql.length} bytes)`);

    // Ensure database exists
    await ensureDatabase(config);

    // Connect to the database and apply migration.
    const conn = await createDatabaseConnection(config);
    try {
      await conn.query(sql);
      log("Applied migration SQL");

      // Dolt commit
      const commitHash = await idempotentDoltCommit(conn, commitMessage);
      if (commitHash) {
        log(`Committed migration: ${commitHash}`);
        return {
          action: "applied",
          file: filePath,
          message: `Migration applied and committed: ${commitHash}`,
        };
      } else {
        log(`No new changes to commit`);
        return {
          action: "no_changes",
          file: filePath,
          message: "Migration applied but no new changes to commit",
        };
      }
    } finally {
      await conn.end().catch(() => {});
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: "failed",
      file: migrationFile,
      message: `Migration failed: ${msg}`,
    };
  }
}

// ── Exported constants for testing ───────────────────────────────────────

export const _internals = {
  TABLE_DDL,
  VIEW_DDL,
  SEED_STATEMENTS,
};
