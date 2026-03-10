# Dispatch 001: Decompose Epic repomap-core-0mp — Foreman

**Date:** 2026-03-09
**Epic:** `repomap-core-0mp` — Foreman — self-driving factory operator
**Workflow:** `/decompose-epic`
**Agent:** `plant-manager`
**Branch:** `repomap-core-0mp`
**Status:** attempt-2 (attempt-1 failed: workflow lacked delegation, agent did all thinking itself)

## Context

The Foreman epic is the single largest bottleneck in the beads graph — closing it
unblocks 24 downstream items including Phases 3, 4, 5, SDK pivot, and streams C/D/E.

Its dependency on `repomap-core-7l4` (substrate hardening) is now satisfied (closed).
The epic has 3 existing children:
- `0mp.1` (P1, open) — Foreman architecture and control contracts
- `0mp.2` (P2, closed) — Cognitive services architecture doc (already written)
- `4f0.13` (P3, open) — Plant health composite command (reparented from 7l4)

The acceptance criteria require a working Foreman (Temporal workflow, activities, CLI,
signal surface, exception contracts), but the implementation subtasks haven't been
broken out. This dispatch decomposes the epic into mintable beads.

## Dispatch Command (v2 — with delegation)

```bash
.kilocode/tools/factory_dispatch.sh \
  -m plant-manager \
  -w 1200 \
  "You are dispatched to decompose epic repomap-core-0mp into implementable child beads.

Follow the /decompose-epic workflow in .kilocode/workflows/decompose-epic.md.
You are an orchestrator — you MUST delegate each phase to architect children via new_task.

Phase 1 (discover): Delegate to architect child to understand epic scope, read beads, gather strategic context.
Phase 2 (explore): Delegate to architect child to explore codebase, map implementation surface.
Phase 3 (prepare): Delegate to architect child to design subtask graph via sequential thinking.
Phase 4 (mint): YOU mint the beads from the prepare phase output using bd create --parent repomap-core-0mp.

Existing children:
- 0mp.1 (P1, open) — Foreman architecture and control contracts
- 0mp.2 (P2, closed) — Cognitive services architecture doc (already done)
- 4f0.13 (P3, open) — Plant health composite command

The substrate epic (7l4) is merged. You have the full Temporal infrastructure to build on:
- agentTaskWorkflow in daemon/src/temporal/workflows.ts
- Activities in daemon/src/temporal/activities.ts
- Dispatch CLI in daemon/src/temporal/dispatch.ts
- Worker in daemon/src/temporal/worker.ts
- Cost budget monitor in daemon/src/governor/cost-budget-monitor.ts

Architecture doc for reference: docs/infra/cognitive-services-architecture.md

Do NOT call codebase_retrieval, edit_file, apply_diff, or write_to_file directly.
Do NOT create more than 10 subtasks — if you need more, recommend sub-epics.
Export beads state when done: '.kilocode/tools/bd export -o .beads/issues.jsonl'."
```

## Cost Budget

Using raised defaults: $5/session, 200 steps, $25/tree.
No override flags needed — decomposition is a single session, well within limits.

## Expected Outcome

- 5-8 new child beads under `repomap-core-0mp`
- Clear ordering and sibling dependencies
- Each bead description contains file paths, acceptance criteria, verification commands
- Sequential thinking session exported to `.kilocode/thinking/`
- Beads exported to `.beads/issues.jsonl`

## Post-Dispatch

After decomposition, plant-manager is dispatched again in execution mode:
- One bead at a time via `/execute-task` or `/execute-subtask`
- One commit per bead on the `repomap-core-0mp` branch
- Branch becomes the PR when the epic is complete

## Results (Attempt 2 — SUCCESS)

**Session:** `ses_32a5ce0b9ffeXLCdDPtOTx7XSF`
**Duration:** 660s (11 minutes)
**Children:** 3 (discover → explore → prepare, all architect mode)
**Child sessions:**
- `ses_32a5c3aceffe57uS8U23te9NPB` (discover)
- `ses_32a5a4600ffey8jV5EVlZDmjAa` (explore)
- `ses_32a577cd1ffeiKZ047Y3rBLMuD` (prepare)

### Minted Beads (10 new, execution order by dependency)

| Bead | P | Title | Depends On |
|------|---|-------|------------|
| 0mp.1 | P1 | Foreman architecture and control contracts | (none — pre-existing) |
| 0mp.10 | P1 | Define foreman shared contracts and state model | (none) |
| 0mp.11 | P1 | Implement foreman Beads activities | 0mp.10 |
| 0mp.12 | P1 | Implement minimal foreman health gate activities | 0mp.10 |
| 0mp.13 | P1 | Build the core foreman workflow loop | 0mp.10, 0mp.11, 0mp.12 |
| 0mp.14 | P1 | Add durable completion and bead outcome reconciliation | 0mp.13 |
| 0mp.17 | P1 | Wire foreman into Temporal worker exports | 0mp.13 |
| 0mp.19 | P1 | Add foreman workflow happy-path and control tests | 0mp.13 |
| 0mp.15 | P2 | Implement foreman exception and approval handling | 0mp.13 |
| 0mp.16 | P2 | Add foreman operator CLI | 0mp.13 |
| 0mp.18 | P2 | Add foreman activity contract tests | (none) |

### Graph Quality Assessment

- **Delegation pattern:** ✅ All 3 phases delegated to architect children
- **Dependency DAG:** ✅ Clean, no cycles. 0mp.10 (types) → 0mp.11/12 (activities) → 0mp.13 (workflow) → 0mp.14-19 (extensions)
- **Bead descriptions:** ✅ Each bead includes file paths, acceptance criteria, verification commands
- **Scope discipline:** ✅ All beads within epic acceptance criteria
- **First ready bead:** `0mp.1` (architecture doc), then `0mp.10` (types/contracts)

### Attempt 1 (FAILED)

The first attempt used a workflow that told the plant-manager to do all thinking itself.
It created 7 beads in ~4 minutes without child delegation. Beads were deleted, workflow
rewritten with proper discover/explore/prepare delegation, and re-dispatched.
