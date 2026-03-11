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

# Require Node.js (tsx is a devDependency in daemon/)
if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx not found. Install Node.js >= 22." >&2
  exit 2
fi

exec npx --prefix "${ROOT_DIR}/daemon" tsx "${ROOT_DIR}/daemon/src/infra/land-plane.cli.ts" "$@"
