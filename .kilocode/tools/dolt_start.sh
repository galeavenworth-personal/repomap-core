#!/usr/bin/env bash
# Start the Dolt SQL server with the canonical data directory.
#
# Usage:
#   .kilocode/tools/dolt_start.sh          # Start server if not running
#   .kilocode/tools/dolt_start.sh --check   # Check status only
#   .kilocode/tools/dolt_start.sh --stop    # Stop server
#
# CANONICAL DATA DIR: ~/.dolt-data/beads/
#   Contains both beads_repomap-core (issue tracking) and punch_cards (factory telemetry).
#
# WARNING: The beads CLI (bd) can auto-start its own Dolt server from .beads/dolt/
# which is an EMPTY init dir with no databases. This script detects and kills such
# rogue servers, clears bd's cached state files, and starts the correct server.
# See: repomap-core-4hw

set -euo pipefail

DOLT_BIN="${DOLT_BIN:-${HOME}/.local/bin/dolt}"
if [[ ! -x "${DOLT_BIN}" ]]; then
    DOLT_BIN="$(command -v dolt)" || { echo "ERROR: dolt not found in PATH" >&2; exit 1; }
fi
DATA_DIR="${DOLT_DATA_DIR:-${HOME}/.dolt-data/beads}"
HOST="127.0.0.1"
PORT="3307"
LOG="/tmp/dolt-server.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Required databases that must be visible on the server
REQUIRED_DBS=("beads_repomap-core" "punch_cards")

die() { echo "ERROR: $*" >&2; exit 1; }

check_prereqs() {
    [[ -x "${DOLT_BIN}" ]] || die "Dolt not found at ${DOLT_BIN}"
    [[ -d "${DATA_DIR}" ]] || die "Dolt data dir not found at ${DATA_DIR}. Has beads been initialized?"
    return 0
}

# Check if ANY Dolt server is listening on PORT (port-level check only)
is_port_listening() {
    local ss_bin
    ss_bin=$(command -v ss 2>/dev/null || echo /usr/bin/ss)
    "${ss_bin}" -tlnp 2>/dev/null | grep -q ":${PORT} " 2>/dev/null
}

# Query the RUNNING SERVER for its databases via network connection.
# Returns 0 if ALL required databases are present, 1 otherwise.
# IMPORTANT: Uses --host/--port/--no-tls to query the actual server process,
# NOT --data-dir which reads the local filesystem regardless of what's running.
has_required_databases() {
    local db_list
    db_list=$("${DOLT_BIN}" --host "${HOST}" --port "${PORT}" --no-tls --user root --password "" \
        sql -q "SHOW DATABASES;" --result-format csv 2>/dev/null) || return 1
    for db in "${REQUIRED_DBS[@]}"; do
        if ! echo "${db_list}" | grep -q "^${db}$"; then
            return 1
        fi
    done
    return 0
}

# Kill ALL dolt sql-server processes on our port, regardless of data-dir
kill_all_dolt_on_port() {
    local pids
    pids=$(pgrep -f "dolt sql-server" 2>/dev/null || true)
    if [[ -n "${pids}" ]]; then
        echo "  Killing Dolt server processes: ${pids}"
        kill ${pids} 2>/dev/null || true
        sleep 1
        # Force-kill if still alive
        for pid in ${pids}; do
            if kill -0 "${pid}" 2>/dev/null; then
                kill -9 "${pid}" 2>/dev/null || true
            fi
        done
    fi
}

# bd state files that cache server port/pid and cause reconnection to stale servers.
# bd also runs a background monitor that re-creates these, so we kill that too.
BD_STATE_FILES=(
    dolt-server.port dolt-server.pid dolt-server.lock
    dolt-server.activity dolt-server.log
    dolt-monitor.pid dolt-monitor.pid.lock
)

# Clear bd's cached server state files from a .beads directory
_clear_beads_dir() {
    local beads_dir="$1"
    local cleared=false
    [[ -d "${beads_dir}" ]] || return 0
    for f in "${BD_STATE_FILES[@]}"; do
        if [[ -f "${beads_dir}/${f}" ]]; then
            rm -f "${beads_dir}/${f}"
            cleared=true
        fi
    done
    if [[ "${cleared}" == true ]]; then
        echo "  Cleared stale bd state files in ${beads_dir}"
    fi
}

clear_bd_state_files() {
    _clear_beads_dir "${REPO_ROOT}/.beads"
    # Also check Employee-1 clone if it exists
    _clear_beads_dir "${HOME}/Projects-Employee-1/repomap-core/.beads"
}

start_server() {
    check_prereqs

    if is_port_listening; then
        # Something is on our port — validate it's the RIGHT server
        if has_required_databases; then
            echo "✓ Dolt server already running on ${HOST}:${PORT} (databases verified)"
            clear_bd_state_files
            return 0
        else
            echo "⚠ Dolt server on ${HOST}:${PORT} is missing required databases!"
            echo "  Required: ${REQUIRED_DBS[*]}"
            echo "  This is likely a rogue server started by bd from .beads/dolt/"
            echo "  Killing rogue server and restarting from ${DATA_DIR}..."
            kill_all_dolt_on_port
            clear_bd_state_files
            sleep 1
        fi
    else
        # Port is free — clear any stale bd state before starting
        clear_bd_state_files
    fi

    echo "Starting Dolt SQL server (${HOST}:${PORT}, data-dir=${DATA_DIR})..."
    nohup "${DOLT_BIN}" sql-server \
        --host "${HOST}" \
        --port "${PORT}" \
        --data-dir "${DATA_DIR}" \
        > "${LOG}" 2>&1 &
    local pid=$!

    # Wait up to 5 seconds for server to become reachable with correct databases
    for i in {1..10}; do
        sleep 0.5
        if is_port_listening && has_required_databases; then
            echo "✓ Dolt server started (pid=${pid}, data-dir=${DATA_DIR})"
            return 0
        fi
    done

    echo "✗ Server did not become reachable within 5 seconds"
    echo "  Check log: ${LOG}"
    cat "${LOG}" >&2
    return 1
}

stop_server() {
    if ! is_port_listening; then
        echo "Dolt server is not running."
        clear_bd_state_files
        return 0
    fi
    kill_all_dolt_on_port
    clear_bd_state_files
    echo "✓ Dolt server stopped"
    return 0
}

check_status() {
    check_prereqs
    if is_port_listening; then
        if has_required_databases; then
            echo "✓ Dolt server running on ${HOST}:${PORT} (databases verified)"
            echo "  Data dir: ${DATA_DIR}"
            echo "  Log: ${LOG}"
        else
            echo "⚠ Dolt server on ${HOST}:${PORT} but MISSING required databases!"
            echo "  Required: ${REQUIRED_DBS[*]}"
            echo "  Likely a rogue server. Run: .kilocode/tools/dolt_start.sh"
        fi
    else
        echo "✗ Dolt server not running"
        echo "  Start with: .kilocode/tools/dolt_start.sh"
    fi
    return 0
}

case "${1:-}" in
    --check)  check_status ;;
    --stop)   stop_server ;;
    --help|-h)
        echo "Usage: .kilocode/tools/dolt_start.sh [--check|--stop|--help]"
        echo "  (no args)  Start Dolt server if not running"
        echo "  --check    Check if server is running"
        echo "  --stop     Stop the server"
        ;;
    "")       start_server ;;
    *)        die "Unknown flag: $1. Use --help for usage." ;;
esac
