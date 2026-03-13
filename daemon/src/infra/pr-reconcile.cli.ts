#!/usr/bin/env tsx
/**
 * CLI entry point for PR reconciliation.
 *
 * Usage:
 *   npx tsx daemon/src/infra/pr-reconcile.cli.ts [--dry-run] [--strict] <task-id> [<task-id> ...]
 *
 * Options:
 *   --dry-run   Do not mutate Beads; just report what would be closed.
 *   --strict    Fail (exit 2) if gh is missing, gh queries fail, or bd close fails.
 *   --help, -h  Show usage information.
 *
 * Exit codes:
 *   0  Success (or dry-run)
 *   2  Error (missing args, strict-mode failure, or gh missing in strict mode)
 *
 * See: repomap-core-76q.7
 */

import { reconcile, defaultOptions } from "./pr-reconcile.js";

async function main(): Promise<number> {
  // ── Argument parsing ──────────────────────────────────────────────────

  const args = process.argv.slice(2);

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
        console.log(
          "Usage: npx tsx daemon/src/infra/pr-reconcile.cli.ts [--dry-run] [--strict] <task-id> [<task-id> ...]",
        );
        console.log("  --dry-run   Report what would be closed without mutating Beads");
        console.log("  --strict    Fail on any gh or bd error");
        return 0;
      case "--":
        dashDash = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`ERROR: unknown option: ${arg}`);
          return 2;
        }
        taskIds.push(arg);
        break;
    }
  }

  if (taskIds.length === 0) {
    console.error(
      "Usage: npx tsx daemon/src/infra/pr-reconcile.cli.ts [--dry-run] [--strict] <task-id> [<task-id> ...]",
    );
    return 2;
  }

  // ── Run reconciliation ────────────────────────────────────────────────

  const opts = defaultOptions({ dryRun, strict });
  const result = await reconcile(taskIds, opts);

  // ── Output ────────────────────────────────────────────────────────────

  for (const item of result.items) {
    const line = `${item.taskId}: ${item.message}`;

    // Route warnings/errors to stderr, normal output to stdout
    switch (item.status) {
      case "gh_error":
        if (strict) {
          console.error(`ERROR: ${line}`);
        } else {
          console.error(`${item.taskId}: WARN gh query failed; reconciliation skipped`);
          console.log(`${item.taskId}: reconciliation skipped (gh error)`);
        }
        break;
      case "bd_error":
        if (strict) {
          console.error(`ERROR: ${line}`);
        } else {
          console.error(`${item.taskId}: WARN bd close failed; continuing`);
          console.log(`${item.taskId}: merged PR found; FAILED to close in Beads`);
        }
        break;
      case "gh_missing":
        if (strict) {
          console.error(`ERROR: ${line}`);
        } else {
          console.error(`${item.taskId}: WARN gh missing; reconciliation skipped (no-op)`);
          console.log(`${item.taskId}: reconciliation skipped (gh missing)`);
        }
        break;
      default:
        console.log(line);
        break;
    }
  }

  // ── Exit code ─────────────────────────────────────────────────────────

  return result.success ? 0 : 2;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${message}`);
    process.exit(2);
  });
