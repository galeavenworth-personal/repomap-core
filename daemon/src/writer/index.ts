/**
 * Dolt Writer
 *
 * Writes classified punches to the Dolt database via MySQL wire protocol.
 * Uses mysql2 for connection management and prepared statements.
 *
 * Target table: punches
 *   Columns: punch_id (auto), task_id, punch_type, punch_key, observed_at, source_hash
 *
 * The writer only INSERTs into the punches table. Punch card evaluation
 * and task lifecycle management happen in the agent-side Python tools
 * (repomap-core).
 */

import mysql from "mysql2/promise";

export interface DoltConfig {
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
}

export interface DoltWriter {
  connect(): Promise<void>;
  writePunch(punch: {
    taskId: string;
    punchType: string;
    punchKey: string;
    observedAt: Date;
    sourceHash: string;
    cost?: number;
    tokensInput?: number;
    tokensOutput?: number;
    tokensReasoning?: number;
  }): Promise<void>;
  writeSession(session: {
    sessionId: string;
    taskId?: string;
    mode?: string;
    model?: string;
    status?: string;
    totalCost?: number;
    tokensIn?: number;
    tokensOut?: number;
    tokensReasoning?: number;
    startedAt?: Date;
    completedAt?: Date;
    outcome?: string;
  }): Promise<void>;
  writeMessage(message: {
    sessionId: string;
    role: string;
    contentType?: string;
    contentPreview?: string;
    ts: number;
    cost?: number;
    tokensIn?: number;
    tokensOut?: number;
  }): Promise<void>;
  writeToolCall(toolCall: {
    sessionId: string;
    toolName: string;
    argsSummary?: string;
    status?: string;
    error?: string;
    durationMs?: number;
    cost?: number;
    ts: number;
  }): Promise<void>;
  writeChildRelation(parentId: string, childId: string): Promise<void>;
  syncChildRelsFromPunches(): Promise<number>;
  disconnect(): Promise<void>;
}

