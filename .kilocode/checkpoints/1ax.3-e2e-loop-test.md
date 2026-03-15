# Checkpoint: 1ax.3-e2e-loop-test

**Task:** repomap-core-1ax.3
**Date:** 2026-03-14
**Branch:** repomap-core-1ax

## Summary

Executed the three-phase end-to-end loop test proving the Beads+DSPy self-learning loop works **mechanically** through five timestamped stages. The loop's compilation phase (T4) produces formula-specialized compiled prompts when enrichment data is present. However, the runtime dispatch phase (T5) revealed a **wiring gap**: `factory-dispatch.ts` does not pass `formulaId` or `depth` to the prompt resolution cascade, so the formula-specific prompt exists in Dolt but is unreachable at dispatch time.

## Timeline

| Stage | Timestamp (EDT) | Event |
|-------|-----------------|-------|
| T1 | 2026-03-14 ~15:00 | Formula cooked (from 1ax.2) |
| T2 | 2026-03-14 15:53:46 | Molecule poured, 4 beads created (from 1ax.2) |
| T3 | 2026-03-14 15:53:47 | First dispatch completed, bead_id in Dolt (from 1ax.2) |
| T4 | 2026-03-14 20:38:56–20:39:00 | DSPy compiled, formula-specific prompt written |
| T5 | 2026-03-14 20:40:38 | Re-dispatch with --card, prompt resolved as generic (wiring gap) |

## Phase A: Compile with formula-tagged data

### A.1: factory.tasks verification (from 1ax.2)

```sql
SELECT task_id, mode, status, bead_id, punch_card_id, started_at
FROM factory.tasks
WHERE bead_id = 'repomap-core-mol-srx8';
```

```text
task_id,mode,status,bead_id,punch_card_id,started_at
ses_31216871dffe0B7H56ooxHv3X1,pr-review,abandoned,repomap-core-mol-srx8,,2026-03-14 15:53:47
```

**Finding:** `punch_card_id` was NULL — the 1ax.2 dispatch did not pass `--card`.

### A.2: Data gap discovery

Three infrastructure gaps were found:

1. **Bead metadata gap:** `bd mol pour` creates beads with `metadata = {}` — no `formula_id` set automatically.
2. **punch_card_id gap:** Factory dispatch without `--card` writes NULL to `tasks.punch_card_id`.
3. **Compilation LIMIT gap:** `build_training_set(limit=200)` uses `ORDER BY task_id` — synthetic tasks with later-sorting IDs fall outside the window.

### A.3: Data enrichment to unblock compilation

Remediation steps:

1. Set `formula_id` metadata on all mol beads:
   ```bash
   .kilocode/tools/bd update repomap-core-mol-srx8 --metadata '{"formula_id": "respond_to_pr_review"}'
   .kilocode/tools/bd update repomap-core-mol-wi63 --metadata '{"formula_id": "respond_to_pr_review"}'
   .kilocode/tools/bd update repomap-core-mol-cpnd --metadata '{"formula_id": "respond_to_pr_review"}'
   .kilocode/tools/bd update repomap-core-mol-d9jz --metadata '{"formula_id": "respond_to_pr_review"}'
   ```

2. Set `punch_card_id` on existing task:
   ```sql
   UPDATE factory.tasks SET punch_card_id = 'build-pr-ledger'
   WHERE task_id = 'ses_31216871dffe0B7H56ooxHv3X1';
   ```

3. Created synthetic tasks with early-sorting IDs and matching enrichment:
   - Bead IDs: `repomap-core-mol-d9jz.3`, `repomap-core-mol-d9jz.4` (with `formula_id` metadata)
   - Task IDs: `1ax3-e2e-loop-test-a`, `1ax3-e2e-loop-test-b` (sort before `ses_*`)
   - Each with `punch_card_id = 'build-pr-ledger'` and punch rows in `factory.punches`

4. Verified enrichment count:
   ```text
   Total profiles with card_id=build-pr-ledger: 3
   All 3 have formula_id=respond_to_pr_review
   ```

### A.4: DSPy compilation

```bash
.venv/bin/python -m optimization.run_compilation
```

**Full output (T4 = 2026-03-14 20:38:56):**

```text
============================================================
  DSPy Compilation Pipeline — Self-Learning Factory
============================================================
  LM: openrouter/openai/gpt-4o-mini
  Dry run: False

[1/4] Loading punch card definitions + failures from Dolt...
       26 punch cards, 7 historical failures
[2/4] Building training set from Dolt telemetry...
       200 training examples
[3/4] Generating card-exit prompts (26 cards)...
       ✅ card-exit:acknowledge-pr-ledger (380 chars)
       ✅ card-exit:audit-orchestrate (330 chars)
       ✅ card-exit:build-pr-ledger (392 chars)
       ✅ card-exit:build-pr-ledger:depth-2 (313 chars)
       ✅ card-exit:build-pr-ledger:formula-respond_to_pr_review (425 chars)
       [... 23 more generic card-exit prompts ...]
[4/4] Generating fitter-dispatch prompts (5 categories)...
       [... 5 fitter-dispatch prompts ...]

============================================================
  COMPILATION COMPLETE
============================================================
  Card-exit prompts:       28/26
  Fitter-dispatch prompts: 5/5
  Dolt compiled_prompts:   33 total (28 card-exit, 5 fitter-dispatch)
```

