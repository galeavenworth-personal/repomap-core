# PR #34 Comment Ledger

**PR:** feat(plugins): cross-database beads status sync plugin (repomap-core-i9b)
**Reviewers:** Augment (3 comments), Copilot (13 comments)
**Date:** 2026-02-21
**Status:** Resolved

## Deduplicated Issues (12 unique → 9 accepted, 3 rejected)

### `.opencode/plugins/beads-cross-db-sync.ts`

| # | Issue | Reviewers | Severity | Disposition | Resolution |
|---|-------|-----------|----------|-------------|------------|
| 1 | `parseTableRows()` scrapes pipe-delimited table output — brittle across Dolt versions; column count not validated | Augment #1, Copilot #5, Copilot #6 | Low | **Accept** | Switch to `--result-format csv` in `doltSql`; replace `parseTableRows` with CSV line parser; validate column count before index access |
| 2 | NULL prefix from `routes.prefix` passes truthy filter → `beads_NULL` DB name; insufficient prefix validation | Augment #2, Copilot #12 | Low | **Accept** | Apply `normalizeCell` before truthy filter; add regex validation (`/^[A-Za-z][A-Za-z0-9_-]*$/`) on prefixes |
| 3 | `dolt_commit` unconditionally after UPDATE creates noisy "nothing to commit" warnings / empty commits | Augment #3, Copilot #7 | Medium | **Accept** | Check `dolt_status` for clean working set before committing; treat "nothing to commit" as normal skip |
| 4 | Regex allows issue IDs starting with digit; beads IDs always start with letter | Copilot #1 | Low | **Accept** | Change leading char class from `[A-Za-z0-9]` to `[A-Za-z]` |
| 5 | Exit code check passes through on undefined/null exitCode | Copilot #3 | Medium | **Accept** | Require `exitCode === 0` explicitly; return early on any non-zero or non-number value |
| 6 | Prefix used in DB name construction not validated — defense-in-depth | Copilot #4 | Low | **Accept** | Validate `currentPrefix` with `/^[A-Za-z][A-Za-z0-9_-]*$/` before `beads_${prefix}` construction |
| 7 | `doltSql` has no timeout — could block plugin indefinitely | Copilot #8 | Medium | **Accept** | Add 30s `timeout` wrapper to dolt CLI invocation |
| 8 | Missing file-level JSDoc documentation | Copilot #11 | Low | **Accept** | Add comprehensive header comment matching `beads-sync.ts` convention |
| 9 | `pendingBdStatusOps` Map race conditions with concurrent tool executions | Copilot #2 | Low | **Reject** | OpenCode hooks are sequential per-agent; callID-keyed Map prevents cross-operation collision. Theoretical only. |
| 10 | Hardcoded Dolt credentials/connection — should use env vars | Copilot #9 | Low | **Reject** | Explicitly a local-only dev tool with known Dolt config; env var parameterization is over-engineered. Document assumptions in header comment instead. |
| 11 | Serial peer operations could be parallelized | Copilot #10 | Low | **Reject** | ~2-3 peer DBs in practice; serialization is simpler and avoids Dolt resource contention. Premature optimization. |
| 12 | Multi-statement SQL (USE + query) should be split | Copilot #13 | Low | **Reject** | Dolt CLI natively supports multi-statement with `-q`; error output identifies failing statement. Splitting adds complexity without benefit. |

## Comment ID Cross-Reference

| Augment ID | Copilot ID | Issue # |
|------------|-----------|---------|
| 2836156365 | 2836158217, 2836158221 | 1 |
| 2836156367 | 2836158246 | 2 |
| 2836156369 | 2836158223 | 3 |
| — | 2836158199 | 4 |
| — | 2836158206 | 5 |
| — | 2836158211 | 6 |
| — | 2836158225 | 7 |
| — | 2836158244 | 8 |
| — | 2836158203 | 9 |
| — | 2836158233 | 10 |
| — | 2836158237 | 11 |
| — | 2836158252 | 12 |
