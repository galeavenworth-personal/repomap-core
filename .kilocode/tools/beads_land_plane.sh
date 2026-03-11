#!/usr/bin/env bash
# Thin bootstrap wrapper — delegates to TypeScript implementation.
#
# Usage:
#   .kilocode/tools/beads_land_plane.sh --bead-id <id> [--skip-gates --run-timestamp <ts>] [--no-sync]
#
# All logic lives in: daemon/src/infra/land-plane.ts
# See: repomap-core-76q.5

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

TSX="${ROOT_DIR}/daemon/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'npm install' in daemon/" >&2
  exit 1
fi

exec "$TSX" "${ROOT_DIR}/daemon/src/infra/land-plane.cli.ts" "$@"
