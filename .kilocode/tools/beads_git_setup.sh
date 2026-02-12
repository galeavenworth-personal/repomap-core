#!/usr/bin/env bash
# Configure git merge driver for Beads JSONL files.

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

git config merge.beads.name "Beads JSONL merge"
git config merge.beads.driver "${ROOT_DIR}/.kilocode/tools/bd merge-driver %O %A %B"

echo "Configured merge.beads.driver:"
git config --get merge.beads.driver

echo "Attribute check for .beads/issues.jsonl:"
git check-attr merge -- .beads/issues.jsonl
