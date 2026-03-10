/**
 * Dolt Utilities — Shared types, helpers, and base client for governor modules
 * that query Dolt punch data.
 *
 * Extracted from cost-budget-monitor.ts and session-audit.ts to eliminate
 * duplicated type definitions, numeric coercion logic, connection lifecycle,
 * and environment variable parsing.
 */

import mysql, { type Connection } from "mysql2/promise";

import type { DoltConfig } from "../writer/index.js";

// ── MySQL Numeric Coercion ──

/** MySQL2 returns numeric columns as string | number | null depending on driver config. */
export type MysqlNumeric = string | number | null;

/** Safely coerce a MySQL numeric value to a JS number (0 on null/NaN). */
export function toNumber(value: MysqlNumeric | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ── Shared Row Types ──

/** Row shape from Dolt cost aggregation queries. */
export interface CostAggRow {
  total_cost: MysqlNumeric;
  step_count: MysqlNumeric;
  tokens_input: MysqlNumeric;
  tokens_output: MysqlNumeric;
  tokens_reasoning: MysqlNumeric;
  punch_count: MysqlNumeric;
}

/** Row shape from child_rels table. */
export interface ChildRow {
  child_id: string;
}

// ── Base Dolt Client ──

/**
 * Base class for governor modules that need a Dolt connection.
 * Provides connect / disconnect / requireConnection lifecycle.
 */
export abstract class BaseDoltClient {
  protected connection: Connection | null = null;

  constructor(protected readonly doltConfig: DoltConfig) {}

  async connect(): Promise<void> {
    this.connection = await mysql.createConnection({
      host: this.doltConfig.host,
      port: this.doltConfig.port,
      database: this.doltConfig.database,
      user: this.doltConfig.user ?? "root",
      password: this.doltConfig.password,
    });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  protected requireConnection(): Connection {
    if (!this.connection) {
      throw new Error(`${this.constructor.name} is not connected`);
    }
    return this.connection;
  }

  /**
   * Query Dolt for cost/token/step aggregation of a single session.
   * Shared between CostBudgetMonitor.getSessionCost and SessionAudit.getSessionMetrics.
   */
  protected async queryCostAgg(sessionId: string): Promise<{
    totalCost: number;
    stepCount: number;
    tokensInput: number;
    tokensOutput: number;
    tokensReasoning: number;
    punchCount: number;
  }> {
    const conn = this.requireConnection();
    const [rowsUnknown] = await conn.execute(
      `SELECT
         COALESCE(SUM(cost), 0)             AS total_cost,
         SUM(CASE WHEN punch_type = 'step_complete' AND punch_key = 'step_finished' THEN 1 ELSE 0 END) AS step_count,
         COALESCE(SUM(tokens_input), 0)     AS tokens_input,
         COALESCE(SUM(tokens_output), 0)    AS tokens_output,
         COALESCE(SUM(tokens_reasoning), 0) AS tokens_reasoning,
         COUNT(*)                            AS punch_count
       FROM punches
       WHERE task_id = ?`,
      [sessionId],
    );
    const row = (rowsUnknown as CostAggRow[])[0];
    return {
      totalCost: toNumber(row?.total_cost),
      stepCount: toNumber(row?.step_count),
      tokensInput: toNumber(row?.tokens_input),
      tokensOutput: toNumber(row?.tokens_output),
      tokensReasoning: toNumber(row?.tokens_reasoning),
      punchCount: toNumber(row?.punch_count),
    };
  }

  /** Query direct child IDs from the child_rels table. */
  protected async queryChildIds(parentId: string): Promise<string[]> {
    const conn = this.requireConnection();
    const [rowsUnknown] = await conn.execute(
      `SELECT child_id FROM child_rels WHERE parent_id = ?`,
      [parentId],
    );
    return (rowsUnknown as ChildRow[]).map((r) => r.child_id);
  }
}

// ── Environment Variable Parsing ──

/**
 * Parse a positive float from an env var, returning fallback on missing/invalid.
 */
export function parseEnvFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse a positive integer from an env var, returning fallback on missing/invalid.
 */
export function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
