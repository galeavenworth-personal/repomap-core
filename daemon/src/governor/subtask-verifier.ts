import mysql, { type Connection } from "mysql2/promise";

import type { DoltConfig } from "../writer/index.js";
import { PunchCardValidator } from "./punch-card-validator.js";
import type { SubtaskValidation } from "./types.js";

interface ChildRow {
  child_id: string;
}

export class SubtaskVerifier {
  private connection: Connection | null = null;
  private validator: PunchCardValidator;

  constructor(config: DoltConfig, validator?: PunchCardValidator) {
    this.validator = validator ?? new PunchCardValidator(config);
    this.config = config;
  }

  private readonly config: DoltConfig;

  async connect(): Promise<void> {
    this.connection = await mysql.createConnection({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user ?? "root",
      password: this.config.password,
    });
    await this.validator.connect();
  }

  async disconnect(): Promise<void> {
    try {
      await this.validator.disconnect();
    } finally {
      if (this.connection) {
        await this.connection.end();
        this.connection = null;
      }
    }
  }

  private requireConnection(): Connection {
    if (!this.connection) {
      throw new Error("SubtaskVerifier is not connected");
    }
    return this.connection;
  }

  private async getChildIds(parentTaskId: string): Promise<string[]> {
    const conn = this.requireConnection();
    const [rowsUnknown] = await conn.execute(
      `SELECT child_id
       FROM child_rels
       WHERE parent_id = ?`,
      [parentTaskId],
    );

    const rows = rowsUnknown as ChildRow[];
    return rows.map((row) => row.child_id);
  }

  async verifySubtasks(parentTaskId: string, childCardId: string): Promise<SubtaskValidation> {
    const childIds = await this.getChildIds(parentTaskId);
    const children: SubtaskValidation["children"] = [];

    for (const childId of childIds) {
      const validation = await this.validator.validatePunchCard(childId, childCardId);
      children.push({ childId, validation });
    }

    return {
      parentTaskId,
      children,
      allChildrenValid: children.every((child) => child.validation.status === "pass"),
    };
  }
}
