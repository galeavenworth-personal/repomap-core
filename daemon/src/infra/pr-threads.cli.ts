#!/usr/bin/env tsx
/**
 * CLI entry point for PR review thread fetching.
 *
 * Usage:
 *   npx tsx daemon/src/infra/pr-threads.cli.ts <PR_NUMBER> [--owner <owner>] [--repo <repo>]
 *
 * PR_NUMBER is required (auto-discovery removed; pass the PR number explicitly).
 * Owner and repo default to values parsed from `git remote get-url origin`.
 *
 * Output: JSON payload to stdout containing:
 *   - PR metadata (number, title, branch, state)
 *   - Review comments (file-level, threaded)
 *   - PR-level review bodies
 *   - Changed files list
 *   - Issue-level comments
 *
 * Exit codes:
 *   0  Success
 *   1  Error (no PR found, API failure, etc.)
 *
 * See: repomap-core-ovm.5
 */

import { execFileSync } from "node:child_process";
import { createGitHubClient } from "./github-client.js";
import { fetchPrThreads } from "./pr-threads.js";

/** Parse owner/repo from git remote origin URL. */
function parseRemoteOrigin(): { owner: string; repo: string } | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();

    // Match SSH (git@github.com:owner/repo.git) or HTTPS (https://github.com/owner/repo.git)
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): {
  prNumber: number | null;
  owner: string | null;
  repo: string | null;
  help: boolean;
} {
  let prNumber: number | null = null;
  let owner: string | null = null;
  let repo: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--owner" && i + 1 < argv.length) {
      owner = argv[++i];
    } else if (arg === "--repo" && i + 1 < argv.length) {
      repo = argv[++i];
    } else if (arg.startsWith("-")) {
      console.error(`WARN: unknown flag ignored: ${arg}`);
    } else if (prNumber === null) {
      const n = Number.parseInt(arg, 10);
      if (!Number.isNaN(n)) prNumber = n;
    }
  }

  return { prNumber, owner, repo, help };
}

async function main(): Promise<number> {
  const { prNumber, owner, repo, help } = parseArgs(process.argv.slice(2));

  if (help) {
    console.log("Usage: npx tsx daemon/src/infra/pr-threads.cli.ts <PR_NUMBER> [--owner <owner>] [--repo <repo>]");
    console.log("");
    console.log("Outputs structured JSON payload to stdout.");
    return 0;
  }

  if (prNumber === null) {
    console.error("ERROR: PR number is required. Usage: pr-threads.cli.ts <PR_NUMBER>");
    return 1;
  }

  // Resolve owner/repo from args or git remote
  let resolvedOwner = owner;
  let resolvedRepo = repo;
  if (!resolvedOwner || !resolvedRepo) {
    const remote = parseRemoteOrigin();
    if (!remote) {
      console.error("ERROR: Could not determine owner/repo. Use --owner and --repo flags.");
      return 1;
    }
    resolvedOwner ??= remote.owner;
    resolvedRepo ??= remote.repo;
  }

  try {
    const gh = createGitHubClient(resolvedOwner, resolvedRepo);
    const payload = await fetchPrThreads(prNumber, gh);
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${message}`);
    return 1;
  }
}

const exitCode = await main();
process.exit(exitCode);
