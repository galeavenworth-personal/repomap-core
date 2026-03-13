#!/usr/bin/env tsx
/**
 * CLI entry point for PR reconciliation.
 *
 * Usage:
 *   npx tsx daemon/src/infra/pr-reconcile.cli.ts [--dry-run] [--strict] <task-id> [<task-id> ...]
 *
 * Options:
 *   --dry-run   Do not mutate Beads; just report what would be closed.
 *   --strict    Fail (exit 2) if GitHub client init/repo discovery/query fails, or bd close fails.
 *   --help, -h  Show usage information.
 *
 * Exit codes:
 *   0  Success (or dry-run)
 *   2  Error (missing args or strict-mode failure)
 *
 * See: repomap-core-76q.7
 */

import { reconcile, defaultOptions } from "./pr-reconcile.js";

interface ParsedCliArgs {
  dryRun: boolean;
  strict: boolean;
  taskIds: string[];
  exitCode: number;
}

function printUsage(): void {
  console.log(
    "Usage: npx tsx daemon/src/infra/pr-reconcile.cli.ts [--dry-run] [--strict] <task-id> [<task-id> ...]",
  );
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  let dryRun = false;
  let strict = false;
  const taskIds: string[] = [];
  let dashDash = false;

  for (const arg of args) {
    if (dashDash) {
      taskIds.push(arg);
      continue;
    }
    switch (arg) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--strict":
        strict = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        console.log("  --dry-run   Report what would be closed without mutating Beads");
        console.log("  --strict    Fail on any GitHub client/query or bd error");
        return { dryRun, strict, taskIds: [], exitCode: 0 };
      case "--":
        dashDash = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`ERROR: unknown option: ${arg}`);
          return { dryRun, strict, taskIds: [], exitCode: 2 };
        }
        taskIds.push(arg);
        break;
    }
  }

  if (taskIds.length === 0) {
    printUsage();
    return { dryRun, strict, taskIds: [], exitCode: 2 };
  }

  return { dryRun, strict, taskIds, exitCode: -1 };
}

function printResultLine(
  item: { taskId: string; message: string; status: string },
  strict: boolean,
): void {
  const line = `${item.taskId}: ${item.message}`;

  switch (item.status) {
    case "gh_error":
      if (strict) {
        console.error(`ERROR: ${line}`);
      } else {
        console.error(`${item.taskId}: WARN GitHub query failed; reconciliation skipped`);
        console.log(`${item.taskId}: reconciliation skipped (gh error)`);
      }
      return;
    case "bd_error":
      if (strict) {
        console.error(`ERROR: ${line}`);
      } else {
        console.error(`${item.taskId}: WARN bd close failed; continuing`);
        console.log(`${item.taskId}: merged PR found; FAILED to close in Beads`);
      }
      return;
    case "gh_missing":
      if (strict) {
        console.error(`ERROR: ${line}`);
      } else {
        console.error(`${item.taskId}: WARN GitHub client unavailable; reconciliation skipped (no-op)`);
        console.log(`${item.taskId}: reconciliation skipped (GitHub client unavailable)`);
      }
      return;
    default:
      console.log(line);
  }
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.exitCode >= 0) {
    return parsed.exitCode;
  }

  // ── Run reconciliation ────────────────────────────────────────────────

  const opts = defaultOptions({ dryRun: parsed.dryRun, strict: parsed.strict });
  const result = await reconcile(parsed.taskIds, opts);

  // ── Output ────────────────────────────────────────────────────────────

  for (const item of result.items) {
    printResultLine(item, parsed.strict);
  }

  // ── Exit code ─────────────────────────────────────────────────────────

  return result.success ? 0 : 2;
}

try {
  const code = await main();
  process.exit(code);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`ERROR: ${message}`);
  process.exit(2);
}
