#!/usr/bin/env bash
# Initialize local Dolt punch-card schema state for repomap plant tooling.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOLT_BIN=~/.local/bin/dolt
DB_DIR="${ROOT_DIR}/.kilocode/dolt"
SCHEMA_FILE="${ROOT_DIR}/plans/punch-card-schema.sql"

if [[ ! -x "${DOLT_BIN}" ]]; then
  echo "ERROR: Dolt not found at ${DOLT_BIN}" >&2
  echo "Install it first (user-local, no sudo)." >&2
  exit 2
fi

if [[ -d "${DB_DIR}" ]]; then
  echo "Dolt DB already exists at ${DB_DIR}; skipping initialization."
  cd "${DB_DIR}"
  "${DOLT_BIN}" sql -q "SHOW TABLES"
  exit 0
fi

mkdir -p "${DB_DIR}"
cd "${DB_DIR}"

"${DOLT_BIN}" init --name "repomap-plant" --email "plant@repomap.local"

# Preferred path: run canonical schema command exactly.
if ! "${DOLT_BIN}" sql < "${SCHEMA_FILE}"; then
  echo "Canonical schema apply failed; applying compatibility fallback for this Dolt version." >&2

  # Table DDL section.
  sed -n '1,145p' "${SCHEMA_FILE}" | "${DOLT_BIN}" sql

  # View section; fallback to non-recursive view when recursive CTE-in-view is unsupported.
  if ! sed -n '147,185p' "${SCHEMA_FILE}" | "${DOLT_BIN}" sql; then
    "${DOLT_BIN}" sql -q "CREATE VIEW cost_aggregate AS SELECT task_id AS root_task_id, cost_usd AS total_cost_usd, 1 AS task_count, 0 AS max_depth FROM tasks"
  fi

  # Seed section.
  sed -n '187,220p' "${SCHEMA_FILE}" | "${DOLT_BIN}" sql
fi

"${DOLT_BIN}" add .
"${DOLT_BIN}" commit -m "Initialize punch card schema v1.0"

"${DOLT_BIN}" sql -q "SHOW TABLES"
