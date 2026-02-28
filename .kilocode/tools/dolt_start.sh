#!/usr/bin/env bash
# Start the Dolt SQL server for Beads issue tracking.
#
# Usage:
#   .kilocode/tools/dolt_start.sh          # Start server if not running
#   .kilocode/tools/dolt_start.sh --check   # Check status only
#   .kilocode/tools/dolt_start.sh --stop    # Stop server
#
# The Dolt data directory for beads lives at ~/.dolt-data/beads/
# (NOT .beads/dolt — that path does not exist in this repo).
# Config: .beads/config.yaml  (host=127.0.0.1, port=3307)

set -euo pipefail

DOLT_BIN="${HOME}/.local/bin/dolt"
DATA_DIR="${HOME}/.dolt-data/beads"
HOST="127.0.0.1"
PORT="3307"
LOG="/tmp/dolt-server.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BD="${SCRIPT_DIR}/bd"

die() { echo "ERROR: $*" >&2; exit 1; }

check_prereqs() {
    [[ -x "${DOLT_BIN}" ]] || die "Dolt not found at ${DOLT_BIN}"
    [[ -d "${DATA_DIR}" ]] || die "Dolt data dir not found at ${DATA_DIR}. Has beads been initialized?"
}

is_running() {
    "${BD}" dolt test 2>&1 | grep -q "successful"
}

start_server() {
    check_prereqs
    if is_running; then
        echo "✓ Dolt server already running on ${HOST}:${PORT}"
        return 0
    fi
    echo "Starting Dolt SQL server (${HOST}:${PORT})..."
    nohup "${DOLT_BIN}" sql-server \
        --host "${HOST}" \
        --port "${PORT}" \
        --data-dir "${DATA_DIR}" \
        > "${LOG}" 2>&1 &
    local pid=$!
    # Wait up to 5 seconds for server to become reachable
    for i in {1..10}; do
        sleep 0.5
        if is_running; then
            echo "✓ Dolt server started (pid=${pid}, log=${LOG})"
            return 0
        fi
    done
    echo "✗ Server did not become reachable within 5 seconds"
    echo "  Check log: ${LOG}"
    cat "${LOG}" >&2
    return 1
}

stop_server() {
    if ! is_running; then
        echo "Dolt server is not running."
        return 0
    fi
    # Find the dolt sql-server process and kill it
    local pids
    pids=$(pgrep -f "dolt sql-server.*--port ${PORT}" 2>/dev/null || true)
    if [[ -n "${pids}" ]]; then
        echo "Stopping Dolt server (pid=${pids})..."
        kill ${pids} 2>/dev/null || true
        sleep 1
        echo "✓ Dolt server stopped"
    else
        echo "Could not find Dolt server process to stop."
    fi
}

check_status() {
    check_prereqs
    if is_running; then
        echo "✓ Dolt server running on ${HOST}:${PORT}"
        echo "  Data dir: ${DATA_DIR}"
        echo "  Log: ${LOG}"
    else
        echo "✗ Dolt server not running"
        echo "  Start with: .kilocode/tools/dolt_start.sh"
    fi
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
