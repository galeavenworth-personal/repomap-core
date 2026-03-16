---
description: Delegation orchestrator for task execution. Spawns code children for each planned subtask sequentially. Process-orchestrator runs this — it coordinates, never implements.
auto_execution_mode: 3
punch_card: process-orchestrate
---

> ⚠️ **DEPRECATED:** This workflow has been replaced by
> `.beads/formulas/execute-task.formula.json`.
> Use `bd cook execute-task` for the step DAG, or `bd mol pour` for molecule dispatch.

# Task Execution Protocol (Deprecated)

This workflow's operational content has been migrated to a beads formula.
Behavioral enforcement lives in punch cards and DSPy compiled prompts.

**Replacement:** `.beads/formulas/execute-task.formula.json`
**Cook:** `bd cook execute-task`
**Dispatch:** `factory_dispatch.sh --formula execute-task --var key=value`

## Related

- [`.beads/formulas/execute-task.formula.json`](../../.beads/formulas/execute-task.formula.json)
- [`start-task.md`](./start-task.md)
- [`execute-subtask.md`](./execute-subtask.md)
- [`fitter-line-health.md`](./fitter-line-health.md)
