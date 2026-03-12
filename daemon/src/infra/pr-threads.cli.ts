#!/usr/bin/env tsx
/**
 * CLI entry point for PR review thread fetching.
 *
 * Usage:
 *   npx tsx daemon/src/infra/pr-threads.cli.ts [PR_NUMBER]
 *
 * If PR_NUMBER is omitted, discovers the PR for the current branch.
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
 *   1  Error (no PR found, gh CLI failure, etc.)
 */

import { fetchPrThreads } from "./pr-threads.js";

function main(): number {
  const arg = process.argv[2];
  let prNumber: number | null = null;

  if (arg === "--help" || arg === "-h") {
    console.log("Usage: npx tsx daemon/src/infra/pr-threads.cli.ts [PR_NUMBER]");
    console.log("");
    console.log("If PR_NUMBER is omitted, discovers the PR for the current branch.");
    console.log("Outputs structured JSON payload to stdout.");
    return 0;
  }

  if (arg !== undefined) {
    prNumber = Number.parseInt(arg, 10);
    if (Number.isNaN(prNumber)) {
      console.error(`ERROR: Invalid PR number: '${arg}'`);
      return 1;
    }
  }

  try {
    const payload = fetchPrThreads(prNumber);
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${message}`);
    return 1;
  }
}

const code = main();
process.exit(code);