### A.5: Compiled prompts verification

```sql
SELECT prompt_id, compiled_at, dspy_version, LENGTH(compiled_prompt) as len
FROM factory.compiled_prompts
WHERE prompt_id LIKE 'card-exit:build-pr-ledger%'
ORDER BY prompt_id;
```

```text
prompt_id,compiled_at,dspy_version,len
card-exit:build-pr-ledger,2026-03-14 20:38:56,3.1.3,392
card-exit:build-pr-ledger:depth-2,2026-03-14 20:38:58,3.1.3,313
card-exit:build-pr-ledger:formula-respond_to_pr_review,2026-03-14 20:39:00,3.1.3,425
```

**Conclusion A:** Formula-specific prompt `card-exit:build-pr-ledger:formula-respond_to_pr_review` exists in Dolt with 425 chars, compiled at 20:39:00.

## Phase B: Re-dispatch and verify injection

### B.1: New molecule pour (T5a = 2026-03-14 20:40:17)

```bash
.kilocode/tools/bd mol pour respond-to-pr-review \
  --var pr_number=1001 --var owner_repo=test/repo \
  --var head_ref_name=test-branch-2 --var bead_id=test-bead-2
```

```text
✓ Poured mol: created 4 issues
  Root issue: repomap-core-mol-g2xs
  Phase: liquid (persistent in .beads/)
```

New molecule structure:

```text
○ repomap-core-mol-g2xs ● P2 [epic] respond_to_pr_review
├── ○ repomap-core-mol-8ct2 ● P2 Build ledger
├── ○ repomap-core-mol-lc4y ● P2 Fix items
└── ○ repomap-core-mol-ljd1 ● P2 Acknowledge ledger
```

### B.2: Metadata update on new beads

```bash
.kilocode/tools/bd update repomap-core-mol-g2xs --metadata '{"formula_id": "respond_to_pr_review"}'
.kilocode/tools/bd update repomap-core-mol-8ct2 --metadata '{"formula_id": "respond_to_pr_review"}'
.kilocode/tools/bd update repomap-core-mol-lc4y --metadata '{"formula_id": "respond_to_pr_review"}'
.kilocode/tools/bd update repomap-core-mol-ljd1 --metadata '{"formula_id": "respond_to_pr_review"}'
```

All updated at 2026-03-14 16:40:27.

### B.3: Dispatch (T5b = 2026-03-14 20:40:38)

```bash
.kilocode/tools/factory_dispatch.sh \
  --mode pr-review --card build-pr-ledger \
  --bead-id repomap-core-mol-8ct2 \
  --no-monitor \
  "Test dispatch for 1ax.3 e2e loop verification"
```

**Full dispatch output:**

```text
[factory] 16:40:38 Pre-flight: checking all 5 stack components...
[factory] 16:40:38   ✅ kilo serve (100 sessions)
[factory] 16:40:38   ✅ Dolt server (port 3307)
[factory] 16:40:38   ✅ oc-daemon (SSE → Dolt)
[factory] 16:40:38   ✅ Temporal server (port 7233)
[factory] 16:40:38   ✅ Temporal worker
[factory] 16:40:38 Pre-flight passed (5/5 components healthy)
[factory] 16:40:38 Built prompt from string (45 chars)
[factory] 16:40:38 Session created: ses_311eba138ffeg4OvaRcJuqbKi4
[factory] 16:40:38 Title: factory: pr-review @ 2026-03-14 20:40
[factory] 16:40:38 Task row created: ses_311eba138ffeg4OvaRcJuqbKi4 (bead: repomap-core-mol-8ct2)
[prompt-resolution] Resolved prompt: card-exit:build-pr-ledger (specificity: generic)
[factory] 16:40:38 Card exit prompt injected (card=build-pr-ledger, source=compiled)
[factory] 16:40:38 Prompt dispatched to mode: pr-review
ses_311eba138ffeg4OvaRcJuqbKi4
```

### B.4: Prompt resolution comparison

| Dispatch | Prompt Resolved | Specificity | Source |
|----------|----------------|-------------|--------|
| 1ax.2 (T3) | `card-exit:respond-to-pr-review` | generic | compiled |
| 1ax.3 (T5) | `card-exit:build-pr-ledger` | generic | compiled |

**Both dispatches resolved to `specificity: generic`** despite the formula-specific prompt existing in Dolt after compilation. The improvement from 1ax.2 → 1ax.3 is that the correct card was used (build-pr-ledger instead of respond-to-pr-review, via `--card`), but formula specialization was not reached.

### B.5: Wiring gap analysis

**The formula-specific prompt exists but is unreachable:**

```text
card-exit:build-pr-ledger                               → 392 chars (RESOLVED ✅)
card-exit:build-pr-ledger:depth-2                       → 313 chars (unreachable)
card-exit:build-pr-ledger:formula-respond_to_pr_review  → 425 chars (unreachable)
```

