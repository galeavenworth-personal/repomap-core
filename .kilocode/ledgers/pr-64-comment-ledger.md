# Comment Ledger — PR #64

**PR:** [Repomap core 1ax](https://github.com/galeavenworth-personal/repomap-core/pull/64)  
**Branch:** `repomap-core-1ax` → `main`  
**State:** OPEN  
**Molecule:** repomap-core-mol-yi91  
**Formula step:** 1 of respond-to-pr-review  
**Ledger built:** 2026-03-14  

---

## SonarQube Quality Gate

**Status:** ❌ ERROR (FAILING)

| Metric | Status | Threshold | Actual |
|---|---|---|---|
| new_reliability_rating | ✅ OK | A (1) | A (1) |
| new_security_rating | ✅ OK | A (1) | A (1) |
| new_maintainability_rating | ✅ OK | A (1) | A (1) |
| new_duplicated_lines_density | ✅ OK | 3% | 0.0% |
| **new_security_hotspots_reviewed** | **❌ ERROR** | **100%** | **66.7%** |

**Blocking condition:** 1 unreviewed Security Hotspot out of 3 introduced by this PR.

---

## SonarQube Issues (PR-scoped)

### Issue 1 — `shelldre:S7682` MAJOR
- **File:** `.kilocode/tools/start-stack.sh`
- **Line:** 22
- **Message:** "Add an explicit return statement at the end of the function."
- **Category:** CODE_SMELL / MAINTAINABILITY
- **Rule:** Functions should end with explicit `return` statement
- **Issue key:** `AZzuKa1193q8aLTr6crs`
- **Status:** OPEN

### Issue 2 — `shelldre:S7682` MAJOR
- **File:** `.kilocode/tools/start-stack.sh`
- **Line:** 47
- **Message:** "Add an explicit return statement at the end of the function."
- **Category:** CODE_SMELL / MAINTAINABILITY
- **Rule:** Functions should end with explicit `return` statement
- **Issue key:** `AZzuKa1193q8aLTr6crt`
- **Status:** OPEN

---

## Inline Review Comments

### Thread 1 — DATA INTEGRITY BUG (HIGH)
- **Reviewer:** augmentcode[bot]
- **File:** `daemon/src/writer/index.ts`
- **Line:** 347
- **Comment ID:** `r2935826727`
- **URL:** https://github.com/galeavenworth-personal/repomap-core/pull/64#discussion_r2935826727
- **Body:**
  > `writeTask()` now supplies non-NULL defaults (`"unknown"`, `"running"`, `0`) when the incoming payload omits `model`/`status`/`costUsd`, which means the upsert can overwrite previously-correct DB values despite the `COALESCE(VALUES(...), ...)` intent. This could regress task history (e.g., `completed` → `running`, nonzero cost → `0`) when partial updates are written.
- **Action required:** Fix `writeTask()` to not overwrite existing DB values with fallback defaults when fields are omitted from payload.

---

### Thread 2 — DATA INTEGRITY BUG (HIGH) [Copilot duplicate of Thread 1]
- **Reviewer:** Copilot
- **File:** `daemon/src/writer/index.ts`
- **Line:** 349
- **Comment ID:** `r2935828917`
- **URL:** https://github.com/galeavenworth-personal/repomap-core/pull/64#discussion_r2935828917
- **Body:**
  > `writeTask()`: setting default values for model/status/cost_usd in the INSERT values defeats the ON DUPLICATE KEY UPDATE COALESCE(...) logic. When a subsequent writeTask call has model/status/costUsd undefined, it will now update the existing row to ('unknown','running',0) instead of preserving the previous real values. Consider keeping the "preserve existing value when field is missing" behavior by making the UPDATE clause conditional on whether the caller actually provided each field (e.g., pass boolean flags or use CASE/IF to skip updates when the incoming value is just the fallback default).
- **Action required:** Same as Thread 1 — conditionally skip UPDATE for fields where caller did not provide a value.

---

### Thread 3 — SHELL STARTUP BRITTLENESS (MEDIUM)
- **Reviewer:** augmentcode[bot]
- **File:** `daemon/src/infra/stack-manager.ts`
- **Line:** 339
- **Comment ID:** `r2935826728`
- **URL:** https://github.com/galeavenworth-personal/repomap-core/pull/64#discussion_r2935826728
- **Body:**
  > The `nohup kilo serve ... & disown` launch depends on `disown` behavior inside a non-interactive `bash -c`; if `disown` errors, `execFileSync` will throw and `ensureKilo()` will fail even if `kilo serve` did start. This can make stack startup brittle across environments/shell configs.
- **Action required:** Make `ensureKilo()` tolerant of `disown` failures, or use a spawn-based approach that doesn't rely on `disown` in non-interactive shells.

---

### Thread 4 — CLI HELP/DEFAULT MISMATCH (LOW)
- **Reviewer:** augmentcode[bot]
- **File:** `daemon/src/infra/stack-manager.cli.ts`
- **Line:** 79
- **Comment ID:** `r2935826729`
- **URL:** https://github.com/galeavenworth-personal/repomap-core/pull/64#discussion_r2935826729
- **Body:**
  > The `--help` output says `start` is the default command, but the code still defaults `command` to `"ensure"` (which is now treated as an alias of start). This mismatch may confuse users/scripts relying on the help text.
- **Action required:** Either change default from `"ensure"` to `"start"` or update help text to reflect the actual default.

---

### Thread 5 — CLI HELP/DEFAULT MISMATCH (LOW) [Copilot duplicate of Thread 4]
- **Reviewer:** Copilot
- **File:** `daemon/src/infra/stack-manager.cli.ts`
- **Line:** 79
- **Comment ID:** `r2935828910`
- **URL:** https://github.com/galeavenworth-personal/repomap-core/pull/64#discussion_r2935828910
- **Body:**
  > CLI help text says `start` is the default command, but `command` defaults to "ensure" (argv[2] ?? "ensure") and `ensure`/`start`/`with-kilo` are just aliases. To avoid confusing users (and keep direct CLI usage consistent with the wrapper script), consider either changing the default to "start" or updating the help output to reflect the actual default/aliases.
- **Action required:** Same as Thread 4.

---

### Thread 6 — UNDOCUMENTED LEGACY FLAGS (LOW)
- **Reviewer:** Copilot
- **File:** `.kilocode/tools/start-stack.sh`
- **Line:** 57
- **Comment ID:** `r2935828912`
- **URL:** https://github.com/galeavenworth-personal/repomap-core/pull/64#discussion_r2935828912
- **Body:**
  > `start-stack.sh` help text no longer mentions `--ensure`/`--with-kilo`, but `map_command` still accepts them and maps them to `"start"`. Either document these legacy flags in the help output or remove them from `map_command` so the interface is self-consistent.
- **Action required:** Either add `--ensure`/`--with-kilo` to help text or remove them from `map_command`.

---

## Suppressed / Low-Confidence Comments (Not requiring action)

### Suppressed — PM2 disconnect leak on timeout
- **Reviewer:** Copilot (suppressed — low confidence)
- **File:** `daemon/src/infra/pm2-client.ts`
- **Line:** 24
- **Note:** If timeout fires, `withPm2Connection()` throws before try/finally, leaving lingering PM2 handles. Copilot suppressed this as low confidence. Not included as a required action item.

---

## Action Item Summary

| # | File | Line | Severity | Description | Reviewers |
|---|------|------|----------|-------------|-----------|
| 1 | `daemon/src/writer/index.ts` | 347–349 | HIGH | `writeTask()` non-null defaults defeat COALESCE upsert logic | augmentcode, Copilot |
| 2 | `daemon/src/infra/stack-manager.ts` | 339 | MEDIUM | `nohup...& disown` brittle in non-interactive bash | augmentcode |
| 3 | `daemon/src/infra/stack-manager.cli.ts` | 79 | LOW | CLI help says `start` is default but code uses `"ensure"` | augmentcode, Copilot |
| 4 | `.kilocode/tools/start-stack.sh` | 57 | LOW | Legacy `--ensure`/`--with-kilo` flags not documented | Copilot |
| 5 | `.kilocode/tools/start-stack.sh` | 22 | MAJOR | SonarQube: missing explicit `return` at end of function | SonarQube |
| 6 | `.kilocode/tools/start-stack.sh` | 47 | MAJOR | SonarQube: missing explicit `return` at end of function | SonarQube |
| 7 | (SonarQube gate) | — | BLOCKER | 1 unreviewed Security Hotspot (gate requires 100% review) | SonarQube |

---

## Deduplication Notes

- Threads 1+2 address the same bug in `writeTask()` (lines 347 and 349 of same file). Fix once.
- Threads 4+5 address the same CLI default mismatch (line 79 of same file). Fix once.
- SonarQube issues 5+6 are in the same file; fix both in a single edit.
