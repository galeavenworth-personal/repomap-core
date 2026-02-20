# PR #30 Comment Ledger

**PR:** feat(plant): build commands.toml routing matrix (repomap-core-4f0.7)
**Branch:** repomap-core-4f0.7 → main
**Reviewers:** augmentcode[bot], Copilot
**Ledger date:** 2026-02-20

## Ledger

| ID | Type | Comment ID | Author | Path:Line | Category | Disposition | Status |
|---|---|---:|---|---|---|---|---|
| 001 | review | 2831495454 | augmentcode | commands.toml:129 | suggestion (medium) | decline | acknowledged |
| 002 | review | 2831495457 | augmentcode | commands.toml:68 | suggestion (medium) | fix | acknowledged |
| 003 | review | 2831495461 | augmentcode | commands.toml:382 | suggestion (low) | decline | acknowledged |
| 004 | review | 2831505177 | Copilot | commands.toml:129 | suggestion | decline | acknowledged |
| 005 | review | 2831505208 | Copilot | commands.toml:136 | suggestion | decline | acknowledged |
| 006 | review | 2831505224 | Copilot | commands.toml:144 | suggestion | decline | acknowledged |
| 007 | review | 2831505234 | Copilot | commands.toml:321 | suggestion | fix | acknowledged |
| 008 | review | 2831505250 | Copilot | commands.toml:382 | suggestion | decline | acknowledged |

## Disposition Details

### 001, 004, 005, 006: MCP tool naming — DECLINE

**Claim:** Triple-underscore MCP tool names (e.g. `mcp--augment___context___engine--codebase___retrieval`) don't match hyphenated convention.

**Evidence:** The system/runtime tool function definitions use triple underscores as the actual registered identifiers. The hyphenated forms (`mcp--augment-context-engine--codebase-retrieval`) are display/documentation names but are NOT the invocable function identifiers. The commands.toml routing matrix must use invocable names.

### 002: bounded_gate.py invocation — FIX

**Claim:** `bounded_gate.py` has no shebang; `gate_wrapper` and composite `tool` fields reference it without `.venv/bin/python` prefix.

**Evidence:** Confirmed — `bounded_gate.py` has no shebang line. Direct execution would fail with "exec format error".

**Fix:** Add `.venv/bin/python` prefix to all `gate_wrapper` fields (lines 34, 42, 50, 58) and the composite `gate_quality` tool (line 68).

### 003, 008: Dead plans/ reference — DECLINE

**Claim:** `.kilocode/contracts/thinking/plans/` directory doesn't exist on this branch.

**Evidence:** Directory DOES exist with 4 files:
- `debug-incident.md`
- `design-subsystem.md`
- `evaluate-dependency.md`
- `strategic-decision.md`

The reference in line 382 is valid.

### 007: validate_plant gate consistency — FIX

**Claim:** `receipt_required = true` but tool runs `workflow_gate.py` directly without `bounded_gate.py` wrapping.

**Evidence:** Correct — receipt_required implies bounded gate execution, but no `gate_wrapper` is defined and the tool doesn't go through `bounded_gate.py`.

**Fix:** Wrap with `bounded_gate.py --gate-id workflow-validation` and add `gate_wrapper` field.
