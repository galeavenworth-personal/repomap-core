#!/usr/bin/env bash
# Thin wrapper — delegates to TypeScript CLI via tsx.
# See: daemon/src/infra/punch-card-audit.cli.ts
#
# Usage: audit_punch_cards.sh [limit]
#
# Exit codes match the TypeScript CLI:
#   0  All audited tasks passed
#   1  One or more tasks failed or errored
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

exec "$TSX" "${REPO_ROOT}/daemon/src/infra/punch-card-audit.cli.ts" "$@"
