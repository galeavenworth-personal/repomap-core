# Dispatch 004: Execute Epic repomap-core-c7l — Beads+DSPy Foundation

**Date:** 2026-03-13
**Epic:** `repomap-core-c7l` — Beads+DSPy Foundation — upgrade beads, tag dispatches with bead_id
**Agent:** `plant-manager`
**Branch:** `repomap-core-c7l` (from main)
**Status:** ready

## Context

Epic c7l is the first of three epics for the Beads+DSPy self-learning loop integration.
It adds foundational plumbing: bead_id column in factory.tasks, threading bead_id through
the dispatch pipeline, and verifying it lands in Dolt.

Dependency `repomap-core-65s` (Dolt consolidation) is merged. The factory DB exists with
all tables. Beads v0.60.0 is installed (c7l.1 closed manually).

Remaining children (3):
- `c7l.2`: Add bead_id column to factory.tasks table
- `c7l.3`: Thread bead_id through dispatch payload and daemon to Dolt
- `c7l.4`: Verify bead_id tagging with live dispatch test

## Pre-dispatch Checklist

- [x] Stack healthy (kilo, Dolt, Temporal, oc-daemon, temporal-worker)
- [x] factory DB exists with 13 tables
- [x] beads v0.60.0 installed, c7l.1 closed
- [x] Branch created from main
- [ ] Dispatch executed

## Dispatch Command

```bash
# Create branch first
git checkout -b repomap-core-c7l main

# Dispatch
.kilocode/tools/factory_dispatch.sh \
  -m plant-manager \
  -w 3600 \
  "You are dispatched to execute epic repomap-core-c7l on branch repomap-core-c7l.

c7l.1 (beads upgrade) is already closed. Three children remain: c7l.2, c7l.3, c7l.4.

Your operating loop:
1. Run '.kilocode/tools/bd ready' to find the next eligible bead under this epic
2. Claim it: '.kilocode/tools/bd update {id} --status in_progress'
3. Execute it: delegate through /start-task workflow (process-orchestrator per bead)
4. After execution completes, commit the work: one commit per bead, message references the bead ID
5. Close the bead: '.kilocode/tools/bd close {id}'
6. Export beads: '.kilocode/tools/bd export -o .beads/issues.jsonl'
7. Loop back to step 1

Stop when all children of repomap-core-c7l are closed, or when you hit a bead that
cannot be completed (create an issue and escalate).

You are on branch repomap-core-c7l. All commits go here.
Each bead is one commit. Each bead gets its own process-orchestrator delegation.
Do NOT skip beads or work on blocked beads — follow bd ready ordering.

Key context for the children:
- c7l.2: ALTER TABLE factory.tasks ADD COLUMN bead_id VARCHAR(100) NULL; also update
  dolt-schema.ts CREATE TABLE definition. Verify with SELECT bead_id FROM factory.tasks LIMIT 1.
- c7l.3: Add --bead-id flag to factory_dispatch.sh/dispatch CLI, thread through
  FactoryDispatchConfig → PromptPayload → daemon SSE handler → INSERT into factory.tasks.
  Must be backward compatible (omitting --bead-id writes NULL).
- c7l.4: End-to-end verification — dispatch with --bead-id, confirm it appears in Dolt.

The 3 remaining children are ready. Start with c7l.2."
```

## Cost Budget

$5/session, 200 steps, $25/tree (defaults).
1-hour timeout (-w 3600) gives room for all 3 beads.

## Expected Outcome

- 3 beads executed sequentially (c7l.2 → c7l.3 → c7l.4)
- One commit per bead on the repomap-core-c7l branch
- Each bead delegated through process-orchestrator → children
- factory.tasks has bead_id column
- Dispatch CLI accepts --bead-id flag
- Live dispatch test confirms bead_id in Dolt
- Epic closed when all children pass

## Results

_(to be filled after dispatch completes)_
