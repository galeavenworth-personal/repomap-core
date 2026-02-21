# PR #35 Comment Ledger

**PR:** feat: punch engine — mint/evaluate/checkpoint subcommands (repomap-core-4f0.15)
**Branch:** repomap-core-4f0.15
**Reviewers:** augmentcode[bot], Copilot
**Date:** 2026-02-21

## Deduplicated Review Comments (13 items)

Comments from Augment (4) and Copilot (11) consolidated. Two overlapping items deduplicated.

### HIGH Severity

| # | File | Line | Issue | Source |
|---|------|------|-------|--------|
| 1 | `.kilocode/tools/punch_engine.py` | 420,427 | `LAST_INSERT_ID()` is session-scoped but each `dolt_sql()` spawns a new process — checkpoint_id unreliable. Use single multi-statement query or re-query by unique constraint. | Augment+Copilot |

### MEDIUM Severity

| # | File | Line | Issue | Source |
|---|------|------|-------|--------|
| 2 | `.kilocode/tools/punch_engine.py` | 211 | `datetime.fromisoformat()` doesn't parse trailing `Z` in many Python versions — silently skips gate punches. Normalize `Z` to `+00:00`. | Augment |
| 3 | `.kilocode/tools/punch_engine.py` | 378 | Empty requirements from `_fetch_card_requirements()` → false PASS. Guard for nonexistent card_id. | Augment |
| 4 | `.kilocode/commands.toml` | 354-356 | `punch_mint` command missing `--bead-id` parameter in template. | Augment+Copilot |

### LOW / Code Quality

| # | File | Line | Issue | Source |
|---|------|------|-------|--------|
| 5 | `.kilocode/tools/punch_engine.py` | 477 | Inconsistent status case — `cmd_evaluate` returns uppercase but checkpoint checks `.lower()`. Normalize to lowercase throughout. | Copilot |
| 6 | `.kilocode/tools/punch_engine.py` | 68 | `load_ui_messages` no JSON error handling — unhandled `JSONDecodeError` on corrupt file. | Copilot |
| 7 | `.kilocode/tools/punch_engine.py` | 190 | `_extract_gate_punches` no `OSError` handling when reading `gate_runs.jsonl`. | Copilot |
| 8 | `.kilocode/tools/punch_engine.py` | 480 | Silent failure when `_update_checkpoint_commit_hash` fails — log a warning. | Copilot |
| 9 | `.kilocode/tools/punch_engine.py` | 157 | Command text truncated to 200 chars without truncation indicator (`...`). | Copilot |
| 10 | `.kilocode/tools/punch_engine.py` | 65 | Path traversal vulnerability in `task_id` — validate stays within `TASKS_DIR`. | Copilot |
| 11 | `.kilocode/tools/punch_engine.py` | 525 | `main()` doesn't return exit code / use `sys.exit()`. | Copilot |
| 12 | `.kilocode/tools/punch_engine.py` | 175 | Missing `continue` after `subtask_result` handler — falls through to return correctly but inconsistent. | Copilot |
| 13 | `.kilocode/tools/punch_engine.py` | 271 | Batch INSERT has no size limit — add batch size cap (e.g., 1000). | Copilot |

## Resolution Status

| # | Status | Commit |
|---|--------|--------|
| 1 | RESOLVED | pr35-review-fixes |
| 2 | RESOLVED | pr35-review-fixes |
| 3 | RESOLVED | pr35-review-fixes |
| 4 | RESOLVED | pr35-review-fixes |
| 5 | RESOLVED | pr35-review-fixes |
| 6 | RESOLVED | pr35-review-fixes |
| 7 | RESOLVED | pr35-review-fixes |
| 8 | RESOLVED | pr35-review-fixes |
| 9 | RESOLVED | pr35-review-fixes |
| 10 | RESOLVED | pr35-review-fixes |
| 11 | RESOLVED | pr35-review-fixes |
| 12 | RESOLVED | pr35-review-fixes |
| 13 | RESOLVED | pr35-review-fixes |
