import mysql, { type Connection } from "mysql2/promise";

import type { DoltConfig } from "../writer/index.js";
import type {
  PunchCardRequirement,
  ToolAdherenceResult,
  ValidationResult,
} from "./types.js";

interface CountRow {
  count: number | string;
}

interface RequirementRow {
  punch_type: string;
  punch_key_pattern: string;
  required: number | boolean;
  forbidden: number | boolean;
  description?: string | null;
}

export class PunchCardValidator {
  private connection: Connection | null = null;

  constructor(private readonly config: DoltConfig) {}

  async connect(): Promise<void> {
    this.connection = await mysql.createConnection({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user ?? "root",
      password: this.config.password,
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  private requireConnection(): Connection {
    if (!this.connection) {
      throw new Error("PunchCardValidator is not connected");
    }
    return this.connection;
  }

  private static toBoolean(value: number | boolean): boolean {
    return value === true || value === 1;
  }

  private static toNumber(value: number | string | undefined): number {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private async fetchCardRequirements(cardId: string): Promise<PunchCardRequirement[]> {
    const conn = this.requireConnection();
    const [rowsUnknown] = await conn.execute(
      `SELECT
         punch_type,
         punch_key_pattern,
         required,
         forbidden,
         description
       FROM punch_cards
       WHERE card_id = ?`,
      [cardId],
    );

    const rows = rowsUnknown as RequirementRow[];
    return rows.map((row) => ({
      punchType: row.punch_type,
      punchKeyPattern: row.punch_key_pattern,
      required: PunchCardValidator.toBoolean(row.required),
      forbidden: PunchCardValidator.toBoolean(row.forbidden),
      description: row.description ?? undefined,
    }));
  }

  private async countMatchingPunches(
    taskId: string,
    punchType: string,
    punchKeyPattern: string,
  ): Promise<number> {
    const conn = this.requireConnection();
    const [rowsUnknown] = await conn.execute(
      `SELECT COUNT(*) AS count
       FROM punches
       WHERE task_id = ?
         AND punch_type = ?
         AND punch_key LIKE ?`,
      [taskId, punchType, punchKeyPattern],
    );

    const rows = rowsUnknown as CountRow[];
    return PunchCardValidator.toNumber(rows[0]?.count);
  }

  async validatePunchCard(taskId: string, cardId: string): Promise<ValidationResult> {
    const requirements = await this.fetchCardRequirements(cardId);

    if (requirements.length === 0) {
      return {
        status: "fail",
        cardId,
        taskId,
        missing: [],
        violations: [],
      };
    }

    const missing: ValidationResult["missing"] = [];
    const violations: ValidationResult["violations"] = [];

    for (const requirement of requirements) {
      if (!requirement.required) {
        continue;
      }

      const count = await this.countMatchingPunches(
        taskId,
        requirement.punchType,
        requirement.punchKeyPattern,
      );

      if (requirement.forbidden) {
        if (count > 0) {
          violations.push({
            punchType: requirement.punchType,
            punchKeyPattern: requirement.punchKeyPattern,
            count,
            description: requirement.description,
          });
        }
        continue;
      }

      if (count <= 0) {
        missing.push({
          punchType: requirement.punchType,
          punchKeyPattern: requirement.punchKeyPattern,
          description: requirement.description,
        });
      }
    }

    return {
      status: missing.length === 0 && violations.length === 0 ? "pass" : "fail",
      cardId,
      taskId,
      missing,
      violations,
    };
  }

  async checkToolAdherence(
    taskId: string,
    expectedRange: [number, number],
  ): Promise<ToolAdherenceResult> {
    const conn = this.requireConnection();
    const [rowsUnknown] = await conn.execute(
      `SELECT COUNT(*) AS count
       FROM punches
       WHERE task_id = ?
         AND punch_type = 'tool_call'
         AND punch_key IN ('write_to_file', 'edit_file', 'apply_diff')`,
      [taskId],
    );

    const rows = rowsUnknown as CountRow[];
    const editCount = PunchCardValidator.toNumber(rows[0]?.count);
    const withinRange = editCount >= expectedRange[0] && editCount <= expectedRange[1];

    return {
      editCount,
      expectedRange,
      withinRange,
    };
  }
}