**Root cause:** `daemon/src/infra/factory-dispatch.ts` line 396-398:

```typescript
const cardResolution = config.cardId
  ? await resolveCardExitPrompt(config.mode, config.cardId)
  : await resolveCardExitPrompt(config.mode);
```

The `resolveCardExitPrompt` function accepts `(mode, cardIdOverride?, depth?, formulaId?)` but factory-dispatch never passes the 3rd and 4th parameters. The function builds candidate prompt IDs as:

```
card-exit:${cardId}:formula-${formulaId}:depth-${depth}  → candidate 1 (needs formulaId AND depth)
card-exit:${cardId}:formula-${formulaId}                  → candidate 2 (needs formulaId)
card-exit:${cardId}:depth-${depth}                        → candidate 3 (needs depth)
card-exit:${cardId}                                       → candidate 4 (always present)
```

Without `formulaId` and `depth`, only candidate 4 is generated, so the cascade always falls through to generic.

**To close this gap**, `maybeInjectCardPrompt` in factory-dispatch.ts needs to:

1. Look up the bead's `formula_id` from `beads_repomap-core.issues.metadata` using `config.beadId`
2. Look up the bead's `hierarchy_depth` from the same table
3. Pass both to `resolveCardExitPrompt(config.mode, config.cardId, depth, formulaId)`

Additionally, `bd mol pour` should automatically set `metadata.formula_id` on created beads so manual `bd update --metadata` is not required.

## Phase C: Evidence summary

### All test-related rows in factory.tasks

```text
task_id,mode,status,punch_card_id,bead_id,started_at
ses_31216871dffe0B7H56ooxHv3X1,pr-review,abandoned,build-pr-ledger,repomap-core-mol-srx8,2026-03-14 15:53:47
synthetic-1ax3-test-1,pr-review,completed,build-pr-ledger,repomap-core-mol-d9jz.1,2026-03-14 16:32:30
synthetic-1ax3-test-2,pr-review,completed,build-pr-ledger,repomap-core-mol-d9jz.2,2026-03-14 16:32:30
1ax3-e2e-loop-test-a,pr-review,completed,build-pr-ledger,repomap-core-mol-d9jz.3,2026-03-14 16:38:30
1ax3-e2e-loop-test-b,pr-review,completed,build-pr-ledger,repomap-core-mol-d9jz.4,2026-03-14 16:38:32
ses_311eba138ffeg4OvaRcJuqbKi4,pr-review,running,build-pr-ledger,repomap-core-mol-8ct2,2026-03-14 16:40:38
```

### Success criteria assessment

| Criterion | Status | Evidence |
|-----------|--------|----------|
| factory.tasks row with bead_id=repomap-core-mol-srx8 confirmed | ✅ MET | SQL query returned row with task_id ses_31216871... |
| DSPy compilation completes successfully | ✅ MET | 28/26 card-exit + 5/5 fitter-dispatch, 33 total |
| Formula-specific compiled prompt exists (LIKE '%:formula-%') | ✅ MET | `card-exit:build-pr-ledger:formula-respond_to_pr_review` (425 chars) |
| New molecule poured successfully | ✅ MET | repomap-core-mol-g2xs with 4 beads |
| Re-dispatch uses formula-specialized prompt | ❌ NOT MET | Resolved `specificity: generic` due to wiring gap |
| Checkpoint file exists with evidence | ✅ MET | This file |

### Blocking issues for full loop closure

1. **`bd mol pour` metadata gap** — Pour doesn't set `metadata.formula_id` on created beads. Requires manual `bd update --metadata` post-pour. This should be automated in the pour command.

2. **Dispatch → resolver wiring gap** — `factory-dispatch.ts:maybeInjectCardPrompt` does not derive or pass `formulaId`/`depth` from bead metadata to `resolveCardExitPrompt()`. The resolver function supports these params (they're defined, tested in unit tests, and work correctly in isolation), but the call site in the production dispatch path never supplies them.

3. **Training data LIMIT sensitivity** — `build_training_set(limit=200)` with `ORDER BY task_id` means only the first 200 alphabetically-sorted tasks are included. Tasks with IDs sorting late may be excluded from compilation input. Synthetic test data required early-sorting task IDs to work around this.

### Follow-up work items

- **Issue 1:** Wire `formulaId` and `depth` from bead metadata into `maybeInjectCardPrompt` in `factory-dispatch.ts`
- **Issue 2:** Auto-set `metadata.formula_id` in `bd mol pour` from the formula definition
- **Issue 3:** Consider replacing `ORDER BY task_id LIMIT N` with `ORDER BY observed_at DESC LIMIT N` in training data to prioritize recent data

## Conclusion

The Beads+DSPy self-learning loop is **mechanically proven through the compilation phase**:
- Formula metadata → bead enrichment → training examples → DSPy compilation → formula-specific compiled prompts in Dolt ✅
- The loop breaks at the **runtime dispatch phase** due to a wiring gap: `factory-dispatch.ts` doesn't pass `formulaId`/`depth` to `resolveCardExitPrompt()`. The resolver, Dolt storage, and compilation pipeline all work correctly — only the final dispatch call site needs updating.
