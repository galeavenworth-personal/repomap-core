#!/usr/bin/env bash
# =============================================================================
# start-stack.sh — Start the FULL dispatch stack (all 5 components)
# =============================================================================
#
# Starts every component required for factory dispatch with full observability:
#   1. Validates kilo serve is running (required, not started by this script)
#   2. Starts Dolt SQL server (punch card database)
#   3. Starts oc-daemon via pm2 (SSE event stream → Dolt punch writer)
#   4. Starts Temporal dev server (workflow orchestration)
#   5. Starts Temporal worker via pm2 (polls agent-tasks queue)
#
# Node.js processes (oc-daemon, temporal-worker) are managed by pm2 for:
#   - Automatic restart on crash (exponential backoff)
#   - Centralized log management (pm2 logs)
#   - Proper process tree (no orphaned nohup hacks)
#   - Health status (pm2 status)
#
# Usage:
#   .kilocode/tools/start-stack.sh           # Start full stack
#   .kilocode/tools/start-stack.sh --ensure  # Ensure full stack is healthy (start missing pieces only)
#   .kilocode/tools/start-stack.sh --check   # Check stack health only
#   .kilocode/tools/start-stack.sh --stop    # Stop all managed components
#   .kilocode/tools/start-stack.sh --with-kilo # Start kilo serve too if it is missing
#
# Prerequisites:
#   - kilo serve must be running on port 4096 (started separately unless --with-kilo/--ensure is used)
#   - temporal CLI installed (~/.temporalio/bin/temporal or on PATH)
#   - daemon/node_modules installed (cd daemon && npm install)
#   - dolt CLI installed (~/.local/bin/dolt or on PATH)
#   - pm2 installed in daemon (cd daemon && npm install --save-dev pm2)
#
# Called by:
#   daemon/package.json "stack" script
#   Manual invocation before factory_dispatch.sh or Temporal dispatch.ts
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DAEMON_DIR="$REPO_ROOT/daemon"
ECOSYSTEM_CONFIG="$SCRIPT_DIR/ecosystem.config.cjs"

if [[ "${FACTORY_REQUIRE_ROOT:-}" == "1" || "${FACTORY_REQUIRE_ROOT:-}" == "true" ]]; then
    "$SCRIPT_DIR/require_factory_root.sh" "$REPO_ROOT"
fi

KILO_HOST="${KILO_HOST:-127.0.0.1}"
KILO_PORT="${KILO_PORT:-4096}"
TEMPORAL_PORT="${TEMPORAL_PORT:-7233}"
TEMPORAL_UI_PORT="${TEMPORAL_UI_PORT:-8233}"
DOLT_PORT="${DOLT_PORT:-3307}"
DOLT_DATA_DIR="${DOLT_DATA_DIR:-$HOME/.dolt-data/beads}"
MANAGE_KILO=false

# ─── Hard Dependencies ────────────────────────────────────────────────────────
# Resolve all external binaries at startup. Fail fast if missing.
# Same pattern as daemon/src/temporal/dispatch.ts resolveBinary().

resolve_bin() {
    local name="$1"; shift
    for p in "$@"; do
        if [[ -x "$p" ]]; then echo "$p"; return 0; fi
    done
    local found
    found=$(command -v "$name" 2>/dev/null) || true
    if [[ -n "$found" && -x "$found" ]]; then echo "$found"; return 0; fi
    echo "FATAL: required binary '$name' not found" >&2
    exit 127
}

CURL=$(resolve_bin curl /usr/bin/curl)
PYTHON3=$(resolve_bin python3 /usr/bin/python3)
SS=$(resolve_bin ss /usr/bin/ss /usr/sbin/ss /bin/ss)
GREP=$(resolve_bin grep /usr/bin/grep /bin/grep)

# pm2 is a project dependency, not global
PM2="$DAEMON_DIR/node_modules/.bin/pm2"
if [[ ! -x "$PM2" ]]; then
    echo "FATAL: pm2 not found at $PM2. Run: cd daemon && npm install" >&2
    exit 127
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() { echo "[start-stack] $*" >&2; }

is_kilo_healthy() {
    local response
    response=$("$CURL" -sf "http://${KILO_HOST}:${KILO_PORT}/session" 2>/dev/null) || return 1
    echo "$response" | "$PYTHON3" -c "import sys,json; json.load(sys.stdin)" >/dev/null 2>&1
}

is_temporal_running() {
    "$SS" -tlnp 2>/dev/null | "$GREP" -q ":${TEMPORAL_PORT} "
    return $?
}

is_dolt_running() {
    "$SS" -tlnp 2>/dev/null | "$GREP" -q ":${DOLT_PORT} "
    return $?
}

