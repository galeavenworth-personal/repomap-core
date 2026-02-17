# Composability Contract: Mode Interaction Heuristic (`new_task` vs `switch_mode`)

## Purpose

Define a validated heuristic for when to spawn a child task (`new_task`) versus switching modes in-place (`switch_mode`).

This contract exists because:

- `new_task` provides bounded context isolation and requires return parsing.
- `switch_mode` preserves continuous context but does not create a parseable “handoff/return” boundary.

## Minimum MVP Fields

- `heuristic_table` (markdown table): scenarios → recommended mechanism
- `hard_rules` (array[string]): rules that must not be violated
- `examples` (array[string]): short usage examples

## Heuristic Table (Validated)

The following table is copied verbatim from the analysis doc (validated by experiment):

| Scenario | Use | Rationale |
|----------|-----|-----------|
| Bounded deliverable with clear input/output | `new_task` | Context isolation, clean return |
| Continuous access to accumulated context needed | `switch_mode` | Shared state, no return parsing |
| Orchestrator → Orchestrator | `new_task` only | Never switch between orchestrators |
| Orchestrator → Specialist | `new_task` | Isolation, bounded scope |
| Within-specialist follow-up (e.g., debug after code) | `switch_mode` | Same context needed |

## Hard Rules

- **Orchestrator → Orchestrator:** always use `new_task`.
  - Rationale: switching between orchestrators defeats tier boundaries and blurs ownership.

- If you use `new_task`, you MUST enforce:
  - a structured handoff packet (see handoff contract)
  - a parseable return format (see return-format contract)

## Examples

- Example: process-orchestrator spawning architect for a bounded doc deliverable → `new_task`.
- Example: code mode to debug mode mid-fix where same traceback context is needed → `switch_mode`.

## Markdown Example (Mini Decision)

```markdown
Decision: Use `new_task`.
- Scenario: bounded deliverable (draft contract docs)
- Need isolation: yes (avoid polluting orchestrator context)
- Return parsing acceptable: yes (child will follow return-format contract)
```
