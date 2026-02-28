# Epic g6o Execution Plan — DSPy Optimization Layer

> **Created:** 2026-02-27
> **For:** Plant Manager (Tier 1)
> **Epic:** `repomap-core-g6o` — Phase 3.5: DSPy Optimization Layer
> **Research:** `docs/research/dspy-integration-analysis-2026-02-27.md`
> **Thinking session:** `.kilocode/thinking/g6o-epic-review-2026-02-27.json`

---

## Context

DSPy (Axis 7: Optimization) closes the feedback loop between execution data in Dolt and the prompts that drive agent behavior. The epic has been reviewed, decisions are locked, and beads are updated. This document is the execution plan for the plant manager to delegate work through process-orchestrator subtasks.

### Key Decisions (Already Made)

1. **Data infrastructure first** — `g6o.8` is a P1 prerequisite (expand DoltWriter, fix child_rels bug, backfill 1,089 historical Kilo tasks into Dolt)
2. **Dolt-as-bus** — Python DSPy code and TS daemon communicate via Dolt MySQL protocol. No new service layer.
3. **Prompt-compiled assertions** — g6o.6 uses assertion logic baked into prompt text. No Python sidecar in v1.
4. **4f0.5 decoupled** — g6o.2 wraps existing fitter-dispatch.ts templates directly.
5. **Code placement** — DSPy code goes in `optimization/` or `daemon/optimization/`, NOT `src/`.

### Data Landscape

- **Dolt `punch_cards` DB:** 2,560 punches, 55 sessions, 4 checkpoints. Tables: `punches`, `tasks` (0 rows), `checkpoints`, `child_rels` (0 rows — bug), `punch_cards`, `child_relationships`, `cost_aggregate`
- **Kilo Code task store:** `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/` — 1,089 tasks, 2.5 GB. Each task has `api_conversation_history.json`, `task_metadata.json`, `ui_messages.json`, `checkpoints/`
- **Daemon components:** `daemon/src/writer/index.ts` (DoltWriter), `daemon/src/governor/fitter-dispatch.ts` (5 prompt templates), `daemon/src/governor/diagnosis-engine.ts` (5 heuristic classifiers), `daemon/src/lifecycle/daemon.ts` (SSE event loop), `daemon/src/lifecycle/catchup.ts` (batch replay)

---

## Execution Order

### Wave 1: Data Infrastructure (Prerequisite)

**Spawn process-orchestrator for `g6o.8`:**

```
task_id: repomap-core-g6o.8
objective: Expand DoltWriter to capture full session telemetry, fix child_rels bug, backfill historical Kilo task store data into Dolt
scope:
  - daemon/src/writer/index.ts (expand DoltWriter)
  - daemon/src/lifecycle/daemon.ts (wire new telemetry writing into SSE processing)
  - daemon/src/lifecycle/catchup.ts (wire into batch replay)
  - .kilocode/tools/dolt_punch_init.sh (add new table DDL)
  - daemon/tests/ (new tests for expanded writer)
  - New backfill script/tool for Kilo task store migration
success_criteria:
  - child_rels table has > 0 rows after daemon catch-up runs
  - New Dolt tables exist: sessions, messages, tool_calls
  - DoltWriter.writePunch() also writes to sessions/messages/tool_calls during normal operation
  - Backfill script ingests 1,089 historical tasks from Kilo store into Dolt
  - daemon tests pass (vitest)
constraints:
  - Do NOT modify src/ (Python deterministic core)
  - Do NOT modify .kilocode/ rules or modes (plant infrastructure)
  - Dolt schema must be backwards-compatible (existing punches table untouched)
context_pointers:
  - docs/research/dspy-integration-analysis-2026-02-27.md (section "Plant Manager Review Decisions")
  - daemon/src/writer/index.ts (current DoltWriter)
  - daemon/src/lifecycle/daemon.ts (SSE event loop)
  - daemon/src/lifecycle/catchup.ts (batch catch-up)
  - .kilocode/tools/dolt_punch_init.sh (existing schema)
  - daemon/src/governor/types.ts (existing type definitions)
```

**Gate:** `bd show repomap-core-g6o.8` confirms closed. Verify: `dolt sql -q "USE punch_cards; SELECT COUNT(*) FROM sessions; SELECT COUNT(*) FROM child_rels;"` returns > 0 rows.

