#!/usr/bin/env bash
# Apply SQL migration file to the punch_cards database.
#
# This is a thin wrapper that delegates to the TypeScript implementation.
# The TS module reads .kilocode/schema/punch-card-schema-migration.sql and
# applies it via mysql2 protocol (no dolt CLI dependency).
#
# See: daemon/src/infra/dolt-schema.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SCHEMA_FILE="${1:-.kilocode/schema/punch-card-schema-migration.sql}"
COMMIT_MSG="${2:-Apply punch card schema migration}"

# Ensure Dolt server is running
"$SCRIPT_DIR/dolt_start.sh"

# Delegate to TypeScript implementation
export REPO_ROOT
export DOLT_DATABASE="${DOLT_DATABASE:-factory}"

TSX="${REPO_ROOT}/daemon/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'npm install' in daemon/" >&2
  exit 1
fi

# Step 1: Ensure base schema (8 tables with all columns, 1 view, seed data)
"$TSX" "$REPO_ROOT/daemon/src/infra/dolt-schema.cli.ts" init

# Step 2: Apply incremental migration (punch card upserts, new cards, etc.)
exec "$TSX" "$REPO_ROOT/daemon/src/infra/dolt-schema.cli.ts" migrate "$SCHEMA_FILE" "$COMMIT_MSG"
