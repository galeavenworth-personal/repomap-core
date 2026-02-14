#!/usr/bin/env bash
# Run `bd doctor` if supported by the pinned Beads version.
#
# Rationale:
# - `bd doctor` is a helpful hygiene step but may not exist in older pinned versions.
# - Workflows should remain deterministic and not hard-fail on an optional subcommand.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BD="${ROOT_DIR}/.kilocode/tools/bd"

if [[ ! -x "${BD}" ]]; then
  echo "ERROR: missing ${BD}" >&2
  exit 2
fi

HELP_OUT="$(${BD} --help 2>&1 || true)"
if echo "${HELP_OUT}" | grep -Eq '(^|[[:space:]])doctor($|[[:space:]])'; then
  "${BD}" doctor
  exit 0
fi

echo "WARN: 'bd doctor' not supported by this pinned bd version; skipping." >&2
exit 0

