#!/usr/bin/env bash
# =============================================================================
# start-stack.sh — Start the Temporal dispatch stack
# =============================================================================
#
# Starts the full Temporal dispatch stack for automated agent task execution:
#   1. Validates kilo serve is running (required, not started by this script)
#   2. Starts Temporal dev server (if not already running)
#   3. Starts Temporal worker (if not already running)
#
# Usage:
#   .kilocode/tools/start-stack.sh           # Start full stack
#   .kilocode/tools/start-stack.sh --check   # Check stack health only
#   .kilocode/tools/start-stack.sh --stop    # Stop Temporal components
#
# Prerequisites:
#   - kilo serve must be running on port 4096 (started separately via VS Code)
#   - temporal CLI must be installed (npm i -g @temporalio/cli or brew install temporal)
#   - daemon/node_modules must be installed (cd daemon && npm install)
#
# Called by:
#   daemon/package.json "stack" script
#   Manual invocation before factory_dispatch.sh or Temporal dispatch.ts
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DAEMON_DIR="$REPO_ROOT/daemon"

KILO_HOST="${KILO_HOST:-127.0.0.1}"
KILO_PORT="${KILO_PORT:-4096}"
TEMPORAL_PORT="${TEMPORAL_PORT:-7233}"
TEMPORAL_UI_PORT="${TEMPORAL_UI_PORT:-8233}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() { echo "[start-stack] $*" >&2; }

is_port_open() {
    local port="$1"
    curl -sf --connect-timeout 2 "http://127.0.0.1:${port}" >/dev/null 2>&1 && return 0
    # Fallback: check with ss
    ss -tlnp 2>/dev/null | grep -q ":${port} " && return 0
    return 1
}

is_kilo_healthy() {
    # Use GET /session (verified working endpoint in kilo serve v7.x)
    local response
    response=$(curl -sf "http://${KILO_HOST}:${KILO_PORT}/session" 2>/dev/null) || return 1
    # Should return a JSON array of sessions
    echo "$response" | python3 -c "import sys,json; json.load(sys.stdin)" >/dev/null 2>&1
}

is_temporal_running() {
    ss -tlnp 2>/dev/null | grep -q ":${TEMPORAL_PORT} "
}

is_worker_running() {
    pgrep -f "tsx.*src/temporal/worker.ts" >/dev/null 2>&1
}

# ─── Commands ─────────────────────────────────────────────────────────────────

do_check() {
    local ok=true

    if is_kilo_healthy; then
        log "✅ kilo serve: healthy (${KILO_HOST}:${KILO_PORT})"
    else
        log "❌ kilo serve: NOT running on ${KILO_HOST}:${KILO_PORT}"
        ok=false
    fi

    if is_temporal_running; then
        log "✅ Temporal server: running (port ${TEMPORAL_PORT})"
    else
        log "❌ Temporal server: NOT running"
        ok=false
    fi

    if is_worker_running; then
        log "✅ Temporal worker: running"
    else
        log "❌ Temporal worker: NOT running"
        ok=false
    fi

    if [[ "$ok" == true ]]; then
        log "Stack is healthy."
        return 0
    else
        log "Stack is NOT healthy."
        return 1
    fi
}

do_stop() {
    log "Stopping Temporal components..."

    # Kill worker
    if is_worker_running; then
        pkill -f "tsx.*src/temporal/worker.ts" 2>/dev/null || true
        log "Worker stopped."
    else
        log "Worker not running."
    fi

    # Kill Temporal server
    if is_temporal_running; then
        pkill -f "temporal server start-dev" 2>/dev/null || true
        log "Temporal server stopped."
    else
        log "Temporal server not running."
    fi

    log "Done."
}

do_start() {
    # ── Step 1: Validate kilo serve ──────────────────────────────────────
    log "Checking kilo serve at ${KILO_HOST}:${KILO_PORT}..."
    if ! is_kilo_healthy; then
        log "ERROR: kilo serve is not running at ${KILO_HOST}:${KILO_PORT}"
        log "Start kilo serve first (via VS Code or 'kilo serve --port ${KILO_PORT}')"
        exit 2
    fi
    log "kilo serve is healthy."

    # ── Step 2: Start Temporal dev server ────────────────────────────────
    if is_temporal_running; then
        log "Temporal server already running on port ${TEMPORAL_PORT}."
    else
        log "Starting Temporal dev server on port ${TEMPORAL_PORT} (UI: ${TEMPORAL_UI_PORT})..."
        if ! command -v temporal &>/dev/null; then
            log "ERROR: 'temporal' CLI not found. Install via: npm i -g @temporalio/cli"
            exit 1
        fi
        temporal server start-dev \
            --port "$TEMPORAL_PORT" \
            --ui-port "$TEMPORAL_UI_PORT" \
            >/dev/null 2>&1 &
        log "Temporal server started (PID $!)."

        # Wait for it to be ready
        for i in $(seq 1 10); do
            if is_temporal_running; then
                break
            fi
            sleep 1
        done

        if ! is_temporal_running; then
            log "ERROR: Temporal server failed to start within 10s"
            exit 3
        fi
    fi

    # ── Step 3: Validate daemon dependencies ─────────────────────────────
    if [[ ! -d "$DAEMON_DIR/node_modules" ]]; then
        log "Installing daemon dependencies..."
        (cd "$DAEMON_DIR" && npm install --silent)
    fi

    # ── Step 4: Start Temporal worker ────────────────────────────────────
    if is_worker_running; then
        log "Temporal worker already running."
    else
        log "Starting Temporal worker..."
        (cd "$DAEMON_DIR" && npx tsx src/temporal/worker.ts) >/dev/null 2>&1 &
        log "Temporal worker started (PID $!)."

        sleep 2
        if ! is_worker_running; then
            log "ERROR: Temporal worker failed to start"
            exit 4
        fi
    fi

    # ── Done ──────────────────────────────────────────────────────────────
    log ""
    log "Stack is ready:"
    log "  kilo serve:     http://${KILO_HOST}:${KILO_PORT}"
    log "  Temporal gRPC:  localhost:${TEMPORAL_PORT}"
    log "  Temporal UI:    http://localhost:${TEMPORAL_UI_PORT}"
    log ""
    log "Dispatch a task:"
    log "  cd daemon && npx tsx src/temporal/dispatch.ts --agent plant-manager \"your prompt here\""
    log "  # or"
    log "  .kilocode/tools/factory_dispatch.sh -m plant-manager \"your prompt here\""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
    --check)  do_check ;;
    --stop)   do_stop ;;
    --help|-h)
        sed -n '/^# Usage:/,/^# =====/p' "$0" | sed 's/^# \?//'
        ;;
    *)        do_start ;;
esac
