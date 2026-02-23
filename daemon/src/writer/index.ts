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
  writeChildRelation(parentId: string, childId: string): Promise<void>;
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

    async writeChildRelation(parentId: string, childId: string) {
      if (!connection) throw new Error("Not connected to Dolt");
      await connection.execute(
        "INSERT IGNORE INTO child_rels (parent_id, child_id) VALUES (?, ?)",
        [parentId, childId]
      );
    },

    async disconnect() {
      if (connection) {
        await connection.end();
        connection = null;
      }
    },
  };
}
