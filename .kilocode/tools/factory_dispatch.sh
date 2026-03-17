#!/usr/bin/env bash
# =============================================================================
# factory_dispatch.sh — Thin bootstrap wrapper for TypeScript factory dispatch
# =============================================================================
#
# Delegates all logic to daemon/src/infra/factory-dispatch.cli.ts.
# This wrapper ensures node_modules are installed and tsx is available,
# then execs the TypeScript CLI with all arguments forwarded.
#
# Usage: factory_dispatch.sh [OPTIONS] [<prompt-file-or-string>]
# See:   npx tsx daemon/src/infra/factory-dispatch.cli.ts --help
#
# Exit codes match the TypeScript implementation (0–6).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ "${FACTORY_REQUIRE_ROOT:-}" == "1" || "${FACTORY_REQUIRE_ROOT:-}" == "true" ]]; then
    "$SCRIPT_DIR/require_factory_root.sh" "$REPO_ROOT"
fi

DAEMON_DIR="$REPO_ROOT/daemon"
TSX="$DAEMON_DIR/node_modules/.bin/tsx"
CLI="$DAEMON_DIR/src/infra/factory-dispatch.cli.ts"

# Ensure node_modules exist
if [[ ! -x "$TSX" ]]; then
    echo "[factory] Installing daemon dependencies..." >&2
    (cd "$DAEMON_DIR" && npm install --silent)
fi

exec "$TSX" "$CLI" "$@"
