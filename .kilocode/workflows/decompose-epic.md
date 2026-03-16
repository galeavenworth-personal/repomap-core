---
description: Delegation orchestrator for epic decomposition. Spawns architect children for discover, explore, and prepare phases scoped to an epic. Parent mints child beads from the preparation output. Follows the start-task delegation pattern.
auto_execution_mode: 3
punch_card: decompose-epic
---

> ⚠️ **DEPRECATED:** This workflow has been replaced by
> `.beads/formulas/decompose-epic.formula.json`.
> Use `bd cook decompose-epic` for the step DAG, or `bd mol pour` for molecule dispatch.

# Decompose Epic (Deprecated)

This workflow's operational content has been migrated to a beads formula.
Behavioral enforcement lives in punch cards and DSPy compiled prompts.

**Replacement:** `.beads/formulas/decompose-epic.formula.json`
**Cook:** `bd cook decompose-epic`
**Dispatch:** `factory_dispatch.sh --formula decompose-epic --var key=value`

## Related

- [`.beads/formulas/decompose-epic.formula.json`](../../.beads/formulas/decompose-epic.formula.json)
- [`discover-phase.md`](./discover-phase.md)
- [`explore-phase.md`](./explore-phase.md)
- [`prepare-phase.md`](./prepare-phase.md)
