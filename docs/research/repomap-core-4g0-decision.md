# Decision: repomap-core-4g0 — Custom Mode new_task Gate

## Date
2026-02-15

## Decision
**PIVOT TO APPROACH B** — Enhanced generic Orchestrator with compact workflow profiles.

## Rationale
Empirical testing proves that custom modes defined in `.kilocodemodes` are not recognized by `new_task` or `switch_mode` APIs. The specialized orchestrator modes plan's core assumption (§5a) is invalidated.

## Evidence

| Test | Tool | Target Mode | Result |
|------|------|-------------|--------|
| 1 | `switch_mode` | `spike-full-grants` (newly added custom) | **Invalid mode** |
| 2 | `new_task` | `spike-full-grants` (newly added custom) | **Invalid mode** |
| 3 | `switch_mode` | `docs-specialist` (pre-existing custom) | **Invalid mode** |

## Implications for Parent Epic (repomap-core-1nb)
- The "specialized orchestrator modes" approach (multiple custom orchestrator modes with built-in tool routing) is **not feasible** with current Kilo Code APIs.
- Must pivot to Approach B: enhance the single built-in Orchestrator mode with compact workflow profiles, improved instruction injection, and better handoff packet contracts.
- The `.kilocodemodes` custom modes remain useful for non-orchestration specialist modes (entered via UI), but cannot participate in programmatic subtask spawning.

## Remaining Investigation (Secondary)
Can a manually-activated custom mode call `new_task` targeting built-in mode subtasks? If yes, custom modes could still serve as "enhanced orchestrator entry points" that spawn built-in-mode subtask chains. This requires manual user testing.

## Recommendations
1. Close repomap-core-4g0 as COMPLETED (gate answered: NO for primary question).
2. Update parent epic plan to reflect pivot to Approach B.
3. Optionally file a follow-up issue for the secondary question (manual activation test).
4. Update blocked task repomap-core-r9v with findings.
