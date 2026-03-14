# Dispatch 005: Execute Epic repomap-core-gfb — DSPy Beads Enrichment

**Date:** 2026-03-14
**Epic:** `repomap-core-gfb` — DSPy Beads Enrichment — cross-DB training data and compound prompt IDs
**Agent:** `plant-manager`
**Branch:** `repomap-core-gfb` (from main)
**Status:** ready

## Context

Epic gfb is the second of three epics for the Beads+DSPy self-learning loop.
It enriches DSPy training data with beads hierarchy context and generates
compound prompt IDs (depth-specific, formula-specific) so agents get
specialized exit prompts based on their position in the work hierarchy.

Dependency `repomap-core-c7l` (bead_id tagging) is merged. The factory DB
has `bead_id` column in `tasks`. Beads v0.60.0 is installed.

Children (5):
- `gfb.1`: Cross-DB beads enrichment in training_data.py
- `gfb.2`: Pass beads context fields into DSPy training examples
- `gfb.3`: Compound prompt ID generation in run_compilation.py
- `gfb.4`: Resolution cascade in prompt-injection.ts
- `gfb.5`: Run DSPy compilation and verify compound prompt IDs

## Pre-dispatch Checklist

- [x] Stack healthy (kilo, Dolt, Temporal, oc-daemon, temporal-worker)
- [x] factory.tasks has bead_id column (c7l merged)
- [x] beads v0.60.0 installed
- [x] Branch created from main

## Dispatch Command

```bash
.kilocode/tools/factory_dispatch.sh \
  -m plant-manager \
  -w 7200 \
  "You are dispatched to execute epic repomap-core-gfb on branch repomap-core-gfb.

All 5 children are ready. Execute them in order: gfb.1 → gfb.2 → gfb.3 → gfb.4 → gfb.5.

Your operating loop:
1. Run '.kilocode/tools/bd ready' to find the next eligible bead under this epic
2. Claim it: '.kilocode/tools/bd update {id} --status in_progress'
3. Execute it: delegate through /start-task workflow (process-orchestrator per bead)
4. After execution completes, commit the work: one commit per bead, message references the bead ID
5. Close the bead: '.kilocode/tools/bd close {id}'
6. Export beads: '.kilocode/tools/bd export -o .beads/issues.jsonl'
7. Loop back to step 1

Stop when all children of repomap-core-gfb are closed, or when you hit a bead that
cannot be completed (create an issue and escalate).

You are on branch repomap-core-gfb. All commits go here.
Each bead is one commit. Each bead gets its own process-orchestrator delegation.
Do NOT skip beads or work on blocked beads — follow bd ready ordering.

Key context for the children:

- gfb.1: Add _load_beads_enrichment() to optimization/training_data.py. Connect to
  beads_repomap-core DB (read-only) and batch-query hierarchy_depth, parent_bead_id,
  formula_id, epic_outcome per bead_id. Add BeadsEnrichment dataclass. Merge into
  extract_task_profiles(). No N+1 queries.

- gfb.2: Update build_dspy_example() to include beads context (bead_type, hierarchy_depth,
  formula_id) in DSPy Example kwargs. Update CardExitCompileSignature in card_exit.py with
  optional InputField hints. Must be backward compatible for examples without beads data.

- gfb.3: Update run_compilation.py to group training examples by (card_id, hierarchy_depth,
  formula_id) and compile specialized prompts with compound IDs like
  card-exit:<card_id>:depth-<N> and card-exit:<card_id>:formula-<id>. Minimum 3 examples
  per group. Always also compile generic card-exit:<card_id>. Write via dolt_bus.py.

- gfb.4: Update prompt-injection.ts resolveCardExitPrompt() with resolution cascade:
  formula+depth → formula → depth → generic → static. Update prompt-reader.ts
  readCardExitPrompt() to accept candidate prompt ID list, single IN query.
  Accept depth/formula_id as optional params (Option B from spec). Log specificity level.

- gfb.5: End-to-end verification. Run DSPy compilation, verify compound prompt IDs in
  compiled_prompts table, verify dispatch logs show specificity level. Test with and without
  bead_id.

Python venv is at ~/Projects-Employee-1/repomap-core/.venv/ — use .venv/bin/python for all
Python execution. DSPy compilation requires: op run --env-file .env.op -- .venv/bin/python -m optimization.run_compilation

The 5 children are ready. Start with gfb.1."
```

## Cost Budget

$5/session, 200 steps, $25/tree (defaults).
2-hour timeout (-w 7200) gives room for all 5 beads.

## Expected Outcome

- 5 beads executed sequentially (gfb.1 → gfb.2 → gfb.3 → gfb.4 → gfb.5)
- One commit per bead on the repomap-core-gfb branch
- training_data.py enriched with beads hierarchy context
- run_compilation.py produces compound prompt IDs
- prompt-injection.ts resolves most-specific → generic cascade
- Epic closed when all children pass

## Results

_(to be filled after dispatch completes)_
