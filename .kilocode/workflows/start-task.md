---
description: Delegation orchestrator for task preparation. Spawns architect children for discover, explore, and prepare phases. Process-orchestrator runs this — it coordinates, never implements.
auto_execution_mode: 3
punch_card: start-task-orchestrate
---

> ⚠️ **DEPRECATED:** This workflow has been replaced by
> `.beads/formulas/start-task.formula.json`.
> Use `bd cook start-task` for the step DAG, or `bd mol pour` for molecule dispatch.

# Start Task Workflow (Deprecated)

This workflow's operational content has been migrated to a beads formula.
Behavioral enforcement lives in punch cards and DSPy compiled prompts.

**Replacement:** `.beads/formulas/start-task.formula.json`
**Cook:** `bd cook start-task`
**Dispatch:** `factory_dispatch.sh --formula start-task --var key=value`

## Related

- [`.beads/formulas/start-task.formula.json`](../../.beads/formulas/start-task.formula.json)
- [`discover-phase.md`](./discover-phase.md)
- [`explore-phase.md`](./explore-phase.md)
- [`prepare-phase.md`](./prepare-phase.md)
- [`execute-task.md`](./execute-task.md)
