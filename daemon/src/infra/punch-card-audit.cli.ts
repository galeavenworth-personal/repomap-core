#!/usr/bin/env tsx
/**
 * CLI entry point for batch punch card audit.
 *
 * Replaces .kilocode/tools/audit_punch_cards.sh with mysql2 protocol
 * queries instead of shell SQL via mysql/dolt CLI.
 *
 * Queries tasks and checkpoints tables for entries with punch_card_id
 * assignments, then validates each one using the check logic from
 * punch-card-check.cli.ts.
 *
 * Usage:
 *   npx tsx daemon/src/infra/punch-card-audit.cli.ts [OPTIONS] [limit]
 *
 * Options:
 *   --json    Output results as JSON instead of human-readable text
 *   --help    Show this help
 *
 * Arguments:
 *   limit     Maximum number of tasks to audit (default: 50)
 *
 * Exit codes:
 *   0  All audited tasks passed
 *   1  One or more tasks failed or errored
 *   2  Usage error or query failure
 *
 * See: repomap-core-76q.3
 */

import mysql from "mysql2/promise";

import {
  type PunchCardCheckConfig,
  defaultCheckConfig,
  checkPunchCard,
} from "./punch-card-check.cli.js";

// ── Types ────────────────────────────────────────────────────────────────

interface TaskRow {
  task_id: string;
  card_id: string;
}

export interface AuditOptions {
  limit: number;
  jsonOutput: boolean;
}

export interface AuditTaskResult {
  taskId: string;
  cardId: string;
  status: "pass" | "fail" | "error";
  error?: string;
}

export interface AuditResult {
  tasks: AuditTaskResult[];
  passCount: number;
  failCount: number;
  errorCount: number;
  passed: boolean;
}

// ── Core Logic ───────────────────────────────────────────────────────────

/**
 * Fetch tasks with punch card assignments from Dolt.
 */
export async function fetchAuditTargets(
  config: PunchCardCheckConfig,
  limit: number,
): Promise<Array<{ taskId: string; cardId: string }>> {
  let connection: mysql.Connection | undefined;
  try {
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectTimeout: 5000,
    });

    const [rows] = await connection.execute(
      `SELECT task_id, card_id
       FROM (
         SELECT t.task_id AS task_id, t.punch_card_id AS card_id, t.started_at AS observed_at
         FROM tasks t
         WHERE t.punch_card_id IS NOT NULL
           AND t.punch_card_id <> ''

         UNION ALL

         SELECT c.task_id AS task_id, c.card_id AS card_id, c.validated_at AS observed_at
         FROM checkpoints c
         WHERE c.card_id IS NOT NULL
           AND c.card_id <> ''
       ) ranked
       ORDER BY observed_at DESC
       LIMIT ?`,
      [limit],
    );

    return (rows as TaskRow[]).map((row) => ({
      taskId: row.task_id,
      cardId: row.card_id,
    }));
  } finally {
    if (connection) {
      await connection.end().catch(() => {});
    }
  }
}

/**
 * Run a batch audit of all tasks with punch card assignments.
 */
export async function auditPunchCards(
  config: PunchCardCheckConfig,
  options: AuditOptions,
): Promise<AuditResult> {
  const targets = await fetchAuditTargets(config, options.limit);

  if (targets.length === 0) {
    return {
      tasks: [],
      passCount: 0,
      failCount: 0,
      errorCount: 0,
      passed: true,
    };
  }

  const tasks: AuditTaskResult[] = [];
  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;

  for (const target of targets) {
    try {
      const result = await checkPunchCard(config, {
        sessionId: target.taskId,
        cardId: target.cardId,
      });

      if (result.passed) {
        tasks.push({ taskId: target.taskId, cardId: target.cardId, status: "pass" });
        passCount++;
      } else {
        tasks.push({ taskId: target.taskId, cardId: target.cardId, status: "fail" });
        failCount++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tasks.push({ taskId: target.taskId, cardId: target.cardId, status: "error", error: message });
      errorCount++;
    }
  }

  return {
    tasks,
    passCount,
    failCount,
    errorCount,
    passed: failCount === 0 && errorCount === 0,
  };
}

// ── Output Formatting ────────────────────────────────────────────────────

function formatAuditResult(result: AuditResult): string {
  const lines: string[] = [];

  if (result.tasks.length === 0) {
    lines.push("No tasks with punch cards found for audit.");
    return lines.join("\n");
  }

  lines.push(`Punch card audit (${result.tasks.length} tasks, engine=mysql2)`);

  for (const task of result.tasks) {
    switch (task.status) {
      case "pass":
        lines.push(`\u2705 ${task.taskId} (${task.cardId})`);
        break;
      case "fail":
        lines.push(`\u274C ${task.taskId} (${task.cardId})`);
        break;
      case "error":
        lines.push(`\uD83D\uDEAB ${task.taskId} (${task.cardId})`);
        break;
    }
  }

  lines.push(`Summary: pass=${result.passCount} fail=${result.failCount} error=${result.errorCount}`);

  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`Usage: npx tsx daemon/src/infra/punch-card-audit.cli.ts [OPTIONS] [limit]

Options:
  --json    Output results as JSON
  --help    Show this help

Arguments:
  limit     Maximum number of tasks to audit (default: 50)

Exit codes:
  0  All audited tasks passed
  1  One or more tasks failed or errored
  2  Usage error or query failure`);
}

function parseArgs(argv: string[]): AuditOptions {
  const args = argv.slice(2);
  let limit = 50;
  let jsonOutput = false;

  for (const arg of args) {
    switch (arg) {
      case "--json":
        jsonOutput = true;
        break;
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`ERROR: unknown option: ${arg}`);
          process.exit(2);
        }
        {
          const parsed = Number.parseInt(arg, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            console.error("ERROR: limit must be a positive integer");
            process.exit(2);
          }
          limit = parsed;
        }
        break;
    }
  }

  return { limit, jsonOutput };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv);
  const config = defaultCheckConfig();

  try {
    const result = await auditPunchCards(config, options);

    if (options.jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatAuditResult(result));
    }

    return result.passed ? 0 : 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${message}`);
    return 2;
  }
}

// Only run CLI when executed directly (not when imported for testing)
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectRun) {
  const code = await main();
  process.exit(code);
}
