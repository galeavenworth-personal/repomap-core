# Decision: repomap-core-4g0 — Custom Mode new_task Gate

## Date
2026-02-15 (corrected)

## Decision
**PROCEED WITH APPROACH A** — Specialized orchestrator modes with `new_task` access.

## Gate Result
**PROVEN** — Custom modes CAN access `new_task` and `switch_mode`.

## Rationale
User-conducted manual testing from the `spike-orchestrator` custom mode proved that both `new_task` and `switch_mode` are available and functional for custom modes. Earlier programmatic tests from Orchestrator mode returned "Invalid mode" but this was a tool validation artifact, not a runtime limitation.

## Evidence Summary
- **Programmatic tests (misleading):** Orchestrator mode's tool validation rejects custom slugs
- **Manual tests (authoritative):** Custom mode successfully called `new_task` and `switch_mode`

## Implications for Parent Epic (repomap-core-1nb)
- The specialized orchestrator modes plan is viable
- No pivot to Approach B needed
- Proceed with implementation

## Remaining Investigation
1. Context isolation (Q3): Do custom-mode-spawned subtasks have the same isolation as Orchestrator-spawned ones?
2. Summary-only return (Q4): Does the parent receive only the summary?
3. Tool group independence (Q2): Is `new_task` available regardless of tool group grants?

## Recommendations
1. Update repomap-core-4g0 status to reflect corrected findings
2. Unblock parent epic repomap-core-1nb for implementation
3. File follow-up issues for Q2/Q3/Q4 validation
4. Update blocked task repomap-core-r9v with findings.

## Lesson Learned
Programmatic API tests from built-in modes may have tool validation restrictions that don't reflect actual runtime capabilities. Always validate with manual UI testing when programmatic tests return unexpected failures.