# pm2-based health checks: check process status via pm2 jlist
is_pm2_app_online() {
    local app_name="$1"
    "$PM2" jlist 2>/dev/null \
        | "$GREP" -q "\"name\":\"${app_name}\".*\"status\":\"online\""
    return $?
}

is_oc_daemon_running() {
    is_pm2_app_online "oc-daemon"
    return $?
}

is_worker_running() {
    is_pm2_app_online "temporal-worker"
    return $?
}

find_temporal_cli() {
    if command -v temporal &>/dev/null; then
        command -v temporal
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
        command -v dolt
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
        # Port is listening — verify it has the correct databases (repomap-core-4hw)
        if DOLT_DATA_DIR="$DOLT_DATA_DIR" "$REPO_ROOT/.kilocode/tools/dolt_start.sh" --check 2>&1 | "$GREP" -q "databases verified"; then
            log "✅ Dolt server: running (port ${DOLT_PORT}, databases verified)"
            healthy=$((healthy + 1))
        else
            log "⚠️  Dolt server: port ${DOLT_PORT} occupied but WRONG databases (rogue server?)"
            log "   Fix: .kilocode/tools/dolt_start.sh  (kills rogue, starts correct)"
            ok=false
        fi
    else
        log "❌ Dolt server: NOT running on port ${DOLT_PORT}"
        ok=false
    fi

    components=$((components + 1))
    if is_oc_daemon_running; then
        log "✅ oc-daemon: online (pm2, SSE → Dolt)"
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
        log "✅ Temporal worker: online (pm2)"
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

    # Stop pm2-managed Node.js processes
    if "$PM2" jlist 2>/dev/null | "$PYTHON3" -c "import sys,json; sys.exit(0 if json.load(sys.stdin) else 1)" 2>/dev/null; then
        "$PM2" stop all 2>/dev/null || true
        "$PM2" delete all 2>/dev/null || true
        log "pm2 processes stopped (oc-daemon, temporal-worker)."
    else
        log "No pm2 processes to stop."
    fi

    # Stop Temporal server (native binary, not pm2)
    if is_temporal_running; then
        pkill -f "temporal server start-dev" 2>/dev/null || true
        log "Temporal server stopped."
    else
        log "Temporal server not running."
    fi

    # Note: Dolt and kilo serve are NOT stopped — they may be shared
    log "Done. (Dolt and kilo serve left running — stop manually if needed.)"
    return 0
}

start_kilo_if_needed() {
    if is_kilo_healthy; then
        log "✅ kilo serve already healthy on ${KILO_HOST}:${KILO_PORT}."
        return 0
    fi

    if [[ "$MANAGE_KILO" != true ]]; then
        log "ERROR: kilo serve is not running at ${KILO_HOST}:${KILO_PORT}"
        log "Start it first: kilo serve --port ${KILO_PORT}"
        log "Or use: .kilocode/tools/start-stack.sh --with-kilo"
        exit 2
    fi

    log "Starting kilo serve on ${KILO_HOST}:${KILO_PORT}..."
    if [[ -f "$REPO_ROOT/.env.op" && -x "$(command -v op 2>/dev/null || true)" ]]; then
        nohup op run --env-file "$REPO_ROOT/.env.op" -- kilo serve --port "$KILO_PORT" > /tmp/kilo-serve.log 2>&1 &
    else
        nohup kilo serve --port "$KILO_PORT" > /tmp/kilo-serve.log 2>&1 &
    fi
    log "kilo serve starting (PID $!)..."

    for i in $(seq 1 20); do
        if is_kilo_healthy; then
            log "✅ kilo serve started."
            return 0
        fi
        sleep 1
    done

    log "ERROR: kilo serve failed to start within 20s"
    log "Check /tmp/kilo-serve.log for details"
    exit 2
}

ensure_temporal_server() {
    if is_temporal_running; then
        log "✅ Temporal server already running on port ${TEMPORAL_PORT}."
        return 0
    fi

    log "Starting Temporal dev server on port ${TEMPORAL_PORT} (UI: ${TEMPORAL_UI_PORT})..."
    local temporal_cli
    temporal_cli=$(find_temporal_cli) || {
        log "ERROR: 'temporal' CLI not found."
        log "Install via: curl -sSf https://temporal.download/cli.sh | sh"
        exit 1
    }

    nohup "$temporal_cli" server start-dev \
        --port "$TEMPORAL_PORT" \
        --ui-port "$TEMPORAL_UI_PORT" \
        --db-filename /tmp/temporal-dev.db \
        > /tmp/temporal-dev.log 2>&1 &
    log "Temporal server starting (PID $!)..."

    for i in $(seq 1 10); do
        if is_temporal_running; then
            log "✅ Temporal server started."
            return 0
        fi
        sleep 1
    done

    log "ERROR: Temporal server failed to start within 10s"
    log "Check /tmp/temporal-dev.log for details"
    exit 5
}

