#!/usr/bin/env tsx
/**
 * CLI entry point for PR reconciliation.
 *
 * Usage:
 *   npx tsx daemon/src/infra/pr-reconcile.cli.ts [--dry-run] [--strict] [--owner <owner>] [--repo <repo>] <task-id> [<task-id> ...]
 *
 * Options:
 *   --dry-run       Do not mutate Beads; just report what would be closed.
 *   --strict        Fail (exit 2) if GitHub API is unreachable, queries fail, or bd close fails.
 *   --owner <owner> Repository owner (defaults to git remote origin).
 *   --repo <repo>   Repository name (defaults to git remote origin).
 *   --help, -h      Show usage information.
 *
 * Exit codes:
 *   0  Success (or dry-run)
 *   2  Error (missing args, strict-mode failure, or GitHub API unreachable in strict mode)
 *
 * See: repomap-core-76q.7, repomap-core-ovm.5
 */

import { execFileSync } from "node:child_process";
import { createGitHubClient } from "./github-client.js";
import { reconcile, defaultOptions, type ReconcileItemResult } from "./pr-reconcile.js";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Parse owner/repo from git remote origin URL. */
function parseRemoteOrigin(): { owner: string; repo: string } | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  } catch {
    return null;
  }
}

// ── Argument parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);

let dryRun = false;
let strict = false;
let owner: string | null = null;
let repo: string | null = null;
const taskIds: string[] = [];
let dashDash = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
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
    case "--owner":
      owner = args[++i] ?? null;
      break;
    case "--repo":
      repo = args[++i] ?? null;
      break;
    case "--help":
    case "-h":
      console.log(
        "Usage: npx tsx daemon/src/infra/pr-reconcile.cli.ts [--dry-run] [--strict] [--owner <owner>] [--repo <repo>] <task-id> [<task-id> ...]",
      );
      console.log("  --dry-run       Report what would be closed without mutating Beads");
      console.log("  --strict        Fail on any GitHub API or bd error");
      console.log("  --owner <owner> Repository owner (defaults to git remote)");
      console.log("  --repo <repo>   Repository name (defaults to git remote)");
      process.exit(0);
      break;
    case "--":
      dashDash = true;
      break;
    default:
      if (arg.startsWith("-")) {
        console.error(`ERROR: unknown option: ${arg}`);
        process.exit(2);
      }
      taskIds.push(arg);
      break;
  }
}

if (taskIds.length === 0) {
  console.error(
    "Usage: npx tsx daemon/src/infra/pr-reconcile.cli.ts [--dry-run] [--strict] <task-id> [<task-id> ...]",
  );
  process.exit(2);
}

// ── Resolve owner/repo ──────────────────────────────────────────────────

if (!owner || !repo) {
  const remote = parseRemoteOrigin();
  if (!remote) {
    console.error("ERROR: Could not determine owner/repo. Use --owner and --repo flags.");
    process.exit(2);
  }
  owner ??= remote.owner;
  repo ??= remote.repo;
}

// ── Output formatting (extracted to reduce main() complexity) ────────────

function reportItem(item: ReconcileItemResult, strictMode: boolean): void {
  const line = `${item.taskId}: ${item.message}`;

  switch (item.status) {
    case "gh_error":
      if (strictMode) {
        console.error(`ERROR: ${line}`);
      } else {
        console.error(`${item.taskId}: WARN GitHub API query failed; reconciliation skipped`);
        console.log(`${item.taskId}: reconciliation skipped (GitHub API error)`);
      }
      break;
    case "bd_error":
      if (strictMode) {
        console.error(`ERROR: ${line}`);
      } else {
        console.error(`${item.taskId}: WARN bd close failed; continuing`);
        console.log(`${item.taskId}: merged PR found; FAILED to close in Beads`);
      }
      break;
    case "gh_missing":
      if (strictMode) {
        console.error(`ERROR: ${line}`);
      } else {
        console.error(`${item.taskId}: WARN GitHub API unavailable; reconciliation skipped (no-op)`);
        console.log(`${item.taskId}: reconciliation skipped (GitHub API unavailable)`);
      }
      break;
    default:
      console.log(line);
      break;
  }
}

// ── Run reconciliation (top-level await) ────────────────────────────────

try {
  const gh = createGitHubClient(owner!, repo!);
  const opts = defaultOptions({ dryRun, strict });
  const result = await reconcile(taskIds, opts, gh);

  for (const item of result.items) {
    reportItem(item, strict);
  }

  if (!result.success) {
    process.exit(2);
  }
} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
