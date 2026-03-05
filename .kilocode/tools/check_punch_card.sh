#!/usr/bin/env bash

set -euo pipefail

DOLT_HOST="${DOLT_HOST:-127.0.0.1}"
DOLT_PORT="${DOLT_PORT:-3307}"
DOLT_DATABASE="${DOLT_DATABASE:-plant}"

usage() {
  echo "Usage: $0 <session_id> <card_id>" >&2
}

die() {
  echo "ERROR: $*" >&2
  exit 2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

SESSION_ID="$1"
CARD_ID="$2"

if [[ ! "$SESSION_ID" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  die "invalid session_id '$SESSION_ID'"
fi

if [[ ! "$CARD_ID" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  die "invalid card_id '$CARD_ID'"
fi

SQL_ENGINE=""

if command -v mysql >/dev/null 2>&1; then
  SQL_ENGINE="mysql"
elif command -v dolt >/dev/null 2>&1; then
  SQL_ENGINE="dolt"
else
  die "neither mysql nor dolt CLI found"
fi

sql_escape() {
  local value="$1"
  printf "%s" "${value//\'/\'\'}"
}

run_sql() {
  local query="$1"

  if [[ "$SQL_ENGINE" == "mysql" ]]; then
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

  local wrapped_query
  wrapped_query="USE ${DOLT_DATABASE}; ${query}"
  dolt \
    --host "$DOLT_HOST" \
    --port "$DOLT_PORT" \
    --no-tls \
    sql \
    --query "$wrapped_query" \
    --result-format csv
}

parse_requirements() {
  local raw="$1"
  local -n out_ref="$2"

  if [[ "$SQL_ENGINE" == "mysql" ]]; then
    while IFS=$'\t' read -r forbidden required punch_type punch_key_pattern description; do
      [[ -z "${punch_type:-}" ]] && continue
      out_ref+=("${forbidden}|${required}|${punch_type}|${punch_key_pattern}|${description:-}")
    done <<< "$raw"
    return
  fi

  while IFS=',' read -r forbidden required punch_type punch_key_pattern description; do
    [[ "$forbidden" == "forbidden" ]] && continue
    [[ -z "${punch_type:-}" ]] && continue
    forbidden="${forbidden%$'\r'}"
    required="${required%$'\r'}"
    punch_type="${punch_type%$'\r'}"
    punch_key_pattern="${punch_key_pattern%$'\r'}"
    description="${description%$'\r'}"
    out_ref+=("${forbidden}|${required}|${punch_type}|${punch_key_pattern}|${description:-}")
  done <<< "$raw"
}

normalize_bool() {
  local value="${1,,}"
  case "$value" in
    1|true|t|yes|y) echo "1" ;;
    *) echo "0" ;;
  esac
}

SESSION_SQL="$(sql_escape "$SESSION_ID")"
CARD_SQL="$(sql_escape "$CARD_ID")"

REQ_QUERY="SELECT forbidden, required, punch_type, punch_key_pattern, COALESCE(description, '') FROM punch_cards WHERE card_id = '${CARD_SQL}' ORDER BY forbidden DESC, required DESC, punch_type, punch_key_pattern"

set +e
REQ_RAW="$(run_sql "$REQ_QUERY" 2>&1)"
REQ_CODE=$?
set -e
if [[ $REQ_CODE -ne 0 ]]; then
  echo "$REQ_RAW" >&2
  die "failed to query punch_cards"
fi

declare -a REQUIREMENTS=()
parse_requirements "$REQ_RAW" REQUIREMENTS

if [[ ${#REQUIREMENTS[@]} -eq 0 ]]; then
  die "no requirements found for card '${CARD_ID}'"
fi

echo "Punch Card Check"
echo "- Session: ${SESSION_ID}"
echo "- Card: ${CARD_ID}"
echo "- Engine: ${SQL_ENGINE}"

FAILURES=0

for requirement in "${REQUIREMENTS[@]}"; do
  IFS='|' read -r forbidden required punch_type punch_key_pattern description <<< "$requirement"

  forbidden_bool="$(normalize_bool "$forbidden")"
  required_bool="$(normalize_bool "$required")"

  if [[ "$required_bool" != "1" && "$forbidden_bool" != "1" ]]; then
    continue
  fi

  TYPE_SQL="$(sql_escape "$punch_type")"
  PATTERN_SQL="$(sql_escape "$punch_key_pattern")"

  COUNT_QUERY="SELECT COUNT(*) FROM punches WHERE task_id = '${SESSION_SQL}' AND punch_type = '${TYPE_SQL}' AND punch_key LIKE '${PATTERN_SQL}'"

  set +e
  COUNT_RAW="$(run_sql "$COUNT_QUERY" 2>&1)"
  COUNT_CODE=$?
  set -e
  if [[ $COUNT_CODE -ne 0 ]]; then
    echo "$COUNT_RAW" >&2
    die "failed to query punches"
  fi

  if [[ "$SQL_ENGINE" == "dolt" ]]; then
    COUNT_VALUE="$(printf "%s\n" "$COUNT_RAW" | tail -n 1 | tr -d '\r')"
  else
    COUNT_VALUE="$(printf "%s" "$COUNT_RAW" | tr -d '\r')"
  fi

  if [[ ! "$COUNT_VALUE" =~ ^[0-9]+$ ]]; then
    echo "Raw count output: $COUNT_RAW" >&2
    die "unexpected count query output"
  fi

  if [[ "$forbidden_bool" == "1" ]]; then
    if [[ "$COUNT_VALUE" -eq 0 ]]; then
      echo "✅ FORBIDDEN ${punch_type}:${punch_key_pattern} absent${description:+ — ${description}}"
    else
      echo "🚫 FORBIDDEN ${punch_type}:${punch_key_pattern} observed ${COUNT_VALUE} time(s)${description:+ — ${description}}"
      FAILURES=$((FAILURES + 1))
    fi
    continue
  fi

  if [[ "$COUNT_VALUE" -gt 0 ]]; then
    echo "✅ REQUIRED ${punch_type}:${punch_key_pattern} satisfied (${COUNT_VALUE})${description:+ — ${description}}"
  else
    echo "❌ REQUIRED ${punch_type}:${punch_key_pattern} missing${description:+ — ${description}}"
    FAILURES=$((FAILURES + 1))
  fi
done

if [[ "$FAILURES" -eq 0 ]]; then
  echo "PASS: card requirements satisfied"
  exit 0
fi

echo "FAIL: ${FAILURES} requirement(s) violated"
exit 1
