#!/usr/bin/env bash
# =============================================================================
# start-stack.sh — Start the FULL dispatch stack (all 5 components)
# =============================================================================
#
# Starts every component required for factory dispatch with full observability:
#   1. Validates kilo serve is running (required, not started by this script)
#   2. Starts Dolt SQL server (punch card database)
#   3. Starts oc-daemon (SSE event stream → Dolt punch writer)
#   4. Starts Temporal dev server (workflow orchestration)
#   5. Starts Temporal worker (polls agent-tasks queue)
#
# Usage:
#   .kilocode/tools/start-stack.sh           # Start full stack
#   .kilocode/tools/start-stack.sh --check   # Check stack health only
#   .kilocode/tools/start-stack.sh --stop    # Stop all managed components
#
# Prerequisites:
#   - kilo serve must be running on port 4096 (started separately with op run)
#   - temporal CLI installed (~/.temporalio/bin/temporal or on PATH)
#   - daemon/node_modules installed (cd daemon && npm install)
#   - oc-daemon/node_modules installed (cd oc-daemon && npm install)
#   - dolt CLI installed (~/.local/bin/dolt or on PATH)
#
# Called by:
#   daemon/package.json "stack" script
#   Manual invocation before factory_dispatch.sh or Temporal dispatch.ts
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DAEMON_DIR="$REPO_ROOT/daemon"

# oc-daemon lives alongside the repo, not inside it
OC_DAEMON_DIR="${OC_DAEMON_DIR:-$(cd "$REPO_ROOT/.." && pwd)/oc-daemon}"

KILO_HOST="${KILO_HOST:-127.0.0.1}"
KILO_PORT="${KILO_PORT:-4096}"
TEMPORAL_PORT="${TEMPORAL_PORT:-7233}"
TEMPORAL_UI_PORT="${TEMPORAL_UI_PORT:-8233}"
DOLT_PORT="${DOLT_PORT:-3307}"
DOLT_DATA_DIR="${DOLT_DATA_DIR:-$HOME/.dolt-data/beads}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() { echo "[start-stack] $*" >&2; }

is_kilo_healthy() {
    local response
    response=$(curl -sf "http://${KILO_HOST}:${KILO_PORT}/session" 2>/dev/null) || return 1
    echo "$response" | python3 -c "import sys,json; json.load(sys.stdin)" >/dev/null 2>&1
}

is_temporal_running() {
    ss -tlnp 2>/dev/null | grep -q ":${TEMPORAL_PORT} "
}

is_worker_running() {
    pgrep -f "tsx.*src/temporal/worker.ts" >/dev/null 2>&1
}

is_dolt_running() {
    ss -tlnp 2>/dev/null | grep -q ":${DOLT_PORT} "
}

is_oc_daemon_running() {
    pgrep -f "tsx.*oc-daemon/src/index.ts" >/dev/null 2>&1 || \
    pgrep -f "node.*oc-daemon/build/index.js" >/dev/null 2>&1
}

find_temporal_cli() {
    if command -v temporal &>/dev/null; then
        echo "temporal"
    elif [[ -x "$HOME/.temporalio/bin/temporal" ]]; then
        echo "$HOME/.temporalio/bin/temporal"
    elif [[ -x "$HOME/.local/bin/temporal" ]]; then
        echo "$HOME/.local/bin/temporal"
    else
        return 1
    fi
}

find_dolt_cli() {
    if command -v dolt &>/dev/null; then
        echo "dolt"
    elif [[ -x "$HOME/.local/bin/dolt" ]]; then
        echo "$HOME/.local/bin/dolt"
    else
        return 1
    fi
}

# ─── Commands ─────────────────────────────────────────────────────────────────

