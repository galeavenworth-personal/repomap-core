#!/usr/bin/env tsx
/**
 * CLI entry point for punch card validation.
 *
 * Replaces .kilocode/tools/check_punch_card.sh with mysql2 protocol
 * queries instead of shell SQL via mysql/dolt CLI.
 *
 * Usage:
 *   npx tsx daemon/src/infra/punch-card-check.cli.ts [OPTIONS] <session_id> <card_id>
 *
 * Options:
 *   --parent-session UUID   Parent session ID (informational)
 *   --enforced-only         Only check enforced requirements
 *   --json                  Output results as JSON instead of human-readable text
 *   --help                  Show this help
 *
 * Exit codes:
 *   0  All requirements satisfied (PASS)
 *   1  One or more requirements violated (FAIL)
 *   2  Usage error or query failure
 *
 * See: repomap-core-76q.3
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";

// ── Types ────────────────────────────────────────────────────────────────

export interface PunchCardCheckConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface CheckOptions {
  sessionId: string;
  cardId: string;
  parentSession?: string;
  enforcedOnly?: boolean;
  jsonOutput?: boolean;
}

interface RequirementRow {
  forbidden: number | boolean;
  required: number | boolean;
  punch_type: string;
  punch_key_pattern: string;
  description: string | null;
}

interface CountRow {
  count: number | string;
}

export interface RequirementResult {
  kind: "required" | "forbidden";
  punchType: string;
  punchKeyPattern: string;
  description?: string;
  count: number;
  passed: boolean;
}

export interface CheckResult {
  sessionId: string;
  cardId: string;
  parentSession?: string;
  enforcedOnly: boolean;
  requirements: RequirementResult[];
  failures: number;
  passed: boolean;
}

// ── Configuration ────────────────────────────────────────────────────────

export function defaultCheckConfig(): PunchCardCheckConfig {
  return {
    host: process.env.DOLT_HOST ?? "127.0.0.1",
    port: Number(process.env.DOLT_PORT ?? "3307"),
    database: process.env.DOLT_DATABASE || "factory",
    user: "root",
    password: "",
  };
}

// ── Core Logic ───────────────────────────────────────────────────────────

function toBool(value: number | boolean): boolean {
  return value === true || value === 1;
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

const SAFE_ID_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Validate a punch card for a given session.
 * This is the core logic extracted for reuse by the audit CLI.
 */
export async function checkPunchCard(
  config: PunchCardCheckConfig,
  options: CheckOptions,
): Promise<CheckResult> {
  if (!SAFE_ID_RE.test(options.sessionId)) {
    throw new Error(`invalid session_id '${options.sessionId}'`);
  }
  if (!SAFE_ID_RE.test(options.cardId)) {
    throw new Error(`invalid card_id '${options.cardId}'`);
  }

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

    // Fetch requirements
    const enforcedClause = options.enforcedOnly ? " AND enforced = TRUE" : "";
    const [reqRows] = await connection.execute(
      `SELECT forbidden, required, punch_type, punch_key_pattern, COALESCE(description, '') AS description
       FROM punch_cards
       WHERE card_id = ?${enforcedClause}
       ORDER BY forbidden DESC, required DESC, punch_type, punch_key_pattern`,
      [options.cardId],
    );

    const requirements = reqRows as RequirementRow[];
    if (requirements.length === 0) {
      throw new Error(`no requirements found for card '${options.cardId}'`);
    }

    const results: RequirementResult[] = [];
    let failures = 0;

    for (const req of requirements) {
      const forbidden = toBool(req.forbidden);
      const required = toBool(req.required);

      if (!forbidden && !required) {
        continue;
      }

      const [countRows] = await connection.execute(
        `SELECT COUNT(*) AS count
         FROM punches
         WHERE task_id = ?
           AND punch_type = ?
           AND punch_key LIKE ?`,
        [options.sessionId, req.punch_type, req.punch_key_pattern],
      );

      const count = toNumber((countRows as CountRow[])[0]?.count);

      if (forbidden) {
        const passed = count === 0;
        if (!passed) failures++;
        results.push({
          kind: "forbidden",
          punchType: req.punch_type,
          punchKeyPattern: req.punch_key_pattern,
          description: req.description || undefined,
          count,
          passed,
        });
        continue;
      }

      // required
      const passed = count > 0;
      if (!passed) failures++;
      results.push({
        kind: "required",
        punchType: req.punch_type,
        punchKeyPattern: req.punch_key_pattern,
        description: req.description || undefined,
        count,
        passed,
      });
    }

    return {
      sessionId: options.sessionId,
      cardId: options.cardId,
      parentSession: options.parentSession,
      enforcedOnly: options.enforcedOnly ?? false,
      requirements: results,
      failures,
      passed: failures === 0,
    };
  } finally {
    if (connection) {
      await connection.end().catch(() => {});
    }
  }
}