export function createDoltWriter(config: DoltConfig): DoltWriter {
  let connection: mysql.Connection | null = null;

  return {
    async connect() {
      connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user ?? "root",
        password: config.password,
      });

      // Ensure child_rels table exists
      try {
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS child_rels (
            parent_id VARCHAR(128) NOT NULL,
            child_id VARCHAR(128) NOT NULL,
            PRIMARY KEY (parent_id, child_id),
            INDEX idx_child (child_id)
          )
        `);
      } catch (error: unknown) {
        const err = error as { message: string };
        console.warn("[dolt-writer] Warning: Could not create child_rels table:", err.message);
      }

      // Ensure telemetry tables exist
      try {
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS sessions (
            session_id VARCHAR(128) NOT NULL PRIMARY KEY,
            task_id VARCHAR(50) DEFAULT NULL,
            mode VARCHAR(50) DEFAULT NULL,
            model VARCHAR(100) DEFAULT NULL,
            status VARCHAR(30) DEFAULT 'running',
            total_cost DECIMAL(10,6) DEFAULT 0,
            tokens_in INT DEFAULT 0,
            tokens_out INT DEFAULT 0,
            tokens_reasoning INT DEFAULT 0,
            started_at DATETIME DEFAULT NULL,
            completed_at DATETIME DEFAULT NULL,
            outcome VARCHAR(200) DEFAULT NULL,
            INDEX idx_task (task_id),
            INDEX idx_status (status)
          )
        `);
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS messages (
            message_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            session_id VARCHAR(128) NOT NULL,
            role VARCHAR(20) NOT NULL,
            content_type VARCHAR(30) DEFAULT 'text',
            content_preview TEXT DEFAULT NULL,
            ts BIGINT NOT NULL,
            cost DECIMAL(10,6) DEFAULT NULL,
            tokens_in INT DEFAULT NULL,
            tokens_out INT DEFAULT NULL,
            INDEX idx_session (session_id),
            INDEX idx_ts (ts)
          )
        `);
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS tool_calls (
            call_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            session_id VARCHAR(128) NOT NULL,
            tool_name VARCHAR(100) NOT NULL,
            args_summary TEXT DEFAULT NULL,
            status VARCHAR(20) DEFAULT NULL,
            error TEXT DEFAULT NULL,
            duration_ms INT DEFAULT NULL,
            cost DECIMAL(10,6) DEFAULT NULL,
            ts BIGINT NOT NULL,
            INDEX idx_session (session_id),
            INDEX idx_tool (tool_name),
            INDEX idx_ts (ts)
          )
        `);
      } catch (error: unknown) {
        const err = error as { message: string };
        console.warn("[dolt-writer] Warning: Could not create telemetry tables:", err.message);
      }

      // Ensure UNIQUE constraint on source_hash exists
      try {
        await connection.execute(
          "ALTER TABLE punches ADD UNIQUE INDEX idx_source_hash (source_hash)"
        );
        console.log("[dolt-writer] Added unique index on source_hash");
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string };
        // Ignore "Duplicate key name" error (code 1061)
        if (
          err.code !== "ER_DUP_KEYNAME" &&
          !err.message?.includes("Duplicate key name")
        ) {
          // It might also fail if duplicates exist (ER_DUP_ENTRY). We ignore that too for now, relying on WHERE NOT EXISTS.
        }
      }

      // Ensure cost/token columns exist
      const newColumns = [
        "cost DECIMAL(10,6) NULL",
        "tokens_input INT NULL",
        "tokens_output INT NULL",
        "tokens_reasoning INT NULL",
      ];

      for (const colDef of newColumns) {
        try {
          await connection.execute(`ALTER TABLE punches ADD COLUMN ${colDef}`);
        } catch (error: unknown) {
          const err = error as { code?: string; message?: string };
          // Ignore "Duplicate column name" (code 1060)
          if (
            err.code !== "ER_DUP_FIELDNAME" &&
            !err.message?.includes("Duplicate column name")
          ) {
            console.warn(
              `[dolt-writer] Warning: Could not add column ${colDef.split(" ")[0]}:`,
              err.message
            );
          }
        }
      }
    },

    async writePunch(punch) {
      if (!connection) throw new Error("Not connected to Dolt");
      await connection.execute(
        `INSERT INTO punches (task_id, punch_type, punch_key, observed_at, source_hash, cost, tokens_input, tokens_output, tokens_reasoning)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM punches WHERE source_hash = ?)`,
        [
          punch.taskId,
          punch.punchType,
          punch.punchKey,
          punch.observedAt,
          punch.sourceHash,
          punch.cost ?? null,
          punch.tokensInput ?? null,
          punch.tokensOutput ?? null,
          punch.tokensReasoning ?? null,
          punch.sourceHash,
        ]
      );
    },

    async writeSession(session) {
      if (!connection) throw new Error("Not connected to Dolt");
      await connection.execute(
        `INSERT INTO sessions (
          session_id, task_id, mode, model, status, total_cost,
          tokens_in, tokens_out, tokens_reasoning, started_at, completed_at, outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          task_id = VALUES(task_id),
          mode = VALUES(mode),
          model = VALUES(model),
          status = VALUES(status),
          total_cost = VALUES(total_cost),
          tokens_in = VALUES(tokens_in),
          tokens_out = VALUES(tokens_out),
          tokens_reasoning = VALUES(tokens_reasoning),
          started_at = VALUES(started_at),
          completed_at = VALUES(completed_at),
          outcome = VALUES(outcome)`,
        [
          session.sessionId,
          session.taskId ?? null,
          session.mode ?? null,
          session.model ?? null,
          session.status ?? "running",
          session.totalCost ?? 0,
          session.tokensIn ?? 0,
          session.tokensOut ?? 0,
          session.tokensReasoning ?? 0,
          session.startedAt ?? null,
          session.completedAt ?? null,
          session.outcome ?? null,
        ]
      );
    },

    async writeMessage(message) {
      if (!connection) throw new Error("Not connected to Dolt");
      await connection.execute(
        `INSERT IGNORE INTO messages (
          session_id, role, content_type, content_preview, ts, cost, tokens_in, tokens_out
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        FROM DUAL
        WHERE NOT EXISTS (
          SELECT 1 FROM messages WHERE session_id = ? AND ts = ? AND role = ?
        )`,
        [
          message.sessionId,
          message.role,
          message.contentType ?? "text",
          message.contentPreview ?? null,
          message.ts,
          message.cost ?? null,
          message.tokensIn ?? null,
          message.tokensOut ?? null,
          message.sessionId,
          message.ts,
          message.role,
        ]
      );
    },

    async writeToolCall(toolCall) {
      if (!connection) throw new Error("Not connected to Dolt");
      await connection.execute(
        `INSERT IGNORE INTO tool_calls (
          session_id, tool_name, args_summary, status, error, duration_ms, cost, ts
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        FROM DUAL
        WHERE NOT EXISTS (
          SELECT 1 FROM tool_calls WHERE session_id = ? AND ts = ? AND tool_name = ?
        )`,
        [
          toolCall.sessionId,
          toolCall.toolName,
          toolCall.argsSummary ?? null,
          toolCall.status ?? null,
          toolCall.error ?? null,
          toolCall.durationMs ?? null,
          toolCall.cost ?? null,
          toolCall.ts,
          toolCall.sessionId,
          toolCall.ts,
          toolCall.toolName,
        ]
      );
    },

    async writeChildRelation(parentId: string, childId: string) {
      if (!connection) throw new Error("Not connected to Dolt");
      await connection.execute(
        "INSERT IGNORE INTO child_rels (parent_id, child_id) VALUES (?, ?)",
        [parentId, childId]
      );
    },

    async syncChildRelsFromPunches(): Promise<number> {
      if (!connection) throw new Error("Not connected to Dolt");

      const [rows] = await connection.query(
        `SELECT task_id, punch_key
         FROM punches
         WHERE punch_type = 'child_spawn'`
      );

      let inserted = 0;
      for (const row of rows as Array<{ task_id: string; punch_key: string }>) {
        const result = await connection.execute<mysql.ResultSetHeader>(
          "INSERT IGNORE INTO child_rels (parent_id, child_id) VALUES (?, ?)",
          [row.task_id, row.punch_key]
        );
        const header = Array.isArray(result) ? result[0] : result;
        inserted +=
          header && typeof header === "object" && "affectedRows" in header
            ? ((header as mysql.ResultSetHeader).affectedRows ?? 0)
            : 0;
      }
      return inserted;
    },

    async disconnect() {
      if (connection) {
        await connection.end();
        connection = null;
      }
    },
  };
}
