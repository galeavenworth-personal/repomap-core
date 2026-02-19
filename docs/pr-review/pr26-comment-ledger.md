# PR #26 Comment Ledger

**PR:** galeavenworth-personal/repomap-core #26
**Branch:** repomap-core-4f0.19 → main
**Date:** 2026-02-19

## Comment Ledger

| ledger_id | type | comment_id | author | path:line | category | disposition | implementation | reply_body | status |
|---|---|---:|---|---|---|---|---|---|---|
| 001 | review | 2825760126 | Copilot | repomap.toml:35 | suggestion | fix | Remove hard-coded line number reference; reword to behavior-based description | TBD | pending |
| 002 | review | 2825756304 | augmentcode[bot] | repomap.toml:35 | suggestion | fix | Clarify that `to=[]` makes foundation→foundation a violation; align comment with actual semantics | TBD | pending |
| 003 | review | 2825760113 | Copilot | repomap.toml:39 | blocking | fix | Change `to = []` to `to = ["foundation"]` to allow same-layer imports | TBD | pending |
| 004 | review | 2825756308 | augmentcode[bot] | tests/test_layer_enforcement_dogfood.py:84 | suggestion | fix | Align comment with assertion — same-layer imports ARE violations under current strict config unless allowed | TBD | pending |
| 005 | review | 2825760133 | Copilot | tests/test_layer_enforcement_dogfood.py:88 | blocking | fix | Align comment with assertion or change assertion if same-layer deps are meant to be allowed | TBD | pending |
| 006 | review | 2825760141 | Copilot | .repomap/modules.jsonl:3 | suggestion | fix | Exclude `.kilocode/**` from scan or normalize leading-dot module names | TBD | pending |
| 007 | review | 2825760146 | Copilot | .repomap/deps_summary.json:142 | suggestion | fix | Fix upstream (cluster A) to resolve foundation→foundation noise in deps_summary | TBD | pending |

## Clusters

### Cluster A: Foundation same-layer violation policy (ledger 001-005, 007)

**Root cause:** `repomap.toml` defines `foundation` layer with `to = []`, making ALL foundation→foundation imports violations. This is almost certainly unintended — same-layer imports within foundation should be allowed.

**Upstream fix:** Change `to = []` to `to = ["foundation"]` in `repomap.toml`
**Downstream effects:**
- Comment on line 35 needs rewording (remove line number ref, clarify semantics)
- Test comments in `test_layer_enforcement_dogfood.py` need alignment
- Test assertions may need updating to match new same-layer-is-allowed semantics
- `.repomap/deps_summary.json` layer_violations will shrink after regeneration
- `.repomap/` artifacts need regeneration

### Cluster B: .kilocode module naming (ledger 006)

**Root cause:** `.kilocode/tools/*.py` files are being scanned and produce module IDs with leading dots (`.kilocode.tools.bounded_gate`), which are invalid Python module names.

**Fix options:**
1. Exclude `.kilocode/**` from scanning in `repomap.toml`
2. Normalize leading-dot segments in module naming

**Preferred:** Option 1 — `.kilocode/` is plant infrastructure, not product code. It should be excluded from analysis.

## Conversation-Level Comments (non-actionable)

- **sonarqubecloud:** Quality Gate passed — no action needed
- **augmentcode:** PR summary — no action needed
- **augmentcode:** "2 suggestions posted" — covered by ledger 002, 004
- **copilot:** PR overview + "5 comments" — covered by ledger 001, 003, 005, 006, 007