do_check() {
    local ok=true
    local components=0
    local healthy=0

    components=$((components + 1))
    if is_kilo_healthy; then
        log "✅ kilo serve: healthy (${KILO_HOST}:${KILO_PORT})"
        healthy=$((healthy + 1))
    else
        log "❌ kilo serve: NOT running on ${KILO_HOST}:${KILO_PORT}"
        ok=false
    fi

    components=$((components + 1))
    if is_dolt_running; then
        log "✅ Dolt server: running (port ${DOLT_PORT})"
        healthy=$((healthy + 1))
    else
        log "❌ Dolt server: NOT running on port ${DOLT_PORT}"
        ok=false
    fi

    components=$((components + 1))
    if is_oc_daemon_running; then
        log "✅ oc-daemon: running (SSE → Dolt)"
        healthy=$((healthy + 1))
    else
        log "❌ oc-daemon: NOT running (no flight recorder!)"
        ok=false
    fi

    components=$((components + 1))
    if is_temporal_running; then
        log "✅ Temporal server: running (port ${TEMPORAL_PORT})"
        healthy=$((healthy + 1))
    else
        log "❌ Temporal server: NOT running"
        ok=false
    fi

    components=$((components + 1))
    if is_worker_running; then
        log "✅ Temporal worker: running"
        healthy=$((healthy + 1))
    else
        log "❌ Temporal worker: NOT running"
        ok=false
    fi

    log ""
    if [[ "$ok" == true ]]; then
        log "Stack is healthy. (${healthy}/${components} components)"
        return 0
    else
        log "Stack is NOT healthy. (${healthy}/${components} components)"
        return 1
    fi
}

do_stop() {
    log "Stopping managed components..."

    if is_worker_running; then
        pkill -f "tsx.*src/temporal/worker.ts" 2>/dev/null || true
        log "Temporal worker stopped."
    else
        log "Temporal worker not running."
    fi

    if is_oc_daemon_running; then
        pkill -f "tsx.*oc-daemon/src/index.ts" 2>/dev/null || true
        pkill -f "node.*oc-daemon/build/index.js" 2>/dev/null || true
        log "oc-daemon stopped."
    else
        log "oc-daemon not running."
    fi

    if is_temporal_running; then
        pkill -f "temporal server start-dev" 2>/dev/null || true
        log "Temporal server stopped."
    else
        log "Temporal server not running."
    fi

    # Note: Dolt and kilo serve are NOT stopped — they may be shared
    log "Done. (Dolt and kilo serve left running — stop manually if needed.)"
}

