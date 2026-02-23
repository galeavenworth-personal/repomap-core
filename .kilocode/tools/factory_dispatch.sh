#!/usr/bin/env bash
# =============================================================================
# factory_dispatch.sh — First-class factory kickoff tool
# =============================================================================
#
# Dispatches a prompt to a kilo serve session and monitors it to completion.
# This is the canonical way to kick off epics, health checks, and orchestrated
# multi-mode workflows through the plant manager or any orchestrator mode.
#
# Usage:
#   factory_dispatch.sh [OPTIONS] <prompt-file-or-string>
#
# Options:
#   -m, --mode MODE        Agent mode to dispatch to (default: plant-manager)
#   -t, --title TITLE      Session title (default: auto-generated)
#   -h, --host HOST        Kilo serve host (default: 127.0.0.1)
#   -p, --port PORT        Kilo serve port (default: 4096)
#   -w, --wait SECONDS     Max wait for completion (default: 600)
#   -q, --quiet            Suppress progress output, print only final result
#   --poll SECONDS         Poll interval (default: 10)
#   --no-monitor           Fire and forget — print session ID and exit
#   --json                 Output final result as JSON instead of text
#   --help                 Show this help
#
# Examples:
#   # Kick off attestation health check
#   factory_dispatch.sh -m plant-manager prompts/attestation.json
#
#   # Quick single-mode test
#   factory_dispatch.sh -m code "Reply with exactly: ALIVE"
#
#   # Fire and forget
#   factory_dispatch.sh --no-monitor -m plant-manager prompts/epic-42.json
#
# Prompt format:
#   If the argument is a file path ending in .json, it is read as a raw JSON
#   prompt body (must contain "parts" array, may contain "agent" override).
#   Otherwise, the argument is treated as a plain text prompt string.
#
# Exit codes:
#   0  Session completed successfully
#   1  Usage error or missing dependency
#   2  Health check failed (kilo serve not reachable)
#   3  Session creation failed
#   4  Prompt dispatch failed
#   5  Timeout waiting for completion
#   6  Session completed but no assistant response found
# =============================================================================

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────────────

MODE="plant-manager"
TITLE=""
HOST="127.0.0.1"
PORT="4096"
MAX_WAIT=600
POLL_INTERVAL=10
QUIET=false
NO_MONITOR=false
JSON_OUTPUT=false
PROMPT_ARG=""

# ─── Parse arguments ─────────────────────────────────────────────────────────

show_help() {
    sed -n '/^# Usage:/,/^# =====/p' "$0" | sed 's/^# \?//'
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -m|--mode)    MODE="$2"; shift 2 ;;
        -t|--title)   TITLE="$2"; shift 2 ;;
        -h|--host)    HOST="$2"; shift 2 ;;
        -p|--port)    PORT="$2"; shift 2 ;;
        -w|--wait)    MAX_WAIT="$2"; shift 2 ;;
        -q|--quiet)   QUIET=true; shift ;;
        --poll)       POLL_INTERVAL="$2"; shift 2 ;;
        --no-monitor) NO_MONITOR=true; shift ;;
        --json)       JSON_OUTPUT=true; shift ;;
        --help)       show_help ;;
        -*)           echo "ERROR: Unknown option: $1" >&2; exit 1 ;;
        *)            PROMPT_ARG="$1"; shift ;;
    esac
done

if [[ -z "$PROMPT_ARG" ]]; then
    echo "ERROR: No prompt provided. Use --help for usage." >&2
    exit 1
fi

BASE_URL="http://${HOST}:${PORT}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() {
    if [[ "$QUIET" != true ]]; then
        echo "[factory] $*" >&2
    fi
}

timestamp() {
    date '+%H:%M:%S'
}

require_cmd() {
    if ! command -v "$1" &>/dev/null; then
        echo "ERROR: Required command not found: $1" >&2
        exit 1
    fi
}

