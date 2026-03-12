#!/usr/bin/env bash
# Reconcile Beads task state with merged GitHub PRs.
#
# Thin bootstrap wrapper — delegates to the TypeScript implementation.
# See: daemon/src/infra/pr-reconcile.ts
#
# Usage:
#   .kilocode/tools/bd_reconcile_merged_prs.sh <task-id> [<task-id> ...]
#   .kilocode/tools/bd_reconcile_merged_prs.sh --dry-run <task-id> [<task-id> ...]
#
# Options:
#   --dry-run   Do not mutate Beads; just report what would be closed.
#   --strict    Fail (exit 2) if `gh` is missing, `gh` queries fail, or `bd close` fails.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TS_CLI="${ROOT_DIR}/daemon/src/infra/pr-reconcile.cli.ts"

if [[ ! -f "${TS_CLI}" ]]; then
  echo "ERROR: TypeScript CLI not found: ${TS_CLI}" >&2
  exit 2
fi

TSX="${ROOT_DIR}/daemon/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'npm install' in daemon/" >&2
  exit 1
fi

exec "$TSX" "${TS_CLI}" "$@"