---

### Wave 2: DSPy Foundation (Can Start After Wave 1 or in Parallel for Non-Data Parts)

**Spawn process-orchestrator for `g6o.1`:**

```
task_id: repomap-core-g6o.1
objective: Install DSPy, configure LM providers, validate basic signature→module→predict loop, prototype Dolt-as-bus pattern
scope:
  - pyproject.toml (add dspy dependency)
  - New directory: optimization/ or daemon/optimization/ (decide during task)
  - Dolt-as-bus prototype: Python writes compiled prompt to Dolt table, TS reads it
  - Smoke test proving end-to-end DSPy works
success_criteria:
  - `pip install dspy` succeeds in .venv
  - Basic DSPy signature→module→predict loop works with Anthropic/OpenAI
  - Dolt-as-bus prototype: Python script writes a compiled prompt string to a Dolt table, separate TS script reads it back
  - Code placement decision documented (optimization/ vs daemon/optimization/)
  - Smoke test exists and passes
constraints:
  - DSPy code does NOT go in src/ (deterministic core)
  - Do NOT modify existing daemon functionality
  - Smoke test should work without expensive API calls (use dspy.utils.DummyLM or similar)
context_pointers:
  - docs/research/dspy-integration-analysis-2026-02-27.md
  - daemon/src/writer/index.ts (Dolt connection pattern)
  - .kilocode/tools/dolt_punch_init.sh (Dolt schema pattern)
```

**Gate:** `bd show repomap-core-g6o.1` confirms closed. Smoke test passes.

---

### Wave 3: Signatures + Training Data (Can Parallel After Respective Dependencies)

**Spawn process-orchestrator for `g6o.2` (depends on g6o.1):**

```
task_id: repomap-core-g6o.2
objective: Formalize fitter dispatch prompt templates as typed DSPy signatures
scope:
  - optimization/ (or wherever g6o.1 placed DSPy code)
  - Read (not modify) daemon/src/governor/fitter-dispatch.ts for template content
  - 5 DSPy signatures: stuck_on_approval, infinite_retry, scope_creep, context_exhaustion, model_confusion
success_criteria:
  - Each of the 5 diagnosis categories has a typed DSPy signature
  - Each signature can produce output equivalent to the existing TS template
  - Compiled prompt output is written to Dolt (Dolt-as-bus)
  - Tests verify signature output matches expected structure
constraints:
  - Do NOT modify fitter-dispatch.ts (existing TS templates stay as fallback)
  - Decoupled from 4f0.5 — wrap existing templates directly
context_pointers:
  - daemon/src/governor/fitter-dispatch.ts (5 existing templates)
  - daemon/src/governor/types.ts (DiagnosisReport, FitterDispatchInput)
  - Output from g6o.1 (code placement, Dolt-as-bus pattern)
```

**Spawn process-orchestrator for `g6o.3` (depends on g6o.8):**

```
task_id: repomap-core-g6o.3
objective: Extract (input, outcome) training data from enriched Dolt tables as DSPy Example objects
scope:
  - optimization/ (DSPy code directory)
  - Read from Dolt: sessions, messages, tool_calls, punches, checkpoints tables
success_criteria:
  - Produces dspy.Example objects with labeled training sets
  - Successful sessions, failed sessions, kill→recovery pairs identified
  - Session outcome labeling heuristics documented and tested
  - At least 50+ labeled examples produced from historical data
constraints:
  - Read-only access to Dolt tables (no schema changes)
  - Must handle missing/incomplete data gracefully
context_pointers:
  - Output from g6o.8 (enriched Dolt tables)
  - docs/research/dspy-integration-analysis-2026-02-27.md
  - .kilocode/tools/dolt_punch_init.sh (schema reference)
```

**Gate:** Both `g6o.2` and `g6o.3` closed before proceeding to Wave 4.

---

### Wave 4: Metrics (Depends on Wave 3)

**Spawn process-orchestrator for `g6o.4` (depends on g6o.3):**

