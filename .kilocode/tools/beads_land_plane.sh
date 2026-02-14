#!/usr/bin/env bash
# Orchestrate the “landing the plane” sequence for a Beads issue.
#
# Responsibilities:
# - Run canonical quality gates with bounded budgets (via bounded_gate.py)
# - Verify audit proof exists for all gates in .kilocode/gate_runs.jsonl
# - Close the bead (idempotent)
# - Sync Beads state (unless disabled)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

usage() {
  cat >&2 <<'EOF'
Usage:
  .kilocode/tools/beads_land_plane.sh --bead-id <id> [--skip-gates] [--no-sync]

Parameters:
  --bead-id <id>   (required)
  --skip-gates     Skip running gates; still requires audit proof exists.
  --no-sync        Skip bd sync at the end.
EOF
}

BEAD_ID=""
SKIP_GATES="false"
NO_SYNC="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bead-id)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --bead-id requires a value" >&2
        usage
        exit 2
      fi
      BEAD_ID="$2"
      shift 2
      ;;
    --skip-gates)
      SKIP_GATES="true"
      shift
      ;;
    --no-sync)
      NO_SYNC="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$BEAD_ID" ]]; then
  echo "ERROR: --bead-id is required" >&2
  usage
  exit 2
fi

"${ROOT_DIR}/.kilocode/tools/beads_preflight.sh"

RUN_TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"

GATES=(
  "ruff-format:60:30:${ROOT_DIR}/.venv/bin/python -m ruff format --check ."
  "ruff-check:60:30:${ROOT_DIR}/.venv/bin/python -m ruff check ."
  "mypy-src:120:60:${ROOT_DIR}/.venv/bin/python -m mypy src"
  "pytest:180:60:${ROOT_DIR}/.venv/bin/python -m pytest -q"
)

if [[ "$SKIP_GATES" != "true" ]]; then
  for gate in "${GATES[@]}"; do
    GATE_ID="${gate%%:*}"
    rest="${gate#*:}"
    TIMEOUT="${rest%%:*}"
    rest="${rest#*:}"
    STALL="${rest%%:*}"
    CMD="${rest#*:}"

    # NOTE: $CMD is intentionally word-split to form argv for bounded_gate.
    # shellcheck disable=SC2086
    if "${ROOT_DIR}/.venv/bin/python" "${ROOT_DIR}/.kilocode/tools/bounded_gate.py" \
      --gate-id "$GATE_ID" \
      --bead-id "$BEAD_ID" \
      --run-timestamp "$RUN_TIMESTAMP" \
      --timeout-seconds "$TIMEOUT" \
      --stall-seconds "$STALL" \
      --pass-through \
      --cwd "$ROOT_DIR" \
      -- $CMD; then
      :
    else
      rc=$?
      if [[ "$rc" -eq 2 ]]; then
        echo "ERROR: gate_faulted gate_id=${GATE_ID} rc=${rc}" >&2
        exit 2
      fi
      echo "ERROR: gate_failed gate_id=${GATE_ID} rc=${rc}" >&2
      exit 1
    fi
  done
fi

# Audit proof verification: require PASS records for all canonical gates.
if ! "${ROOT_DIR}/.venv/bin/python" -c "
import json, sys

bead_id = sys.argv[1]
required = {'ruff-format', 'ruff-check', 'mypy-src', 'pytest'}
found = set()

path = '${ROOT_DIR}/.kilocode/gate_runs.jsonl'
try:
    f = open(path)
except FileNotFoundError:
    print('audit_proof=MISSING reason=missing_gate_runs_jsonl', file=sys.stderr)
    sys.exit(1)

with f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get('bead_id') == bead_id and rec.get('status') == 'pass':
            found.add(rec.get('gate_id'))

missing = required - found
if missing:
    print(f'audit_proof=MISSING gates={sorted(missing)}', file=sys.stderr)
    sys.exit(1)

print(f'audit_proof=OK bead_id={bead_id}')
" "$BEAD_ID"; then
  exit 3
fi

"${ROOT_DIR}/.kilocode/tools/bd" close "$BEAD_ID" || true  # idempotent

SYNC_STATUS="YES"
if [[ "$NO_SYNC" != "true" ]]; then
  if ! "${ROOT_DIR}/.kilocode/tools/bd" sync; then
    echo "ERROR: bd sync failed" >&2
    exit 4
  fi
else
  SYNC_STATUS="SKIPPED"
fi

cat <<EOF
=== LAND PLANE SUMMARY ===
bead_id: ${BEAD_ID}
run_timestamp: ${RUN_TIMESTAMP}
gates: ALL PASS
audit_proof: OK
bead_closed: YES
sync: ${SYNC_STATUS}
===========================
EOF
