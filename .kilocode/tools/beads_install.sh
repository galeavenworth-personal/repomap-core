#!/usr/bin/env bash
# Install a pinned Beads CLI (`bd`) into a versioned, user-local prefix.
#
# Rationale:
# - Avoids system-wide installs.
# - Allows multiple projects to pin different Beads versions concurrently.
# - Deterministic: explicit version pin.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BEADS_VERSION="${BEADS_VERSION:-$(cat "${SCRIPT_DIR}/beads_version")}" 
BEADS_PREFIX_BASE="${BEADS_PREFIX_BASE:-${HOME}/.local/beads}"
PREFIX="${BEADS_PREFIX_BASE}/${BEADS_VERSION}"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found; required to install Beads in this environment." >&2
  echo "Install Node/npm, or use an alternative upstream install method." >&2
  exit 2
fi

mkdir -p "${PREFIX}"

echo "Installing @beads/bd@${BEADS_VERSION} into ${PREFIX} ..."
npm install -g --prefix "${PREFIX}" "@beads/bd@${BEADS_VERSION}"

echo "Installed: ${PREFIX}/bin/bd"
"${PREFIX}/bin/bd" --version
