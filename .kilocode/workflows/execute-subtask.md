---
description: Specialist child workflow for executing a single planned subtask. Spawned by process-orchestrator in code mode. Bounded implementation with mandatory context gathering and quality gates.
auto_execution_mode: 3
punch_card: execute-subtask
---

> ⚠️ **DEPRECATED:** This workflow has been replaced by
> `.beads/formulas/execute-subtask.formula.json`.
> Use `bd cook execute-subtask` for the step DAG, or `bd mol pour` for molecule dispatch.

# Execute Subtask (Deprecated)

This workflow's operational content has been migrated to a beads formula.
Behavioral enforcement lives in punch cards and DSPy compiled prompts.

**Replacement:** `.beads/formulas/execute-subtask.formula.json`
**Cook:** `bd cook execute-subtask`
**Dispatch:** `factory_dispatch.sh --formula execute-subtask --var key=value`

## Related

- [`.beads/formulas/execute-subtask.formula.json`](../../.beads/formulas/execute-subtask.formula.json)
