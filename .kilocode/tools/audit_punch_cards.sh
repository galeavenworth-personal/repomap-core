#!/usr/bin/env bash

set -euo pipefail

DOLT_HOST="${DOLT_HOST:-127.0.0.1}"
DOLT_PORT="${DOLT_PORT:-3307}"
DOLT_DATABASE="${DOLT_DATABASE:-beads_repomap-core}"
LIMIT="${1:-50}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="${SCRIPT_DIR}/check_punch_card.sh"

if [[ ! -x "$CHECKER" ]]; then
  echo "ERROR: missing executable checker at ${CHECKER}" >&2
  exit 2
fi

if [[ ! "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: limit must be a positive integer" >&2
  exit 2
fi

ENGINE=""
if command -v mysql >/dev/null 2>&1; then
  ENGINE="mysql"
elif command -v dolt >/dev/null 2>&1; then
  ENGINE="dolt"
else
  echo "ERROR: neither mysql nor dolt CLI found" >&2
  exit 2
fi

run_sql() {
  local query="$1"

  if [[ "$ENGINE" == "mysql" ]]; then
    mysql \
      --protocol=TCP \
      --host="$DOLT_HOST" \
      --port="$DOLT_PORT" \
      --database="$DOLT_DATABASE" \
      --ssl-mode=DISABLED \
      --batch \
      --skip-column-names \
      --raw \
      --execute "$query"
    return
  fi

  dolt --host "$DOLT_HOST" --port "$DOLT_PORT" --no-tls sql \
    --query "USE \`${DOLT_DATABASE}\`; ${query}" \
    --result-format csv
}

QUERY="
SELECT task_id, card_id
FROM (
  SELECT t.task_id AS task_id, t.punch_card_id AS card_id, t.started_at AS observed_at
  FROM tasks t
  WHERE t.punch_card_id IS NOT NULL
    AND t.punch_card_id <> ''

  UNION ALL

  SELECT c.task_id AS task_id, c.card_id AS card_id, c.validated_at AS observed_at
  FROM checkpoints c
  WHERE c.card_id IS NOT NULL
    AND c.card_id <> ''
) ranked
ORDER BY observed_at DESC
LIMIT ${LIMIT}
"

set +e
RAW="$(run_sql "$QUERY" 2>&1)"
CODE=$?
set -e
if [[ $CODE -ne 0 ]]; then
  echo "$RAW" >&2
  echo "ERROR: failed to query tasks" >&2
  exit 2
fi

declare -a TASK_ROWS=()
if [[ "$ENGINE" == "mysql" ]]; then
  while IFS=$'\t' read -r task_id card_id; do
    [[ -z "${task_id:-}" || -z "${card_id:-}" ]] && continue
    TASK_ROWS+=("${task_id}|${card_id}")
  done <<< "$RAW"
else
  while IFS=',' read -r task_id card_id; do
    [[ "$task_id" == "task_id" ]] && continue
    task_id="${task_id%$'\r'}"
    card_id="${card_id%$'\r'}"
    [[ -z "${task_id:-}" || -z "${card_id:-}" ]] && continue
    TASK_ROWS+=("${task_id}|${card_id}")
  done <<< "$RAW"
fi

if [[ ${#TASK_ROWS[@]} -eq 0 ]]; then
  echo "No tasks with punch cards found for audit."
  exit 0
fi

PASS_COUNT=0
FAIL_COUNT=0
ERROR_COUNT=0

echo "Punch card audit (${#TASK_ROWS[@]} tasks, engine=${ENGINE})"

for row in "${TASK_ROWS[@]}"; do
  IFS='|' read -r task_id card_id <<< "$row"

  set +e
  "$CHECKER" "$task_id" "$card_id" >/tmp/punch-audit-${task_id}.log 2>&1
  rc=$?
  set -e

  if [[ $rc -eq 0 ]]; then
    echo "✅ ${task_id} (${card_id})"
    PASS_COUNT=$((PASS_COUNT + 1))
  elif [[ $rc -eq 1 ]]; then
    echo "❌ ${task_id} (${card_id})"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    echo "🚫 ${task_id} (${card_id})"
    ERROR_COUNT=$((ERROR_COUNT + 1))
  fi
done

echo "Summary: pass=${PASS_COUNT} fail=${FAIL_COUNT} error=${ERROR_COUNT}" >&2

if [[ $FAIL_COUNT -gt 0 || $ERROR_COUNT -gt 0 ]]; then
  exit 1
fi

exit 0