do_start() {
    # ── Step 1: Validate kilo serve ──────────────────────────────────────
    log "Checking kilo serve at ${KILO_HOST}:${KILO_PORT}..."
    if ! is_kilo_healthy; then
        log "ERROR: kilo serve is not running at ${KILO_HOST}:${KILO_PORT}"
        log "Start it first: op run --env-file .env.op -- kilo serve --port ${KILO_PORT}"
        exit 2
    fi
    log "✅ kilo serve is healthy."

    # ── Step 2: Start Dolt server ────────────────────────────────────────
    if is_dolt_running; then
        log "✅ Dolt server already running on port ${DOLT_PORT}."
    else
        log "Starting Dolt server on port ${DOLT_PORT}..."
        local dolt_cli
        dolt_cli=$(find_dolt_cli) || {
            log "ERROR: 'dolt' CLI not found. Install via: curl -L https://github.com/dolthub/dolt/releases/latest/download/install.sh | sudo bash"
            exit 1
        }

        if [[ ! -d "$DOLT_DATA_DIR" ]]; then
            log "ERROR: Dolt data directory not found: $DOLT_DATA_DIR"
            log "Initialize with: mkdir -p $DOLT_DATA_DIR && cd $DOLT_DATA_DIR && dolt init"
            exit 1
        fi

        (cd "$DOLT_DATA_DIR" && "$dolt_cli" sql-server \
            --host 127.0.0.1 \
            --port "$DOLT_PORT" \
            --user root \
            --no-auto-commit \
            > /tmp/dolt-server.log 2>&1 &)

        for i in $(seq 1 10); do
            if is_dolt_running; then break; fi
            sleep 1
        done

        if ! is_dolt_running; then
            log "ERROR: Dolt server failed to start within 10s"
            log "Check /tmp/dolt-server.log for details"
            exit 3
        fi
        log "✅ Dolt server started."
    fi

    # ── Step 3: Start oc-daemon ──────────────────────────────────────────
    if is_oc_daemon_running; then
        log "✅ oc-daemon already running."
    else
        if [[ ! -d "$OC_DAEMON_DIR/src" ]]; then
            log "ERROR: oc-daemon not found at $OC_DAEMON_DIR"
            log "Set OC_DAEMON_DIR or ensure it exists alongside the repo."
            exit 1
        fi

        if [[ ! -d "$OC_DAEMON_DIR/node_modules" ]]; then
            log "Installing oc-daemon dependencies..."
            (cd "$OC_DAEMON_DIR" && npm install --silent)
        fi

        log "Starting oc-daemon (SSE → Dolt)..."
        KILO_HOST="$KILO_HOST" KILO_PORT="$KILO_PORT" DOLT_PORT="$DOLT_PORT" \
            npx tsx "$OC_DAEMON_DIR/src/index.ts" > /tmp/oc-daemon.log 2>&1 &
        sleep 2

        if ! is_oc_daemon_running; then
            log "ERROR: oc-daemon failed to start"
            log "Check /tmp/oc-daemon.log for details"
            exit 4
        fi
        log "✅ oc-daemon started."
    fi

    # ── Step 4: Start Temporal dev server ────────────────────────────────
    if is_temporal_running; then
        log "✅ Temporal server already running on port ${TEMPORAL_PORT}."
    else
        log "Starting Temporal dev server on port ${TEMPORAL_PORT} (UI: ${TEMPORAL_UI_PORT})..."
        local temporal_cli
        temporal_cli=$(find_temporal_cli) || {
            log "ERROR: 'temporal' CLI not found."
            log "Install via: curl -sSf https://temporal.download/cli.sh | sh"
            exit 1
        }

        "$temporal_cli" server start-dev \
            --port "$TEMPORAL_PORT" \
            --ui-port "$TEMPORAL_UI_PORT" \
            --db-filename /tmp/temporal-dev.db \
            >/dev/null 2>&1 &
        log "Temporal server starting (PID $!)..."

        for i in $(seq 1 10); do
            if is_temporal_running; then break; fi
            sleep 1
        done

        if ! is_temporal_running; then
            log "ERROR: Temporal server failed to start within 10s"
            exit 5
        fi
        log "✅ Temporal server started."
    fi

    # ── Step 5: Validate daemon dependencies ─────────────────────────────
    if [[ ! -d "$DAEMON_DIR/node_modules" ]]; then
        log "Installing daemon dependencies..."
        (cd "$DAEMON_DIR" && npm install --silent)
    fi

    # ── Step 6: Start Temporal worker ────────────────────────────────────
    if is_worker_running; then
        log "✅ Temporal worker already running."
    else
        log "Starting Temporal worker..."
        (cd "$DAEMON_DIR" && npx tsx src/temporal/worker.ts) >/dev/null 2>&1 &

        sleep 3
        if ! is_worker_running; then
            log "ERROR: Temporal worker failed to start"
            exit 6
        fi
        log "✅ Temporal worker started."
    fi

    # ── Final verification ───────────────────────────────────────────────
    log ""
    log "═══════════════════════════════════════════════════"
    log " FULL STACK READY (5/5 components)"
    log "═══════════════════════════════════════════════════"
    log "  kilo serve:     http://${KILO_HOST}:${KILO_PORT}"
    log "  Dolt SQL:       127.0.0.1:${DOLT_PORT}"
    log "  oc-daemon:      SSE → Dolt (flight recorder)"
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
