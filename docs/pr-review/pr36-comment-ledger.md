# PR #36 Comment Ledger

**PR:** chore: retrofit session lifecycle workflows with commands.toml discipline + punch card exit gates (repomap-core-4r3)
**Reviewers:** augmentcode[bot], copilot-pull-request-reviewer
**Resolution date:** 2026-02-21

## Comments Resolved

### 1. JSONL gitignore blocks cross-clone interchange (Augment, medium)

**File:** `.kilocode/commands.toml:96` + `.kilocode/workflows/beads-sync.md:41,71,74` + `.kilocode/workflows/load-game.md:195`
**Issue:** `export_beads`/`import_beads` rely on `.beads/issues.jsonl`, but it was gitignored. Cross-clone interchange via git wouldn't propagate state.
**Fix:** Un-ignored `.beads/issues.jsonl` in `.gitignore` (now tracked for Dolt-based two-clone model). Updated `.gitignore` comment to reflect Dolt backend model. Updated `commands.toml` notes. Added explicit `git add`/`commit`/`push` instructions to `beads-sync.md` export step.

### 2. bd doctor vs bd_doctor_safe.sh route mismatch (Augment, medium + Copilot)

**File:** `.kilocode/workflows/beads-sync.md:32`
**Issue:** Route annotation `<!-- route: diagnose_issues -->` points to `bd_doctor_safe.sh` in commands.toml, but the code block runs `.kilocode/tools/bd doctor`.
**Fix:** Changed code block to use `.kilocode/tools/bd_doctor_safe.sh` to match the `diagnose_issues` route binding.

### 3. format_ruff missing from quality gate snippet (Augment, low)

**File:** `.kilocode/workflows/load-game.md:150`
**Issue:** Route annotation includes `format_ruff` but the snippet only runs `ruff check` and `mypy`, not `ruff format --check`.
**Fix:** Added `.venv/bin/python -m ruff format --check . --quiet` to the quality gate snippet.

### 4. gate_quality not in Commands Referenced table (Copilot)

**File:** `.kilocode/workflows/save-game.md:87`
**Issue:** Route annotation references `gate_quality` (composite command) not listed in the Commands Referenced table.
**Fix:** Added `gate_quality` to the Commands Referenced table as a composite route with purpose description.

### 5. export_beads in Commands Referenced but unused (Copilot)

**File:** `.kilocode/workflows/save-game.md:26`
**Issue:** `export_beads` listed in Commands Referenced table but not referenced in any workflow step.
**Fix:** Removed `export_beads` from the save-game Commands Referenced table (beads export is a beads-sync concern, not a save-game concern).

### 6. Inconsistent column header "Tool" vs "Purpose" (Copilot)

**File:** `.kilocode/workflows/beads-sync.md:23`
**Issue:** Commands Referenced table uses "Tool" column header while save-game.md and load-game.md use "Purpose".
**Fix:** Changed column header from "Tool" to "Purpose" and replaced tool paths with purpose descriptions for consistency.

## Files Modified

- `.gitignore` — Un-ignored `.beads/issues.jsonl`, updated comment
- `.kilocode/commands.toml` — Updated `export_beads` notes
- `.kilocode/workflows/beads-sync.md` — Fixed route mismatch, column header, added git instructions
- `.kilocode/workflows/load-game.md` — Added missing `ruff format --check` to quality gate snippet
- `.kilocode/workflows/save-game.md` — Added `gate_quality` to table, removed unused `export_beads`
