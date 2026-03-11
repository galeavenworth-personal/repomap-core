#!/usr/bin/env bash
# Thin bootstrap wrapper for Dolt server lifecycle management.
#
# Usage:
#   .kilocode/tools/dolt_start.sh          # Ensure correct server is running
#   .kilocode/tools/dolt_start.sh --check   # Check status only
#   .kilocode/tools/dolt_start.sh --stop    # Stop server
#
# All complex logic (database validation, rogue detection, process management,
# bd state cleanup) lives in daemon/src/infra/dolt-lifecycle.ts.
# This script only bootstraps: finds tsx, ensures node_modules, delegates.
#
# See: repomap-core-4hw

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DAEMON_DIR="${REPO_ROOT}/daemon"
CLI="${DAEMON_DIR}/src/infra/dolt-lifecycle.cli.ts"

die() { echo "ERROR: $*" >&2; exit 1; }

# ── Find tsx ──────────────────────────────────────────────────────────────
find_tsx() {
    # Prefer the daemon's local tsx
    if [[ -x "${DAEMON_DIR}/node_modules/.bin/tsx" ]]; then
        echo "${DAEMON_DIR}/node_modules/.bin/tsx"
        return 0
    fi
    # Fall back to global
    command -v tsx 2>/dev/null && return 0
    # Fall back to npx
    if command -v npx >/dev/null 2>&1; then
        echo "npx tsx"
        return 0
    fi
    return 1
}

# ── Ensure node_modules ──────────────────────────────────────────────────
ensure_deps() {
    if [[ ! -d "${DAEMON_DIR}/node_modules" ]]; then
        echo "Installing daemon dependencies (first run)..."
        (cd "${DAEMON_DIR}" && npm install --silent) || die "npm install failed"
    fi
}

# ── Map flags to CLI commands ─────────────────────────────────────────────
map_command() {
    case "${1:-}" in
        "")       echo "ensure" ;;
        --check)  echo "check" ;;
        --stop)   echo "stop" ;;
        --help|-h)
            echo "Usage: .kilocode/tools/dolt_start.sh [--check|--stop|--help]"
            echo "  (no args)  Ensure correct Dolt server is running"
            echo "  --check    Check server health status"
            echo "  --stop     Stop the server"
            echo ""
            echo "Logic: daemon/src/infra/dolt-lifecycle.ts"
            exit 0
            ;;
        *)  die "Unknown flag: $1. Use --help for usage." ;;
    esac
}

# ── Main ──────────────────────────────────────────────────────────────────
ensure_deps

TSX=$(find_tsx) || die "tsx not found. Run: cd daemon && npm install"
CMD=$(map_command "${1:-}")

# Forward env vars the TS module respects
export DOLT_DATA_DIR="${DOLT_DATA_DIR:-${HOME}/.dolt-data/beads}"
export DOLT_BIN="${DOLT_BIN:-}"

exec ${TSX} "${CLI}" "${CMD}"
