#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCHEMA_FILE="$REPO_ROOT/.kilocode/schema/punch-card-schema-migration.sql"

DOLT_BIN="${DOLT_BIN:-$(command -v dolt)}"
DOLT_HOST="${DOLT_HOST:-127.0.0.1}"
DOLT_PORT="${DOLT_PORT:-3307}"
DOLT_DATABASE="${DOLT_DATABASE:-plant}"

if [[ ! -x "$DOLT_BIN" ]]; then
  echo "ERROR: dolt CLI not found" >&2
  exit 1
fi

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "ERROR: schema migration file not found: $SCHEMA_FILE" >&2
  exit 1
fi

"$DOLT_BIN" --host "$DOLT_HOST" --port "$DOLT_PORT" --no-tls sql -q "CREATE DATABASE IF NOT EXISTS \`$DOLT_DATABASE\`"
"$DOLT_BIN" --host "$DOLT_HOST" --port "$DOLT_PORT" --no-tls --use-db "$DOLT_DATABASE" sql --file "$SCHEMA_FILE"

"$DOLT_BIN" --host "$DOLT_HOST" --port "$DOLT_PORT" --no-tls --use-db "$DOLT_DATABASE" sql -q "CALL DOLT_ADD('.')"
set +e
commit_output="$($DOLT_BIN --host "$DOLT_HOST" --port "$DOLT_PORT" --no-tls --use-db "$DOLT_DATABASE" sql -q "CALL DOLT_COMMIT('-Am', 'Apply punch card schema migration')" 2>&1)"
commit_status=$?
set -e

if [[ "$commit_status" -ne 0 ]] && [[ "$commit_output" != *"nothing to commit"* ]]; then
  echo "ERROR: Dolt commit failed" >&2
  echo "$commit_output" >&2
  exit "$commit_status"
fi
