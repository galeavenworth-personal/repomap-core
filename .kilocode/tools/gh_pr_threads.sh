#!/usr/bin/env bash
# gh_pr_threads.sh — Fetch PR review threads as structured payload for agent handoff
#
# Usage:
#   .kilocode/tools/gh_pr_threads.sh [PR_NUMBER]
#
# If PR_NUMBER is omitted, discovers the PR for the current branch.
#
# Output: JSON payload to stdout containing:
#   - PR metadata (number, title, branch, state)
#   - Review comments (file-level, threaded)
#   - PR-level review bodies
#   - Changed files list
#   - Issue-level comments
#
# Designed for zero-LLM-cost data gathering — run this, pipe output to a file,
# then hand the file to an orchestrator subtask.
#
# Implementation: delegates to TypeScript module in daemon/src/infra/pr-threads.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TSX="${REPO_ROOT}/daemon/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'npm install' in daemon/" >&2
  exit 1
fi

exec "$TSX" "$REPO_ROOT/daemon/src/infra/pr-threads.cli.ts" "$@"
