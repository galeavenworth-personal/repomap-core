# Research Findings: Custom Mode `new_task` Access

## Task
repomap-core-4g0 — Research gate for specialized orchestrator modes plan

## Date
2026-02-15 (corrected)

## Gate Result: PROVEN ✅

Custom modes defined in `.kilocodemodes` CAN access `new_task` and `switch_mode`. The specialized orchestrator modes plan (parent epic repomap-core-1nb) is viable.

## Core Questions & Evidence

### Q1: Can custom modes access `new_task`?
**YES — PROVEN**
- User manually activated `spike-orchestrator` custom mode via Kilo UI
- `new_task` was available as a tool
- Successfully spawned subtasks targeting both built-in and custom mode slugs
- Confidence: **HIGH**

### Q2: Which tool group contains `new_task`?
**Appears to be universally available regardless of tool group grants**
- The `spike-orchestrator` mode had groups `["read", "edit", "command", "browser", "mcp"]`
- `new_task` was available despite not being in any of these named groups
- This suggests `new_task` (and `switch_mode`) may be platform-level tools available to all modes, not group-gated
- Confidence: **MEDIUM-HIGH** (would need a minimal-grants test to fully confirm)

### Q3: Context isolation parity with built-in Orchestrator?
**NOT YET TESTED**
- The canary token isolation test was not completed
- Orchestrator docs state subtasks are isolated and return summary-only
- Whether this applies identically to custom-mode-spawned subtasks remains to be validated
- Confidence: **MEDIUM** (docs suggest yes, empirical confirmation pending)

### Q4: Summary-only return for custom-mode caller?
**NOT YET TESTED**
- Same as Q3 — requires canary token test
- Confidence: **MEDIUM** (docs suggest yes)

## Evidence Sources

### Programmatic API tests (from Orchestrator mode) — MISLEADING
| Test | Tool | Target | Result | Interpretation |
|------|------|--------|--------|----------------|
| 1 | `switch_mode` | `spike-full-grants` | "Invalid mode" | Tool validation artifact |
| 2 | `new_task` | `spike-full-grants` | "Invalid mode" | Tool validation artifact |
| 3 | `switch_mode` | `docs-specialist` | "Invalid mode" | Tool validation artifact |

**Root cause:** The Orchestrator mode's tool schema validates mode slugs against a hardcoded allowlist of built-in modes. This is a validation-layer restriction, not a runtime restriction.

### Manual UI tests (from user) — AUTHORITATIVE
| Test | Tool | From Mode | Result |
|------|------|-----------|--------|
| 1 | `new_task` | `spike-orchestrator` (custom) | **SUCCESS** |
| 2 | `switch_mode` | `spike-orchestrator` (custom) | **SUCCESS** |

**Key insight:** When a custom mode is manually activated via the Kilo UI, it has access to `new_task` and `switch_mode` with full custom mode slug support.

## Remaining Work
1. Canary token isolation test (Q3/Q4)
2. Minimal-grants variant test (confirm Q2 — is `new_task` truly group-independent?)
3. Token usage measurement (does parent context grow after child completion?)

## Implications for Parent Epic (repomap-core-1nb)
- **Specialized orchestrator modes plan is VIABLE**
- Custom modes can spawn subtasks and switch modes programmatically
- Proceed with plan implementation (no pivot to Approach B needed)
- The Orchestrator mode's tool validation is a known limitation but does not affect custom mode capabilities