// ── Output Formatting ────────────────────────────────────────────────────

function formatCheckResult(result: CheckResult): string {
  const lines: string[] = [];

  lines.push(
    "Punch Card Check",
    `- Session: ${result.sessionId}`,
    `- Card: ${result.cardId}`,
    "- Engine: mysql2",
  );
  if (result.enforcedOnly) {
    lines.push("- Mode: enforced-only (exit gate)");
  }
  if (result.parentSession) {
    lines.push(`- Parent Session: ${result.parentSession}`);
  }

  for (const req of result.requirements) {
    const desc = req.description ? ` \u2014 ${req.description}` : "";
    if (req.kind === "forbidden" && req.passed) {
      lines.push(`\u2705 FORBIDDEN ${req.punchType}:${req.punchKeyPattern} absent${desc}`);
    } else if (req.kind === "forbidden") {
      lines.push(`\uD83D\uDEAB FORBIDDEN ${req.punchType}:${req.punchKeyPattern} observed ${req.count} time(s)${desc}`);
    } else if (req.passed) {
      lines.push(`\u2705 REQUIRED ${req.punchType}:${req.punchKeyPattern} satisfied (${req.count})${desc}`);
    } else {
      lines.push(`\u274C REQUIRED ${req.punchType}:${req.punchKeyPattern} missing${desc}`);
    }
  }

  if (result.passed) {
    lines.push("PASS: card requirements satisfied");
  } else {
    lines.push(`FAIL: ${result.failures} requirement(s) violated`);
  }

  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`Usage: npx tsx daemon/src/infra/punch-card-check.cli.ts [OPTIONS] <session_id> <card_id>

Options:
  --parent-session UUID   Parent session ID (informational)
  --enforced-only         Only check enforced requirements
  --json                  Output results as JSON
  --help                  Show this help

Exit codes:
  0  All requirements satisfied (PASS)
  1  One or more requirements violated (FAIL)
  2  Usage error or query failure`);
}

function parseArgs(argv: string[]): CheckOptions & { jsonOutput: boolean } {
  const args = argv.slice(2);
  let parentSession: string | undefined;
  let enforcedOnly = false;
  let jsonOutput = false;
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--parent-session":
        if (i + 1 >= args.length) {
          console.error("ERROR: --parent-session requires a value");
          process.exit(2);
        }
        parentSession = args[++i];
        break;
      case "--enforced-only":
        enforcedOnly = true;
        break;
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
        positional.push(arg);
        break;
    }
    i++;
  }

  if (positional.length !== 2) {
    showHelp();
    process.exit(2);
  }

  return {
    sessionId: positional[0],
    cardId: positional[1],
    parentSession,
    enforcedOnly,
    jsonOutput,
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv);
  const config = defaultCheckConfig();

  try {
    const result = await checkPunchCard(config, options);

    if (options.jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatCheckResult(result));
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
  process.argv[1] != null &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isDirectRun) {
  const code = await main();
  process.exit(code);
}
