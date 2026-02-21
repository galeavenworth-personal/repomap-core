# PR #37 Comment Ledger

**PR:** Retrofit prep-task.md and codebase-exploration.md with commands.toml discipline + punch card exit gates (repomap-core-nqk)
**Reviewers:** augmentcode[bot], copilot-pull-request-reviewer
**Resolution date:** 2026-02-21

## Comments Resolved

### 1. punch_mint Resolves-to omits --bead-id placeholder (Augment, medium)

**File:** `.kilocode/workflows/codebase-exploration.md:203` + `.kilocode/workflows/prep-task.md:320`
**Issue:** `Resolves to:` example for `commands.punch_mint` shows `python3 .kilocode/tools/punch_engine.py mint {task_id}` but `commands.toml:374` includes `--bead-id {bead_id}` in the tool string. Template and docs were misaligned.
**Fix:** Updated both workflow docs to include `--bead-id {bead_id}` in the `Resolves to:` line, matching the authoritative `commands.toml` template.

### 2. prep-task punch card definition missing from dolt_punch_init.sh (Copilot)

**File:** `.kilocode/workflows/prep-task.md:11`
**Issue:** Punch card `prep-task` (5 rows, 4 required) referenced in workflow frontmatter but no INSERT statements existed in `dolt_punch_init.sh`.
**Fix:** Added `prep-task` punch card INSERT block to `dolt_punch_init.sh` with 5 rows: process_thought (required), codebase___retrieval (required), generate_summary (required), export_session (required), cost_checkpoint (optional).

### 3. prep-task punch card checkpoint will fail at runtime (Copilot)

**File:** `.kilocode/workflows/prep-task.md:324`
**Issue:** EXIT GATE checkpoint section references `prep-task` punch card that didn't exist — runtime failure guaranteed.
**Fix:** Resolved by Fix #2 — punch card definition now exists in `dolt_punch_init.sh`.

### 4. codebase-exploration punch card definition missing from dolt_punch_init.sh (Copilot)

**File:** `.kilocode/workflows/codebase-exploration.md:10`
**Issue:** Punch card `codebase-exploration` (3 rows, 2 required) referenced in workflow frontmatter but no INSERT statements existed in `dolt_punch_init.sh`.
**Fix:** Added `codebase-exploration` punch card INSERT block to `dolt_punch_init.sh` with 3 rows: codebase___retrieval (required), read_file (required), cost_checkpoint (optional).

### 5. codebase-exploration punch card checkpoint will fail at runtime (Copilot)

**File:** `.kilocode/workflows/codebase-exploration.md:207`
**Issue:** EXIT GATE checkpoint section references `codebase-exploration` punch card that didn't exist — runtime failure guaranteed.
**Fix:** Resolved by Fix #4 — punch card definition now exists in `dolt_punch_init.sh`.

## Files Modified

- `.kilocode/workflows/codebase-exploration.md` — Updated punch_mint Resolves-to to include `--bead-id {bead_id}`
- `.kilocode/workflows/prep-task.md` — Updated punch_mint Resolves-to to include `--bead-id {bead_id}`
- `.kilocode/tools/dolt_punch_init.sh` — Added prep-task (5 rows) and codebase-exploration (3 rows) punch card INSERT statements
