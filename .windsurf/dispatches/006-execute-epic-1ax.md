# Dispatch 006: Execute Epic repomap-core-1ax — Formula Proof-of-Concept

**Date:** 2026-03-14
**Epic:** `repomap-core-1ax` — Formula Proof-of-Concept — convert workflow to formula, close the full loop
**Agent:** `plant-manager`
**Branch:** `repomap-core-1ax` (from main)
**Status:** dispatched

## Context

Epic 1ax is the third and final epic for the Beads+DSPy self-learning loop.
It proves that a beads formula can drive agent execution, generate bead-tagged
telemetry, feed DSPy compilation, and produce specialized prompts that improve
the next execution of that same formula.

Dependency `repomap-core-gfb` (DSPy enrichment) is merged. The factory DB has
compound prompt IDs, beads enrichment, and resolution cascade in prompt-injection.ts.

Children (3):
- `1ax.1`: Convert one workflow to .formula.json
- `1ax.2`: Pour formula into molecule and dispatch with bead_id tagging
- `1ax.3`: End-to-end loop test: compile → verify formula-specific prompts → re-dispatch

## Pre-dispatch Checklist

- [x] Stack healthy (kilo, Dolt, Temporal, oc-daemon, temporal-worker) — 5/5
- [x] gfb merged (compound prompt IDs, beads enrichment, resolution cascade)
- [x] Branch created from main
- [x] start-stack.sh idempotent fix committed

## Dispatch Command

```bash
.kilocode/tools/factory_dispatch.sh \
  -m plant-manager \
  -w 10800 \
  "You are dispatched to execute epic repomap-core-1ax on branch repomap-core-1ax.

All 3 children are ready. Execute them in order: 1ax.1 → 1ax.2 → 1ax.3.

Your operating loop:
1. Run '.kilocode/tools/bd ready' to find the next eligible bead under this epic
2. Claim it: '.kilocode/tools/bd update {id} --status in_progress'
3. Execute it: delegate through /start-task workflow (process-orchestrator per bead)
4. After execution completes, commit the work: one commit per bead, message references the bead ID
5. Close the bead: '.kilocode/tools/bd close {id}'
6. Export beads: '.kilocode/tools/bd export -o .beads/issues.jsonl'
7. Loop back to step 1

Stop when all children of repomap-core-1ax are closed, or when you hit a bead that
cannot be completed (create an issue and escalate).

You are on branch repomap-core-1ax. All commits go here.
Each bead is one commit. Each bead gets its own process-orchestrator delegation.
Do NOT skip beads or work on blocked beads — follow bd ready ordering.

Key context for the children:

- 1ax.1: Convert one existing workflow to a .formula.json file.
  Good candidate: respond-to-pr-review-orchestrate (has punch card, uses
  multiple agent modes, clear step dependencies).
  Alternative: execute-subtask (simpler, single-agent, good for minimal test).
  The formula goes in .beads/formulas/<name>.formula.json.
  Structure: steps with id, mode (agent), card (punch card), depends_on, gate conditions.
  Use {{variable}} placeholders for runtime values (PR URL, branch name, etc.).
  Validate with: bd cook <formula-file> --mode compile (should resolve cleanly).
  bd formula list should show the new formula.

- 1ax.2: Instantiate the formula as a molecule and dispatch with bead_id tagging.
  Cook the formula in runtime mode: bd cook <formula> --mode runtime --var KEY=VALUE
  Pour the proto into a molecule: bd mol pour <proto_id>
  Verify molecule created real bead IDs: bd mol show <molecule_id>, bd children <epic_id>
  For each step in the molecule, dispatch with --bead-id:
    .kilocode/tools/factory_dispatch.sh --bead-id <step_bead_id> -m <mode> '<prompt>'
  Verify bead_ids appear in factory.tasks in Dolt after dispatch.

- 1ax.3: End-to-end loop test — the capstone.
  Phase A: Run DSPy compilation:
    op run --env-file .env.op -- .venv/bin/python -m optimization.run_compilation
  Query compiled_prompts for formula-specific compound IDs.
  Phase B: Pour the same formula again (new molecule), dispatch a step with --bead-id.
  Check daemon logs for formula-specialized prompt injection.
  Phase C: Document the full loop with timestamps in .kilocode/checkpoints/.
  Also: close or reparent repomap-core-dkk (DSPy dispatch routing) since this epic subsumes it.

Python venv is at ~/Projects-Employee-1/repomap-core/.venv/ — use .venv/bin/python for all
Python execution. DSPy compilation requires: op run --env-file .env.op -- .venv/bin/python -m optimization.run_compilation

The 3 children are ready. Start with 1ax.1."
```

## Cost Budget

$5/session, 200 steps, $25/tree (defaults).
3-hour timeout (-w 10800) gives room for all 3 beads.

## Expected Outcome

- 3 beads executed sequentially (1ax.1 → 1ax.2 → 1ax.3)
- One commit per bead on the repomap-core-1ax branch
- .beads/formulas/<name>.formula.json created and validates
- Molecule poured with real bead IDs, dispatched with --bead-id tagging
- DSPy compilation produces formula-specific compound prompts
- Re-dispatch uses specialized prompts (source=compiled:formula-*)
- Evidence checkpoint in .kilocode/checkpoints/
- repomap-core-dkk closed or reparented
- Epic closed when all children pass

## Results

_(to be filled after dispatch completes)_
