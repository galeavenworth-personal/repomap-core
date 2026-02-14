#!/usr/bin/env bash
# Reconcile Beads task state with merged GitHub PRs.
#
# Purpose:
# - Prevent workflow state drift where a PR is merged but the corresponding Beads issue remains OPEN.
# - Provide a bounded, explicit, deterministic helper for orchestration workflows.
#
# Usage:
#   .kilocode/tools/bd_reconcile_merged_prs.sh <task-id> [<task-id> ...]
#   .kilocode/tools/bd_reconcile_merged_prs.sh --dry-run <task-id> [<task-id> ...]
#
# Options:
#   --dry-run   Do not mutate Beads; just report what would be closed.
#   --strict    Fail (exit 2) if `gh` is missing, `gh` queries fail, or `bd close` fails.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BD="${ROOT_DIR}/.kilocode/tools/bd"

DRY_RUN=0
STRICT=0
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --help|-h)
      echo "Usage: .kilocode/tools/bd_reconcile_merged_prs.sh [--dry-run] [--strict] <task-id> [<task-id> ...]" >&2
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [[ "$#" -lt 1 ]]; then
  echo "Usage: .kilocode/tools/bd_reconcile_merged_prs.sh [--dry-run] [--strict] <task-id> [<task-id> ...]" >&2
  exit 2
fi

if [[ ! -x "${BD}" ]]; then
  echo "ERROR: missing ${BD}" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  if [[ "${STRICT}" == "1" ]]; then
    echo "ERROR: gh CLI not found on PATH (cannot reconcile merged PRs)." >&2
    exit 2
  fi
  for TASK_ID in "$@"; do
    echo "${TASK_ID}: WARN gh missing; reconciliation skipped (no-op)" >&2
    echo "${TASK_ID}: reconciliation skipped (gh missing)"
  done
  exit 0
fi

for TASK_ID in "$@"; do
  # Bounded query: at most 1 merged PR with head branch equal to task id.
  # Note: `--head` filters by head ref name; this matches our convention of naming branches after task ids.
  # Ensure `gh` runs against the repository at ROOT_DIR even if the caller's CWD differs.
  GH_OUT="$(cd "${ROOT_DIR}" && gh pr list --state merged --head "${TASK_ID}" -L 1 --json number,url,title,mergedAt 2>&1)" || {
    # Keep output bounded: collapse whitespace + truncate.
    GH_OUT_ONE_LINE="$(echo "${GH_OUT}" | tr '\n' ' ' | tr -s ' ')"
    GH_OUT_TRUNC="${GH_OUT_ONE_LINE:0:200}"
    if [[ "${STRICT}" == "1" ]]; then
      echo "ERROR: gh query failed for ${TASK_ID}: ${GH_OUT_TRUNC}" >&2
      exit 2
    fi
    echo "${TASK_ID}: WARN gh query failed; reconciliation skipped (${GH_OUT_TRUNC})" >&2
    echo "${TASK_ID}: reconciliation skipped (gh error)"
    continue
  }

  MERGED_JSON="${GH_OUT}"
  if [[ "${MERGED_JSON}" == "[]" || -z "${MERGED_JSON}" ]]; then
    echo "${TASK_ID}: no merged PR found (no-op)"
    continue
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "${TASK_ID}: merged PR found (dry-run; would close in Beads)"
    continue
  fi

  BD_OUT="$("${BD}" close "${TASK_ID}" 2>&1)" || {
    # Keep output bounded: collapse whitespace + truncate.
    BD_OUT_ONE_LINE="$(echo "${BD_OUT}" | tr '\n' ' ' | tr -s ' ')"
    BD_OUT_TRUNC="${BD_OUT_ONE_LINE:0:200}"
    if [[ "${STRICT}" == "1" ]]; then
      echo "ERROR: bd close failed for ${TASK_ID}: ${BD_OUT_TRUNC}" >&2
      exit 2
    fi
    echo "${TASK_ID}: WARN bd close failed; continuing (${BD_OUT_TRUNC})" >&2
    echo "${TASK_ID}: merged PR found; FAILED to close in Beads"
    continue
  }

  # `bd close` succeeded.
  echo "${TASK_ID}: merged PR found; closed in Beads"
done
