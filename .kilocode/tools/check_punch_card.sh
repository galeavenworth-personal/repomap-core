#!/usr/bin/env bash
# Thin wrapper — delegates to TypeScript CLI via tsx.
# The CLI now uses the kilo-verified validator (event-log replay + classifier).
# See: daemon/src/infra/punch-card-check.cli.ts
#
# Usage: check_punch_card.sh [--parent-session UUID] [--enforced-only] <session_id> <card_id>
#
# Exit codes match the TypeScript CLI:
#   0  PASS — all requirements satisfied
#   1  FAIL — one or more requirements violated
#   2  Usage error or query failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Export Dolt connection env vars for the TS CLI
export DOLT_HOST="${DOLT_HOST:-127.0.0.1}"
export DOLT_PORT="${DOLT_PORT:-3307}"
export DOLT_DATABASE="${DOLT_DATABASE:-factory}"

TSX="${REPO_ROOT}/daemon/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'npm install' in daemon/" >&2
  exit 1
fi

exec "$TSX" "${REPO_ROOT}/daemon/src/infra/punch-card-check.cli.ts" "$@"
