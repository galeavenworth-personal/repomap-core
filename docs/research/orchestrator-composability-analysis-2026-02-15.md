# Orchestrator Composability Analysis

## Date
2026-02-15

## Scope
This note defines composability for repomap orchestration and documents expected delegation behavior.
It is intentionally narrow: mode tiering, subtask delegation via `new_task`, and explicit non-goals.

## What Composability Means in This Repository
Composability means orchestrator modes can be combined in bounded, predictable ways:

1. A parent mode delegates a focused objective to a child mode.
2. The child executes in an isolated subtask context.
3. The child returns a structured result.
4. The parent uses that result to advance lifecycle state.

This is a control-flow contract, not open-ended multi-agent conversation.

## Tiering Model for Orchestrator Modes

### Tier 1 — Strategic
- `plant-manager`
- Owns workflow-system changes (modes, skills, contracts, fit profiles, orchestration patterns)
- Delegates implementation to tactical orchestrators via `new_task`

### Tier 2 — Tactical Orchestrators
- `process-orchestrator`
- `audit-orchestrator`
- Execute phase-driven orchestration and dispatch specialist subtasks

### Tier 3 — Specialists
- Examples: `code`, `architect`, `fitter`, `docs-specialist`, `product-skeptic`
- Execute bounded work packets and return evidence-backed results

### Depth Constraint
- Maximum nesting depth is 3 tiers.

## Expected `new_task` Delegation Pattern

### Parent → Child Input Contract
Every delegated subtask should include:
- `task_id` (when applicable)
- objective
- scope (files/directories in play)
- success criteria
- constraints
- context pointers

### Child → Parent Output Contract
Every subtask result should include:
- completion status
- evidence pointers (files/artifacts/logs)
- explicit pass/fail against success criteria
- runtime attestation fields when required by parent mode

### Routing Guidance
- Tier 1 delegates to Tier 2 via `new_task`.
- Tier 2 delegates to Tier 3 via `new_task`.
- Prefer `new_task` over `switch_mode` for cross-tier work to preserve isolation.

## Explicit Non-Goals
This document does **not** define:
- mode schema evolution policy
- external UI/platform tool behavior
- quality-gate command runbooks
- product architecture in `src/`
- a generalized multi-agent framework beyond current repomap modes

## Summary
Repomap composability is a constrained orchestration model: tiered delegation via `new_task`, bounded scope, structured outputs, and explicit depth limits.
