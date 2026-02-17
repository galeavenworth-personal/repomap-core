# Orchestrator Composability Patterns — repomap-core-3wo

## Motivation

Native `new_task` nesting enables an orchestrator to decompose work recursively while maintaining strong context hygiene. The experiment evidence shows:

- nesting works (child can spawn grandchild)
- each level sees only its handoff packet (context firewall)
- `todos` is the primary structured parent→child channel
- returns are plain text only, so parents must parse
- cost adds up per nesting level

This task turns those observations into explicit **contracts**.

## Key Finding: Self-Delegation Anti-Pattern

**Anti-pattern:** orchestrators that do not enforce delegation via `new_task` defeat their own purpose.

Observed live in this session: when an orchestrator attempts to “do specialist work itself” without spawning a bounded subtask, it reintroduces the exact failure modes orchestration is meant to prevent:

- uncontrolled context growth
- blurred ownership of deliverables
- unparseable completion boundaries
- inability to model-route by mode

**Correction:** enforce bounded delegation + return parsing contracts.

## Contract Set (This Task)

These contracts are designed to be self-contained and follow the existing line-health contract style.

1. `.kilocode/contracts/composability/handoff_packet.md`
   - Parent → Child schema for `new_task.message` and `new_task.todos`

2. `.kilocode/contracts/composability/return_format.md`
   - Child → Parent parseable markdown return via `attempt_completion`

3. `.kilocode/contracts/composability/nesting_depth_policy.md`
   - Depth budget policy (recommended max 3; ~ $0.08/level overhead)

4. `.kilocode/contracts/composability/error_propagation.md`
   - Failure propagation, bounded retries, escalation patterns

5. `.kilocode/contracts/composability/mode_interaction_heuristic.md`
   - Validated `new_task` vs `switch_mode` heuristic (includes scenario table)

## Worked Example (This Delegation)

Scenario: **process-orchestrator spawns an architect subtask** to produce contract docs.

### Parent → Child (handoff packet)

Parent calls `new_task(mode="architect", message=..., todos=...)` with a JSON handoff packet that includes:

- task_id
- objective
- evidence pointers (experiment + analysis + existing templates)
- success criteria
- risks

The `todos` parameter is passed as a checklist so the child has a structured execution plan.

### Child → Parent (return format)

Child returns a parseable markdown report in `attempt_completion.result` containing:

- `## Status` with `state: SUCCESS|ERROR|PARTIAL`
- `## Deliverables` listing created files
- `## Evidence` listing referenced sources
- `## Runtime Attestation` with model/mode/files_created

Parent parses this text to decide whether:

- accept results
- retry with amendments
- escalate (e.g., to fitter on line fault)

## Evidence Pointers

- `docs/research/nested-new-task-experiment-2026-02-15.md`
- `docs/research/orchestrator-composability-analysis-2026-02-15.md`
- `.kilocode/contracts/line_health/line_fault_contract.md`
- `.kilocode/contracts/line_health/restoration_contract.md`

## Notes

These contracts are intentionally small and explicit. They are the substrate for a three-tier orchestration architecture (Strategic → Tactical → Specialist) without requiring a bespoke workflow engine.