require_cmd curl
require_cmd python3

# ─── Phase 1: Health check ───────────────────────────────────────────────────

log "$(timestamp) Checking kilo serve at ${BASE_URL}..."

HEALTH=$(curl -sf "${BASE_URL}/global/health" 2>/dev/null || true)
if [[ -z "$HEALTH" ]]; then
    echo "ERROR: kilo serve not reachable at ${BASE_URL}" >&2
    echo "Start the stack first: cd daemon && npm run stack" >&2
    exit 2
fi

VERSION=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
log "$(timestamp) Connected to kilo serve v${VERSION}"

# ─── Phase 2: Build prompt payload ───────────────────────────────────────────

PROMPT_FILE=$(mktemp /tmp/factory-dispatch-XXXXXX.json)
trap 'rm -f "$PROMPT_FILE"' EXIT

if [[ "$PROMPT_ARG" == *.json ]] && [[ -f "$PROMPT_ARG" ]]; then
    # JSON file — read it, inject agent if not present
    HAS_AGENT=$(python3 - "$PROMPT_ARG" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1]))
print('yes' if 'agent' in data else 'no')
PYEOF
    ) 2>/dev/null || echo "no"

    if [[ "$HAS_AGENT" == "yes" ]]; then
        cp "$PROMPT_ARG" "$PROMPT_FILE"
    else
        python3 - "$PROMPT_ARG" "$MODE" "$PROMPT_FILE" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
data['agent'] = sys.argv[2]
with open(sys.argv[3], 'w') as f:
    json.dump(data, f)
PYEOF
    fi
    log "$(timestamp) Loaded prompt from: $PROMPT_ARG"
else
    # Plain text string — wrap it
    python3 - "$MODE" "$PROMPT_ARG" "$PROMPT_FILE" <<'PYEOF'
import json, sys
payload = {
    'agent': sys.argv[1],
    'parts': [{'type': 'text', 'text': sys.argv[2]}]
}
with open(sys.argv[3], 'w') as f:
    json.dump(payload, f)
PYEOF
    log "$(timestamp) Built prompt from string (${#PROMPT_ARG} chars)"
fi

# ─── Phase 3: Create session ─────────────────────────────────────────────────

if [[ -z "$TITLE" ]]; then
    TITLE="factory: ${MODE} @ $(date '+%Y-%m-%d %H:%M')"
fi

SESSION_BODY=$(python3 - "$TITLE" <<'PYEOF'
import json, sys
print(json.dumps({"title": sys.argv[1]}))
PYEOF
)

SESSION_ID=$(curl -sf -X POST "${BASE_URL}/session" \
    -H 'Content-Type: application/json' \
    -d "$SESSION_BODY" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

if [[ -z "$SESSION_ID" ]]; then
    echo "ERROR: Failed to create session" >&2
    exit 3
fi

log "$(timestamp) Session created: ${SESSION_ID}"
log "$(timestamp) Title: ${TITLE}"

# ─── Phase 4: Dispatch prompt ────────────────────────────────────────────────

HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST "${BASE_URL}/session/${SESSION_ID}/prompt_async" \
    -H 'Content-Type: application/json' \
    -d @"$PROMPT_FILE" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "202" && "$HTTP_CODE" != "204" ]]; then
    echo "ERROR: Prompt dispatch failed (HTTP ${HTTP_CODE})" >&2
    exit 4
fi

log "$(timestamp) Prompt dispatched to mode: ${MODE}"

# ─── Phase 5: Early exit if no-monitor ───────────────────────────────────────

if [[ "$NO_MONITOR" == true ]]; then
    if [[ "$JSON_OUTPUT" == true ]]; then
        python3 - "$SESSION_ID" "$MODE" "$TITLE" <<'PYEOF'
import json, sys
print(json.dumps({"session_id": sys.argv[1], "mode": sys.argv[2], "title": sys.argv[3]}))
PYEOF
    else
        echo "$SESSION_ID"
    fi
    exit 0
