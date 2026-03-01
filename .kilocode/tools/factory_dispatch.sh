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

# ─── Phase 1: Full stack pre-flight check ────────────────────────────────────
# ALL 5 components must be running. No exceptions. No partial stacks.
# This prevents unrecorded sessions and wasted spend.

DOLT_PORT="${DOLT_PORT:-3307}"
PREFLIGHT_OK=true
PREFLIGHT_MISSING=""

log "$(timestamp) Pre-flight: checking all 5 stack components..."

# 1. kilo serve
HEALTH=$(curl -sf "${BASE_URL}/session" 2>/dev/null || true)
if [[ -z "$HEALTH" ]]; then
    PREFLIGHT_OK=false
    PREFLIGHT_MISSING="${PREFLIGHT_MISSING}  ❌ kilo serve: NOT reachable at ${BASE_URL}\n"
else
    SESSION_COUNT=$(echo "$HEALTH" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
    log "$(timestamp)   ✅ kilo serve (${SESSION_COUNT} sessions)"
fi

# 2. Dolt server
if ss -tlnp 2>/dev/null | grep -q ":${DOLT_PORT} "; then
    log "$(timestamp)   ✅ Dolt server (port ${DOLT_PORT})"
else
    PREFLIGHT_OK=false
    PREFLIGHT_MISSING="${PREFLIGHT_MISSING}  ❌ Dolt server: NOT listening on port ${DOLT_PORT}\n"
fi

# 3. oc-daemon (flight recorder)
if pgrep -f "tsx.*oc-daemon/src/index.ts" >/dev/null 2>&1 || \
   pgrep -f "node.*oc-daemon/build/index.js" >/dev/null 2>&1; then
    log "$(timestamp)   ✅ oc-daemon (SSE → Dolt)"
else
    PREFLIGHT_OK=false
    PREFLIGHT_MISSING="${PREFLIGHT_MISSING}  ❌ oc-daemon: NOT running (no flight recorder — sessions will be unrecorded!)\n"
fi

# 4. Temporal server
TEMPORAL_PORT="${TEMPORAL_PORT:-7233}"
if ss -tlnp 2>/dev/null | grep -q ":${TEMPORAL_PORT} "; then
    log "$(timestamp)   ✅ Temporal server (port ${TEMPORAL_PORT})"
else
    PREFLIGHT_OK=false
    PREFLIGHT_MISSING="${PREFLIGHT_MISSING}  ❌ Temporal server: NOT listening on port ${TEMPORAL_PORT}\n"
fi

# 5. Temporal worker
if pgrep -f "tsx.*src/temporal/worker.ts" >/dev/null 2>&1; then
    log "$(timestamp)   ✅ Temporal worker"
else
    PREFLIGHT_OK=false
    PREFLIGHT_MISSING="${PREFLIGHT_MISSING}  ❌ Temporal worker: NOT running\n"
fi

if [[ "$PREFLIGHT_OK" != true ]]; then
    echo "" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    echo " DISPATCH BLOCKED — Stack is incomplete" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    echo -e "$PREFLIGHT_MISSING" >&2
    echo "Start the full stack first:" >&2
    echo "  .kilocode/tools/start-stack.sh" >&2
    echo "" >&2
    echo "Or check status with:" >&2
    echo "  .kilocode/tools/start-stack.sh --check" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    exit 2
fi

log "$(timestamp) Pre-flight passed (5/5 components healthy)"

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

# Use async prompt endpoint (POST /session/{id}/prompt_async) so that the
# curl returns immediately and the monitoring loop can track progress.
# The sync endpoint (POST /session/{id}/message) blocks until the agent
# finishes — which defeats the purpose of the polling loop.
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST "${BASE_URL}/session/${SESSION_ID}/prompt_async" \
    -H 'Content-Type: application/json' \
    -d @"$PROMPT_FILE" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" && "$HTTP_CODE" != "204" ]]; then
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

    # Check session messages to determine if processing is complete.
    # A session is done when it has assistant content with a step-finish part
    # and no running tools.
    DONE=$(curl -sf "${BASE_URL}/session/${SESSION_ID}/message" 2>/dev/null \
        | python3 -c "
import sys, json
messages = json.load(sys.stdin)
has_assistant = False
has_running_tools = False
for msg in messages:
    info = msg.get('info', {})
    if info.get('role') == 'assistant':
        has_assistant = True
    for part in msg.get('parts', []):
        if part.get('type') == 'tool':
            state = part.get('state', {})
            if state.get('status') in ('running', 'pending'):
                has_running_tools = True
        if part.get('type') == 'step-finish':
            has_assistant = True
if has_assistant and not has_running_tools:
    print('yes')
else:
    print('no')
" 2>/dev/null || echo "error")

    if [[ "$DONE" == "yes" ]]; then
        # Also verify all children are done (no running tools)
        ALL_CHILDREN_DONE=true
        if [[ "$CHILDREN" -gt 0 ]]; then
            CHILD_IDS=$(curl -sf "${BASE_URL}/session/${SESSION_ID}/children" 2>/dev/null \
                | python3 -c "import sys,json; [print(c['id']) for c in json.load(sys.stdin)]" 2>/dev/null)
            while IFS= read -r cid; do
                [[ -z "$cid" ]] && continue
                CHILD_DONE=$(curl -sf "${BASE_URL}/session/${cid}/message" 2>/dev/null \
                    | python3 -c "
import sys, json
msgs = json.load(sys.stdin)
running = any(
    p.get('state',{}).get('status') in ('running','pending')
    for m in msgs for p in m.get('parts',[]) if p.get('type')=='tool'
)
print('no' if running else 'yes')
" 2>/dev/null || echo "no")
                if [[ "$CHILD_DONE" != "yes" ]]; then
                    ALL_CHILDREN_DONE=false
                    break
                fi
            done <<< "$CHILD_IDS"
        fi

        if [[ "$ALL_CHILDREN_DONE" == true ]]; then
            log "$(timestamp) All sessions idle — completed in ${ELAPSED}s"
            break
        fi
    fi

    if [[ "$DONE" == "error" ]]; then
        log "$(timestamp) [${ELAPSED}s] Warning: status check failed, retrying..."
    else
        log "$(timestamp) [${ELAPSED}s] Parent done: ${DONE}, children: ${CHILDREN}"
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
