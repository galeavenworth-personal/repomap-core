#!/usr/bin/env bash
# Fail-fast preflight for Beads (`bd`) usage in workflows.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ ! -x "${ROOT_DIR}/.kilocode/tools/bd" ]]; then
  echo "ERROR: missing ${ROOT_DIR}/.kilocode/tools/bd" >&2
  exit 2
fi

if ! "${ROOT_DIR}/.kilocode/tools/bd" --version >/dev/null 2>&1; then
  echo "ERROR: bd not usable in this environment." >&2
  echo "Try: ${ROOT_DIR}/.kilocode/tools/beads_install.sh" >&2
  exit 2
fi

if [[ ! -d "${ROOT_DIR}/.beads" ]]; then
  echo "ERROR: .beads/ not initialized in this repo (run once per clone):" >&2
  echo "  ${ROOT_DIR}/.kilocode/tools/bd init" >&2
  exit 2
fi

echo "OK: bd present and .beads/ initialized"
