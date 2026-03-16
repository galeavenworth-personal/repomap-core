#!/usr/bin/env tsx
/**
 * CLI entry point for punch card validation.
 *
 * Uses kilo-verified event-log replay validation via session.messages,
 * then evaluates against punch_cards requirements.
 *
 * Usage:
 *   npx tsx daemon/src/infra/punch-card-check.cli.ts [OPTIONS] <session_id> <card_id>
 *
 * Options:
 *   --parent-session UUID   Parent session ID (provenance hint)
 *   --enforced-only         Only check enforced requirements
 *   --json                  Output results as JSON instead of human-readable text
 *   --help                  Show this help
 *
 * Exit codes:
 *   0  All requirements satisfied (PASS)
 *   1  One or more requirements violated (FAIL)
 *   2  Usage error or query failure
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpencodeClient } from "@opencode-ai/sdk/client";

import { validateFromKiloLog } from "../governor/kilo-verified-validator.js";

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
  sourceSessionId: string;
  messageCount: number;
  derivationPath: string;
  trustLevel: "verified" | "projected" | "untrusted";
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

const SAFE_ID_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Validate a punch card for a given session using kilo-verified replay.
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

  const baseUrl = `http://${process.env.KILO_HOST ?? "127.0.0.1"}:${process.env.KILO_PORT ?? "4096"}`;
  const client = createOpencodeClient({ baseUrl });

  const validation = await validateFromKiloLog(
    options.sessionId,
    client,
    {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
    },
    options.cardId,
    {
      enforcedOnly: options.enforcedOnly,
      sourceSessionId: options.parentSession ?? options.sessionId,
    },
  );

  const requirementFailures: RequirementResult[] = [
    ...validation.violations.map((violation) => ({
      kind: "forbidden" as const,
      punchType: violation.punchType,
      punchKeyPattern: violation.punchKeyPattern,
      description: violation.description,
      count: violation.count,
      passed: false,
    })),
    ...validation.missing.map((missing) => ({
      kind: "required" as const,
      punchType: missing.punchType,
      punchKeyPattern: missing.punchKeyPattern,
      description: missing.description,
      count: 0,
      passed: false,
    })),
  ];

  return {
    sessionId: options.sessionId,
    cardId: options.cardId,
    parentSession: options.parentSession,
    enforcedOnly: options.enforcedOnly ?? false,
    sourceSessionId: validation.sourceSessionId,
    messageCount: validation.messageCount,
    derivationPath: validation.derivationPath,
    trustLevel: validation.trustLevel,
    requirements: requirementFailures,
    failures: requirementFailures.length,
    passed: validation.status === "pass",
  };
}

// ── Output Formatting ────────────────────────────────────────────────────

function formatCheckResult(result: CheckResult): string {
  const lines: string[] = [];

  lines.push(
    "Punch Card Check",
    `- Session: ${result.sessionId}`,
    `- Card: ${result.cardId}`,
    "- Engine: kilo-verified",
    `- Source Session: ${result.sourceSessionId}`,
    `- Message Count: ${result.messageCount}`,
    `- Trust Level: ${result.trustLevel}`,
    `- Derivation Path: ${result.derivationPath}`,
  );

  if (result.enforcedOnly) {
    lines.push("- Mode: enforced-only (exit gate)");
  }
  if (result.parentSession) {
    lines.push(`- Parent Session: ${result.parentSession}`);
  }

  for (const req of result.requirements) {
    const desc = req.description ? ` -- ${req.description}` : "";
    if (req.kind === "forbidden") {
      lines.push(
        `[VIOLATION] FORBIDDEN ${req.punchType}:${req.punchKeyPattern} observed ${req.count} time(s)${desc}`,
      );
    } else {
      lines.push(`[MISSING] REQUIRED ${req.punchType}:${req.punchKeyPattern} missing${desc}`);
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
