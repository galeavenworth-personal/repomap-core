# Dispatch 002: Execute Epic repomap-core-0mp — Foreman

**Date:** 2026-03-09
**Epic:** `repomap-core-0mp` — Foreman — self-driving factory operator
**Agent:** `plant-manager`
**Branch:** `repomap-core-0mp` (on Employee-1)
**Status:** dispatched

## Context

Epic was decomposed in dispatch 001 into 10 child beads (0mp.10-0mp.19) plus
pre-existing 0mp.1 and 4f0.13. The plant-manager is dispatched to execute the
entire epic — picking up `bd ready` beads one at a time, orchestrating each through
start-task (process-orchestrator per bead), sequential execution gated by dependencies.

## Dispatch Command

```bash
.kilocode/tools/factory_dispatch.sh \
  -m plant-manager \
  -w 3600 \
  "You are dispatched to execute epic repomap-core-0mp on branch repomap-core-0mp.

Your operating loop:
1. Run '.kilocode/tools/bd ready' to find the next eligible bead under this epic
2. Claim it: '.kilocode/tools/bd update {id} --status in_progress'
3. Execute it: delegate through /start-task workflow (process-orchestrator per bead)
4. After execution completes, commit the work: one commit per bead, message references the bead ID
5. Close the bead: '.kilocode/tools/bd close {id}'
6. Export beads: '.kilocode/tools/bd export -o .beads/issues.jsonl'
7. Loop back to step 1

Stop when all children of repomap-core-0mp are closed, or when you hit a bead that
cannot be completed (create an issue and escalate).

You are on branch repomap-core-0mp. All commits go here.
Each bead is one commit. Each bead gets its own process-orchestrator delegation.
Do NOT skip beads or work on blocked beads — follow bd ready ordering.

The epic has 12 open children. First ready beads: 0mp.1 and 0mp.10.
Start with whichever bd ready returns first."
```

## Cost Budget

$5/session, 200 steps, $25/tree (defaults).
This is a long-running epic execution — the 1-hour timeout (-w 3600) gives room
for multiple bead cycles. If it times out, the plant-manager can be re-dispatched
to continue where it left off (bd ready picks up the next unclosed bead).

## Expected Outcome

- 10-12 beads executed sequentially
- One commit per bead on the repomap-core-0mp branch
- Each bead delegated through process-orchestrator → children
- Epic closed when all children pass

## Results

_(to be filled after dispatch completes)_
