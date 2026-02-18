# Dual-Graph Architecture: Tasks and Workflows

**Date:** 2026-02-17
**Status:** Architectural constraint (confirmed)

## Overview

The Kilo Code fabrication plant operates over two distinct graphs with specific constraints on how they compose.

## Graph 1: Task Graph (Execution Topology)

- **Nodes:** Tasks (created via `new_task`, returned via `attempt_completion`)
- **Structure:** Strictly hierarchical tree
- **Processing:** Sequential only — no parallelism
- **Context:** Each task node is an isolated context boundary (~200k token window)
- **Return path:** Child → parent only (via `attempt_completion`). No lateral jumps.

### Depth Cost Principle

Depth has real cost: each level consumes a full context window allocation. Therefore:

- **Shallow, wide fan-out** (sequential siblings at the same depth) preserves operational throughput better than deep nesting
- Max nesting depth: 3 levels (plant-manager → tactical orchestrator → specialist)
- Sequential fan-out at a given level maintains the throughline without depth penalty

## Graph 2: Workflow/Skill/Tool Graph (Capability Topology)

- **Nodes:** Workflows, skills, tools
- **Structure:** Directed graph with mode-specific traversal constraints
- **Edges:** Modes → workflows → skills → tools
- **Traversal rules:** Custom modes define which paths through this graph are valid

### Mode as Traversal Rule Set

A mode doesn't execute work directly — it defines which workflow nodes are reachable, and those workflow nodes define which skills and tools can be activated. The mode is a traversal policy over the capability graph.

## Composition Constraint: 1:1 Mapping

**A workflow maps to exactly one task.** This is the critical design rule.

- A workflow should NOT request multiple tasks (that inverts control)
- A task IS the unit of work; the workflow defines what traversal (skills → tools) is allowed within that task
- Orchestration logic lives in the **task graph** (plant-manager, orchestrators)
- Capability traversal lives in the **workflow graph** (modes, skills, tools)

The two graphs compose but do not cross-cut.

## Token Budget Constraint

- Task context window: ~200k tokens
- **Workflow budget ceiling: 100k tokens** (50% of task context)
- A workflow is a composable primitive expected to use only the first half of a task's available context
- If a workflow exceeds 100k tokens, the odds of it being a good workflow are very low

### Exceeding Budget Signals

When a workflow approaches or exceeds 100k tokens, one of two interventions is required:

1. **Decomposition:** Split the workflow into smaller, composable units that each fit the budget
2. **Targeted ambiguity reduction:** The problem space has unresolved ambiguity that's inflating context usage — reduce it before execution

## Implications for Plant Design

| Concern | Owns It | Graph |
|---|---|---|
| When to fan out | Plant manager / orchestrators | Task graph |
| What depth to use | Plant manager | Task graph |
| What skills/tools are valid | Mode definitions | Workflow graph |
| What traversal is allowed | Workflow definitions | Workflow graph |
| Budget enforcement | Workflow design + task budgeting | Both |

## References

- Task tool: `new_task(mode, message, todos)` → subtask calls `attempt_completion(result)`
- Token budget analysis: [`repomap-core-wt5-token-budget-analysis-2026-02-16.md`](repomap-core-wt5-token-budget-analysis-2026-02-16.md)
- Mode definitions: [`.kilocodemodes`](../../.kilocodemodes)
- Workflow directory: [`.kilocode/workflows/`](../../.kilocode/workflows/)
