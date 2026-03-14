#!/usr/bin/env bash
# Thin bootstrap wrapper for stack manager.
#
# Usage:
#   .kilocode/tools/start-stack.sh           # Idempotent full stack startup (all 5 components)
#   .kilocode/tools/start-stack.sh --check   # Check stack health only
#   .kilocode/tools/start-stack.sh --stop    # Stop managed components
#
# All complex logic (health checks, start/stop sequences, port checking,
# pm2 management) lives in daemon/src/infra/stack-manager.ts.
# This script only bootstraps: finds tsx, ensures node_modules, delegates.
#
# See: repomap-core-76q.2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DAEMON_DIR="${REPO_ROOT}/daemon"
CLI="${DAEMON_DIR}/src/infra/stack-manager.cli.ts"

die() { echo "ERROR: $*" >&2; exit 1; }

# ── Find tsx ──────────────────────────────────────────────────────────────
find_tsx() {
    if [[ -x "${DAEMON_DIR}/node_modules/.bin/tsx" ]]; then
        echo "${DAEMON_DIR}/node_modules/.bin/tsx"
        return 0
    fi
    if command -v tsx >/dev/null 2>&1; then
        command -v tsx
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
    return 0
}

# ── Map flags to CLI commands ─────────────────────────────────────────────
map_command() {
    local flag="${1:-}"
    case "${flag}" in
        ""|--ensure|--with-kilo) echo "start" ;;
        --check)    echo "check" ;;
        --stop)     echo "stop" ;;
        --help|-h)
            echo "Usage: .kilocode/tools/start-stack.sh [--ensure|--with-kilo|--check|--stop|--help]"
            echo "  (no args)    Idempotent full stack startup (all 5 components)"
            echo "  --ensure     Legacy alias for default startup"
            echo "  --with-kilo  Legacy alias for default startup"
            echo "  --check      Check stack health status"
            echo "  --stop       Stop managed components"
            echo ""
            echo "Logic: daemon/src/infra/stack-manager.ts"
            exit 0
            ;;
        *)  die "Unknown flag: ${flag}. Use --help for usage." ;;
    esac
}

# ── Main ──────────────────────────────────────────────────────────────────
if [[ "${FACTORY_REQUIRE_ROOT:-}" == "1" || "${FACTORY_REQUIRE_ROOT:-}" == "true" ]]; then
    "$SCRIPT_DIR/require_factory_root.sh" "$REPO_ROOT"
fi

ensure_deps

TSX=$(find_tsx) || die "tsx not found. Run: cd daemon && npm install"
CMD=$(map_command "${1:-}")

# Forward env vars the TS module respects
export REPO_ROOT
export KILO_HOST="${KILO_HOST:-127.0.0.1}"
export KILO_PORT="${KILO_PORT:-4096}"
export TEMPORAL_PORT="${TEMPORAL_PORT:-7233}"
export TEMPORAL_UI_PORT="${TEMPORAL_UI_PORT:-8233}"
export DOLT_PORT="${DOLT_PORT:-3307}"
export DOLT_DATABASE="${DOLT_DATABASE:-factory}"
export DOLT_DATA_DIR="${DOLT_DATA_DIR:-${HOME}/.dolt-data/beads}"
export DOLT_BIN="${DOLT_BIN:-}"

exec ${TSX} "${CLI}" "${CMD}"
