#!/usr/bin/env bash
# Initialize compiled_prompts schema in the shared Dolt punch_cards database.

set -euo pipefail

DOLT_DATA_DIR="${HOME}/.dolt-data/beads"

if ! command -v dolt >/dev/null 2>&1; then
  echo "ERROR: dolt not found in PATH (which dolt failed)" >&2
  exit 2
fi

DOLT_BIN="$(command -v dolt)"

if [[ ! -d "${DOLT_DATA_DIR}" ]]; then
  echo "ERROR: Dolt data dir not found: ${DOLT_DATA_DIR}" >&2
  exit 4
fi

cd "${DOLT_DATA_DIR}"

"${DOLT_BIN}" sql -q "CREATE DATABASE IF NOT EXISTS punch_cards"

"${DOLT_BIN}" sql <<'SQL'
USE punch_cards;

CREATE TABLE IF NOT EXISTS compiled_prompts (
    prompt_id VARCHAR(100) NOT NULL PRIMARY KEY,
    module_name VARCHAR(100) NOT NULL,
    signature_name VARCHAR(100) NOT NULL,
    compiled_prompt TEXT NOT NULL,
    compiled_at DATETIME NOT NULL,
    dspy_version VARCHAR(20) NOT NULL
);
SQL

"${DOLT_BIN}" sql -q "SHOW TABLES FROM punch_cards"

