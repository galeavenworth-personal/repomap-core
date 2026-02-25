#!/usr/bin/env bash
# Initialize local Dolt punch-card schema state for repomap plant tooling.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOLT_BIN=~/.local/bin/dolt
DB_DIR="${ROOT_DIR}/.kilocode/dolt"
SCHEMA_FILE="${ROOT_DIR}/.kilocode/schema/punch-card-schema.sql"

extract_sql_section() {
  local file="$1"
  local start_marker="$2"
  local end_marker="$3"

  awk -v start="${start_marker}" -v end="${end_marker}" '
    $0 == start {in_section=1; next}
    $0 == end {in_section=0; exit}
    in_section {print}
  ' "${file}"
}

if [[ ! -x "${DOLT_BIN}" ]]; then
  echo "ERROR: Dolt not found at ${DOLT_BIN}" >&2
  echo "Install it first (user-local, no sudo)." >&2
  exit 2
fi

if [[ ! -f "${SCHEMA_FILE}" ]]; then
  echo "ERROR: Schema file not found at ${SCHEMA_FILE}" >&2
  echo "Ensure punch-card-schema.sql exists before running dolt_init." >&2
  exit 3
fi

if [[ -d "${DB_DIR}/.dolt" ]]; then
  echo "Dolt DB already exists at ${DB_DIR}; skipping initialization."
  cd "${DB_DIR}"
  "${DOLT_BIN}" sql -q "SHOW TABLES"
  exit 0
fi

if [[ -d "${DB_DIR}" ]]; then
  echo "ERROR: ${DB_DIR} exists but is not a Dolt repository (.dolt missing)." >&2
  echo "Remove or rename ${DB_DIR}, then rerun dolt_init." >&2
  exit 4
fi

mkdir -p "${DB_DIR}"
cd "${DB_DIR}"

"${DOLT_BIN}" init --name "repomap-plant" --email "plant@repomap.local"

# Preferred path: run canonical schema command exactly.
if ! "${DOLT_BIN}" sql < "${SCHEMA_FILE}"; then
  echo "Canonical schema apply failed; applying compatibility fallback for this Dolt version." >&2

  # Table DDL section.
  extract_sql_section \
    "${SCHEMA_FILE}" \
    "-- PUNCH_CARD_SCHEMA TABLES START" \
    "-- PUNCH_CARD_SCHEMA TABLES END" \
    | "${DOLT_BIN}" sql

  # View section; fallback to non-recursive view when recursive CTE-in-view is unsupported.
  if ! extract_sql_section \
    "${SCHEMA_FILE}" \
    "-- PUNCH_CARD_SCHEMA VIEWS START" \
    "-- PUNCH_CARD_SCHEMA VIEWS END" \
    | "${DOLT_BIN}" sql; then
    "${DOLT_BIN}" sql -q "CREATE VIEW cost_aggregate AS SELECT task_id AS root_task_id, cost_usd AS total_cost_usd, 1 AS task_count, 0 AS max_depth FROM tasks"
  fi

  # Seed section.
  extract_sql_section \
    "${SCHEMA_FILE}" \
    "-- PUNCH_CARD_SCHEMA SEEDS START" \
    "-- PUNCH_CARD_SCHEMA SEEDS END" \
    | "${DOLT_BIN}" sql
fi

"${DOLT_BIN}" add .
"${DOLT_BIN}" commit -m "Initialize punch card schema v1.0"

"${DOLT_BIN}" sql -q "SHOW TABLES"
