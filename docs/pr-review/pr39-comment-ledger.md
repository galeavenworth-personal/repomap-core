# PR #39 Comment Ledger

**PR:** [feat: update beads to v0.55.4 and implement cross-repo routing with routes.jsonl](https://github.com/galeavenworth-personal/repomap-core/pull/39)
**Branch:** `preflight-1` → `main`
**Reviewers:** augmentcode[bot], copilot-pull-request-reviewer

---

## Review Comments

### 1. `issue_prefix` → `issue-prefix` (augmentcode, medium)

- **File:** `.kilocode/skills/beads-local-db-ops/SKILL.md:23`
- **Issue:** YAML config uses `issue-prefix` (hyphenated) but docs used `issue_prefix` (underscored)
- **Action:** Fixed all 3 occurrences (lines 14, 22, 23) to match YAML config key `issue-prefix`
- **Status:** ✅ Resolved

### 2. Absolute path in handoff doc (augmentcode, low + copilot)

- **File:** `docs/infra/handoff-sdk-pivot-beads-2026-02-22.md:36`
- **Issue:** Absolute path `/home/galeavenworth/Projects-Employee-1/oc-daemon/.beads/routes.jsonl` is machine-specific
- **Action:** Replaced with relative path `../oc-daemon/.beads/routes.jsonl`
- **Status:** ✅ Resolved
- **Note:** Both augmentcode and copilot flagged this independently

### 3. Broken decision doc reference (copilot)

- **File:** `docs/infra/handoff-sdk-pivot-beads-2026-02-22.md:45`
- **Issue:** Link to `docs/research/sdk-prompt-api-pivot-decision-2026-02-22.md` broken — file exists locally but is gitignored (`docs/research/` excluded at `.gitignore:59`)
- **Action:** Removed markdown link, annotated as "local-only, gitignored — not tracked in repo"
- **Status:** ✅ Resolved

### 4. Missing `beads_install.sh` reference (copilot)

- **File:** `.kilocode/skills/beads-local-db-ops/SKILL.md:191`
- **Issue:** References `.kilocode/tools/beads_install.sh` which exists locally but is gitignored (`.gitignore:52`)
- **Action:** Annotated both references (lines 189, 195) as "local-only, gitignored" so readers know the script must be generated locally
- **Status:** ✅ Resolved

---

## Summary

| # | Reviewer | Severity | File | Status |
|---|----------|----------|------|--------|
| 1 | augmentcode | medium | SKILL.md | ✅ Fixed |
| 2 | augmentcode + copilot | low | handoff doc | ✅ Fixed |
| 3 | copilot | — | handoff doc | ✅ Fixed |
| 4 | copilot | — | SKILL.md | ✅ Fixed |

**SonarQube:** Quality Gate passed (0 new issues, 0 hotspots, 0% duplication)
