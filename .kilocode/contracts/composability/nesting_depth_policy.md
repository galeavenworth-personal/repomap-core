# Composability Contract: Nesting Depth Budget Policy

## Purpose

Define a budget policy for how deeply to nest subtasks via `new_task`.

Nesting enables:

- recursive decomposition (orchestrator → sub-orchestrator → specialist)
- strong context isolation per level
- model routing by mode

But nesting also **multiplies fixed overhead** (system prompt + rules + environment details) per level.

## Minimum MVP Fields

- `recommended_max_depth` (number): recommended maximum nesting depth
- `cost_overhead_per_level_usd` (number): approximate fixed overhead per added level
- `depth_guidance` (array[object]): when each depth is appropriate
- `warnings` (array[string]): explicit cost/complexity warnings

## Policy (MVP)

- `recommended_max_depth`: **3**
  - **Definition:** `recommended_max_depth` is measured in **number of `new_task` calls** (nesting levels).
  - Rationale: allows a bounded “factory” chain of up to **4 agents total** (Strategic → Tactical → Sub-orchestrator → Specialist) while keeping overhead and parsing complexity bounded.

- `cost_overhead_per_level_usd`: **~$0.08 per level** (system prompt overhead)
  - Evidence: 3-level nesting test cost ~$0.25, implying ~$0.08/level baseline overhead.

## Depth Guidance

**Definition (normative):**

- **Depth = number of `new_task` calls** (nesting levels), **not** the total number of agents.
- **Total agents involved = depth + 1**.

| Depth (=`new_task` calls) | Total agents | Topology (chain) | Appropriate when | Example |
|---:|---:|---|---|---|
| 1 | 2 | parent → child | Single bounded deliverable; isolation is desired; parent can parse a single return. | process-orchestrator → architect (draft a contract) |
| 2 | 3 | parent → child → grandchild | Child must delegate a bounded specialist task (e.g., gate failure recovery, a narrow spike, or a small supporting subtask). | process-orchestrator → code → fitter (gate failure recovery); or plant-manager → process-orchestrator → specialist |
| 3 | 4 | parent → child → grandchild → great-grandchild | Deliberate multi-tier factory pattern where the tactical layer still needs to spawn a sub-orchestrator before reaching a specialist. **Recommended max.** | plant-manager → tactical orchestrator → sub-orchestrator → specialist |
| 4+ | 5+ | deeper recursion | Avoid by default. Only use if (a) each step is very small, (b) cost is explicitly approved, (c) return parsing is standardized and enforced. | (avoid) |

## Warnings

- **Cost multiplies with depth:** total overhead ≈ depth × per-level overhead.
- **Return parsing burden multiplies:** each parent must parse child output; ambiguity propagates.
- Prefer **one level of nesting** unless there is a clear tier boundary.

## JSON Example (MVP)

```json
{
  "recommended_max_depth": 3,
  "cost_overhead_per_level_usd": 0.08,
  "depth_guidance": [
    {
      "depth": 1,
      "when": "Bounded deliverable with clear input/output",
      "example": "process-orchestrator → architect"
    },
    {
      "depth": 2,
      "when": "Child must delegate to a specialist (e.g., gate failure recovery or a narrow spike)",
      "example": "process-orchestrator → code → fitter"
    },
    {
      "depth": 3,
      "when": "Four-agent chain is justified (factory pattern with a sub-orchestrator); recommended max",
      "example": "plant-manager → tactical orchestrator → sub-orchestrator → specialist"
    },
    {
      "depth": 4,
      "when": "Avoid by default; only with explicit approval and standardized return parsing",
      "example": "(avoid depth 4+)"
    }
  ],
  "warnings": [
    "Avoid depth>3 unless explicitly justified; cost and parsing complexity multiply",
    "Do not rely on implicit shared state; each level sees only its handoff packet"
  ]
}
```
