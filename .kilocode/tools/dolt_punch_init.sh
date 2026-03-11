#!/usr/bin/env bash
# Initialize/repair punch_cards schema in the shared Dolt beads repository.
#
# This is a thin wrapper that delegates to the TypeScript implementation.
# The TS module creates 8 tables, 1 view, and seeds 11 punch card definitions
# via mysql2 protocol (no dolt CLI dependency).
#
# See: daemon/src/infra/dolt-schema.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Ensure Dolt server is running
"$SCRIPT_DIR/dolt_start.sh"

# Delegate to TypeScript implementation
export REPO_ROOT
TSX="${REPO_ROOT}/daemon/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'npm install' in daemon/" >&2
  exit 1
fi

exec "$TSX" "$REPO_ROOT/daemon/src/infra/dolt-schema.cli.ts" init
