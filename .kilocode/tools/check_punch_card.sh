#!/usr/bin/env bash
# Thin wrapper — delegates to TypeScript CLI via tsx.
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
export DOLT_DATABASE="${DOLT_DATABASE:-beads_repomap-core}"

exec npx --prefix "${REPO_ROOT}/daemon" tsx "${REPO_ROOT}/daemon/src/infra/punch-card-check.cli.ts" "$@"
