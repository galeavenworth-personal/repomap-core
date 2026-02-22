# PR #38 Comment Ledger

**PR:** [#38 — Repomap core 9bg](https://github.com/galeavenworth-personal/repomap-core/pull/38)
**Branch:** `repomap-core-9bg` → `main`
**Reviewers:** augmentcode[bot], copilot-pull-request-reviewer

## Review Comments

### Comment 1 (augmentcode[bot]) — HIGH severity

**File:** `.kilocode/workflows/fix-ci.md:4` (+ 4 other locations)
**Issue:** Workflows declare `punch_card:` frontmatter IDs (`fix-ci`, `fitter-line-health`, `friction-audit`, `refactor`, `respond-to-pr-review`) but no seeded punch-card definitions exist in `plans/punch-card-schema.sql` or `.kilocode/tools/dolt_punch_init.sh`. `punch_engine.py checkpoint` would fail with `FAIL: no requirements found for card_id ...`.

**Resolution:** Added 5 new punch card seed INSERT blocks to both `plans/punch-card-schema.sql` and `.kilocode/tools/dolt_punch_init.sh` with appropriate requirements per workflow:
- `fix-ci`: 4 quality gate passes + cost checkpoint
- `fitter-line-health`: workflow-gate pass + task_exit + cost checkpoint
- `friction-audit`: process_thought MCP call + task_exit + cost checkpoint
- `refactor`: 4 quality gate passes + process_thought + codebase_retrieval + cost checkpoint
- `respond-to-pr-review`: 4 quality gate passes + cost checkpoint

**Status:** ✅ Resolved

---

### Comment 2 (augmentcode[bot]) — MEDIUM severity

**File:** `.kilocode/workflows/fix-ci.md:200` (+ 4 other locations)
**Issue:** `commands.punch_mint` in `commands.toml` resolves to `punch_engine.py mint {task_id} --bead-id {bead_id}`, but workflow docs say `... mint {task_id}` (missing `--bead-id`).

**Resolution:** Updated "Resolves to" strings in all 5 workflow files to include `--bead-id {bead_id}`, matching the actual `commands.toml` route.

**Status:** ✅ Resolved

## Automated Reviews (No Action Required)

- **copilot-pull-request-reviewer:** Reviewed 5 of 6 changed files, generated no comments.
- **sonarqubecloud:** Quality Gate passed — 0 new issues, 0 accepted issues, 0 Security Hotspots.

## Summary

| Comment | Reviewer | Severity | Status |
|---------|----------|----------|--------|
| Missing punch card seeds | augmentcode[bot] | HIGH | ✅ Resolved |
| Misaligned punch_mint docs | augmentcode[bot] | MEDIUM | ✅ Resolved |
