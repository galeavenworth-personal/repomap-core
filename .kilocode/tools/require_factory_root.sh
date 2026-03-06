#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_FILE="${FACTORY_ROOT_CONFIG:-$REPO_ROOT/.kilocode/factory-root.json}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

require_root_enabled() {
  case "${FACTORY_REQUIRE_ROOT:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if ! require_root_enabled; then
  exit 0
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  if require_root_enabled; then
    echo "FATAL: factory root config not found: $CONFIG_FILE" >&2
    exit 64
  fi
  exit 0
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "FATAL: python3 is required to parse $CONFIG_FILE" >&2
  exit 127
fi

REQUIRED_REPO_ROOT="$($PYTHON_BIN - "$CONFIG_FILE" <<'PY'
import json, sys
from pathlib import Path
config_path = Path(sys.argv[1])
obj = json.loads(config_path.read_text())
value = obj.get('required_repo_root')
if not isinstance(value, str) or not value.strip():
    raise SystemExit('FATAL: required_repo_root missing or invalid in ' + str(config_path))
print(value)
PY
)"

ACTUAL_REPO_ROOT="${1:-$REPO_ROOT}"
ACTUAL_REPO_ROOT="$(cd "$ACTUAL_REPO_ROOT" && pwd)"
REQUIRED_REPO_ROOT="$(cd "$REQUIRED_REPO_ROOT" && pwd)"

if [[ "$ACTUAL_REPO_ROOT" != "$REQUIRED_REPO_ROOT" ]]; then
  echo "FATAL: factory operations are pinned to: $REQUIRED_REPO_ROOT" >&2
  echo "FATAL: current repo root is: $ACTUAL_REPO_ROOT" >&2
  echo "FATAL: rerun this command from the configured factory root or update .kilocode/factory-root.json" >&2
  exit 64
fi