```
task_id: repomap-core-g6o.4
objective: Define quality metrics as Python functions over Dolt data for use with DSPy optimizers
scope:
  - optimization/ (DSPy code directory)
  - Metrics: punch card pass rate, cost efficiency, task completion rate, fitter recovery success rate, tool adherence score
success_criteria:
  - Each metric takes a dspy.Example and returns a numeric score
  - Metrics are testable with synthetic data
  - Metrics produce meaningful differentiation on the real training set from g6o.3
constraints:
  - Metrics must be deterministic (same input → same score)
context_pointers:
  - Output from g6o.3 (training data)
  - daemon/src/governor/punch-card-validator.ts (validation logic reference)
  - daemon/src/governor/types.ts (ToolAdherenceResult)
```

**Gate:** `g6o.4` closed.

---

### Wave 5: Compilation + Assertions + Classifier (P2, Can Parallel)

**Spawn process-orchestrator for `g6o.5` (depends on g6o.2 + g6o.4):**

```
task_id: repomap-core-g6o.5
objective: Compile fitter dispatch DSPy modules with optimizer against recovery success rate metric
scope:
  - optimization/ (DSPy code directory)
  - Compile with MIPROv2 or GEPA optimizer
  - Write compiled prompts to Dolt
  - Compare compiled vs hand-written templates
success_criteria:
  - Compilation completes successfully
  - Compiled prompts stored in Dolt
  - A/B comparison shows compiled prompts are at least as good as hand-written
constraints:
  - Compilation is offline/batch — not per-session
  - Budget: $2-$20 per compilation run
context_pointers:
  - Output from g6o.2 (signatures) and g6o.4 (metrics)
  - docs/research/dspy-integration-analysis-2026-02-27.md (optimizer options)
```

**Spawn process-orchestrator for `g6o.6` (depends on g6o.1):**

```
task_id: repomap-core-g6o.6
objective: Add prompt-compiled assertion constraints for task decomposition
scope:
  - optimization/ (DSPy code directory)
  - Compile assertion logic into prompt text (NOT runtime Python sidecar)
  - Target: subtask count bounds, per-subtask cost targets, scope constraints
success_criteria:
  - dspy.Assert/Suggest used during compilation to shape prompts
  - Compiled output encodes constraints as explicit prompt instructions
  - Tests verify compiled prompts contain expected constraint language
constraints:
  - No Python sidecar service — assertions are prompt-compiled only in v1
  - Decision documented in research doc
context_pointers:
  - docs/research/dspy-integration-analysis-2026-02-27.md (Decision 3)
  - Output from g6o.1 (DSPy foundation)
```

**Spawn process-orchestrator for `g6o.7` (depends on g6o.4):**

```
task_id: repomap-core-g6o.7
objective: Replace/augment heuristic diagnosis classification with a compiled DSPy classifier
scope:
  - optimization/ (DSPy code directory)
  - Train on historical kill→diagnosis pairs from Dolt
  - Classifier input: tool patterns, last messages, kill reason
  - Classifier output: category + confidence + evidence
success_criteria:
  - Compiled classifier produces same 5 categories as heuristic engine
  - Accuracy on held-out test set matches or exceeds heuristic baselines
  - Classifier output written to Dolt for TS governor to read
constraints:
  - Heuristic classifiers in diagnosis-engine.ts stay as fallback
  - Classifier runs as Python CLI or Dolt-as-bus, not as a service
context_pointers:
  - daemon/src/governor/diagnosis-engine.ts (existing heuristics)
  - daemon/src/governor/types.ts (DiagnosisCategory, DiagnosisReport)
  - Output from g6o.4 (metrics and training data)
```

**Gate:** All of g6o.5, g6o.6, g6o.7 closed. Epic `g6o` complete.

---

## Runtime Attestation

Each process-orchestrator subtask MUST report:
- `runtime_model_reported`: the model used by the specialist modes
- `runtime_mode_reported`: the modes used for implementation

Roll up attestations when closing the epic.

## Quality Gates

For any task that modifies `daemon/`:
- `cd daemon && npx vitest run` must pass
- TypeScript compilation: `cd daemon && npx tsc --noEmit`

For any task that adds Python code:
- `.venv/bin/python -m ruff format --check .`
- `.venv/bin/python -m ruff check .`
- `.venv/bin/python -m mypy` on the new code
- `.venv/bin/python -m pytest -q`