do_start() {
    # ── Step 1: Validate kilo serve ──────────────────────────────────────
    log "Checking kilo serve at ${KILO_HOST}:${KILO_PORT}..."
    start_kilo_if_needed
    log "✅ kilo serve is healthy."

    # ── Step 2: Start Dolt server (delegated to dolt_start.sh) ──────────
    # dolt_start.sh is the single authority for Dolt lifecycle. It:
    #   - Validates the running server has the correct databases
    #   - Kills rogue servers started by bd from .beads/dolt/
    #   - Clears stale bd state files (.beads/dolt-server.port etc.)
    #   - Starts the correct server from ~/.dolt-data/beads/
    # See: repomap-core-4hw
    log "Ensuring Dolt server with correct databases..."
    if ! DOLT_DATA_DIR="$DOLT_DATA_DIR" "$REPO_ROOT/.kilocode/tools/dolt_start.sh"; then
        log "ERROR: Dolt server failed to start. Check /tmp/dolt-server.log"
        exit 3
    fi
    log "✅ Dolt server verified (databases: beads_repomap-core, punch_cards)."

    # ── Step 2.5: Ensure punch card schema is migrated ────────────────────
    log "Applying idempotent punch card schema migration..."
    "$REPO_ROOT/.kilocode/tools/dolt_apply_punch_card_schema.sh"
    log "✅ Punch card schema migration complete."

    # ── Step 3: Validate dependencies ─────────────────────────────────────
    if [[ ! -d "$DAEMON_DIR/node_modules" ]]; then
        log "Installing daemon dependencies..."
        (cd "$DAEMON_DIR" && npm install --silent)
    fi

    # ── Step 4: Start Temporal dev server before worker dependencies ──────
    ensure_temporal_server

    # ── Step 5: Start pm2-managed processes (oc-daemon + temporal-worker) ─
    # pm2 handles: daemonization, auto-restart on crash, log management,
    # proper process tree. No more nohup/pgrep hacks.
    log "Starting pm2-managed processes..."
    KILO_HOST="$KILO_HOST" KILO_PORT="$KILO_PORT" DOLT_PORT="$DOLT_PORT" \
        "$PM2" start "$ECOSYSTEM_CONFIG" 2>&1 | while IFS= read -r line; do
            log "  $line"
        done

    # Wait for both to be online
    for i in $(seq 1 15); do
        if is_oc_daemon_running && is_worker_running; then break; fi
        sleep 1
    done

    if ! is_oc_daemon_running; then
        log "ERROR: oc-daemon failed to start. Check: $PM2 logs oc-daemon"
        exit 4
    fi
    log "✅ oc-daemon online (pm2, auto-restart enabled)."

    if ! is_worker_running; then
        log "ERROR: Temporal worker failed to start. Check: $PM2 logs temporal-worker"
        exit 6
    fi
    log "✅ Temporal worker online (pm2, auto-restart enabled)."

    # ── Final verification ───────────────────────────────────────────────
    log ""
    log "═══════════════════════════════════════════════════"
    log " FULL STACK READY (5/5 components)"
    log "═══════════════════════════════════════════════════"
    log "  kilo serve:     http://${KILO_HOST}:${KILO_PORT}"
    log "  Dolt SQL:       127.0.0.1:${DOLT_PORT}"
    log "  oc-daemon:      pm2 (auto-restart, SSE → Dolt)"
    log "  Temporal gRPC:  localhost:${TEMPORAL_PORT}"
    log "  Temporal UI:    http://localhost:${TEMPORAL_UI_PORT}"
    log ""
    log "Process management:"
    log "  $PM2 status       # Check pm2 processes"
    log "  $PM2 logs         # Tail all logs"
    log "  $PM2 restart all  # Restart pm2 processes"
    log ""
    log "Dispatch a task:"
    log "  .kilocode/tools/factory_dispatch.sh -m plant-manager \"your prompt here\""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
    --ensure)
        MANAGE_KILO=true
        do_start
        ;;
    --check)  do_check ;;
    --stop)   do_stop ;;
    --with-kilo)
        MANAGE_KILO=true
        do_start
        ;;
    --help|-h)
        sed -n '/^# Usage:/,/^# =====/p' "$0" | sed 's/^# \?//'
        ;;
    *)        do_start ;;
esac