fi

# ─── Phase 6: Monitor for completion ─────────────────────────────────────────

log "$(timestamp) Monitoring session (poll=${POLL_INTERVAL}s, timeout=${MAX_WAIT}s)..."

ELAPSED=0
LAST_CHILDREN=0

while [[ $ELAPSED -lt $MAX_WAIT ]]; do
    sleep "$POLL_INTERVAL"
    ELAPSED=$((ELAPSED + POLL_INTERVAL))

    # Check if any sessions are busy
    BUSY=$(curl -sf "${BASE_URL}/session/status" 2>/dev/null \
        | python3 -c "
import sys, json
data = json.load(sys.stdin)
busy = sum(1 for s in data.values() if s.get('type') == 'busy')
print(busy)
" 2>/dev/null || echo "-1")

    # Count children
    CHILDREN=$(curl -sf "${BASE_URL}/session/${SESSION_ID}/children" 2>/dev/null \
        | python3 -c "
import sys, json
children = json.load(sys.stdin)
print(len(children))
" 2>/dev/null || echo "0")

    if [[ "$CHILDREN" != "$LAST_CHILDREN" ]]; then
        log "$(timestamp) Children spawned: ${CHILDREN} (was ${LAST_CHILDREN})"
        LAST_CHILDREN="$CHILDREN"
    fi

    if [[ "$BUSY" == "0" ]]; then
        log "$(timestamp) All sessions idle — completed in ${ELAPSED}s"
        break
    elif [[ "$BUSY" == "-1" ]]; then
        log "$(timestamp) [${ELAPSED}s] Warning: status check failed, retrying..."
    else
        log "$(timestamp) [${ELAPSED}s] Busy sessions: ${BUSY}, children: ${CHILDREN}"
    fi
done

if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo "ERROR: Timeout after ${MAX_WAIT}s (session may still be running: ${SESSION_ID})" >&2
    exit 5
fi

# ─── Phase 7: Extract result ─────────────────────────────────────────────────

RESULT=$(curl -sf "${BASE_URL}/session/${SESSION_ID}/message" 2>/dev/null \
    | python3 -c "
import sys, json

messages = json.load(sys.stdin)
# Find the last assistant message with substantial text
for msg in reversed(messages):
    info = msg.get('info', {})
    if info.get('role') != 'assistant':
        continue
    for part in msg.get('parts', []):
        if part.get('type') == 'text' and len(part.get('text', '')) > 100:
            print(part['text'])
            sys.exit(0)

# Fallback: any assistant text at all
for msg in reversed(messages):
    info = msg.get('info', {})
    if info.get('role') != 'assistant':
        continue
    for part in msg.get('parts', []):
        if part.get('type') == 'text' and part.get('text', '').strip():
            print(part['text'])
            sys.exit(0)

sys.exit(1)
" 2>/dev/null)

if [[ -z "$RESULT" ]]; then
    echo "ERROR: Session completed but no assistant response found" >&2
    echo "Session ID: ${SESSION_ID}" >&2
    exit 6
fi

# ─── Phase 8: Output ─────────────────────────────────────────────────────────

if [[ "$JSON_OUTPUT" == true ]]; then
    python3 - "$SESSION_ID" "$MODE" "$TITLE" "$LAST_CHILDREN" "$ELAPSED" "$RESULT" <<'PYEOF'
import json, sys
result = {
    'session_id': sys.argv[1],
    'mode': sys.argv[2],
    'title': sys.argv[3],
    'children': int(sys.argv[4]),
    'elapsed_seconds': int(sys.argv[5]),
    'result': sys.argv[6]
}
print(json.dumps(result, indent=2))
PYEOF
else
    echo "$RESULT"
fi

log "$(timestamp) Done. Session: ${SESSION_ID} | Children: ${LAST_CHILDREN} | Elapsed: ${ELAPSED}s"
