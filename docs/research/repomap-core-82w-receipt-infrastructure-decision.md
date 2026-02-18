# Research Decision: repomap-core-82w — Receipt infrastructure design (persistence format + thinking session introspection)

## Date
2026-02-15

## Bead
repomap-core-82w

## Inputs / evidence reviewed
- Imported and reviewed thinking session export: `.kilocode/thinking/task-repomap-core-82w-prep-2026-02-15.json` (local-only file, not tracked in git)
- Evidence that thinking session filenames are *not* reliably bead-keyed (cannot safely glob by bead id):
  - `.kilocode/thinking/pr-12-review-response-plan-2026-02-15.json` (local-only file, not tracked in git)
  - `.kilocode/thinking/adversarial-workflows-design-2026-02-12.json` (local-only file, not tracked in git)

## Decision summary
- **§10a — Receipt persistence format:** **Option C-refined (Hybrid with JSONL manifest)**
  - Keep `gate_runs.jsonl` as-is (schema `gate_run.v1`).
  - Add `receipt_manifests.jsonl` (one JSONL line per workflow completion) to record explicit pointers to all receipts for that bead/workflow, including thinking session file paths.
  - Rationale: explicit pointers solve thinking session naming inconsistency with O(1) lookup and append-only semantics.
- **§10b — Thinking session introspection:** **Fully feasible offline; no MCP server needed at audit time**
  - Sequential-thinking exports are transparent JSON and can be parsed deterministically.
  - Quality metrics can be derived without network access.

---

# §10a — Receipt Persistence Format

## Decision
**Option C-refined (Hybrid with JSONL manifest).**

### Chosen shape
- **Gate run receipts** remain in an append-only log: `gate_runs.jsonl`.
- **Workflow completion manifests** are recorded in `receipt_manifests.jsonl`, one JSON line per completed workflow.
- A planned auditor (e.g., [`receipt_audit.py`](src/receipt_audit.py)) reads both:
  1. reads `receipt_manifests.jsonl` to discover *which* receipts exist for a bead/workflow (including explicit thinking session `path` pointers)
  2. reads `gate_runs.jsonl` to evaluate gate results
  3. reads thinking session export JSON files by the paths recorded in the manifest to compute reasoning-quality metrics

### Why this is the correct trade
- **Explicit pointers beat filename heuristics.** Existing thinking session filenames do not reliably include `bead_id`, so any “filesystem-only” lookup via glob is non-deterministic / incomplete.
- **Append-only logs are compatible with determinism.** Both JSONL files are append-only and naturally support stable replay.
- **Zero migration.** Existing `gate_runs.jsonl` stays intact; new manifest adds capability without rewriting existing data.

## Alternatives considered

### Option A — Filesystem-only receipts (REJECTED)
**Reason:** thinking session filenames are not reliably bead-keyed, so a bead→session association cannot be reconstructed deterministically via path globs.

**Evidence:** files exist whose names contain no bead id:
- [`.kilocode/thinking/pr-12-review-response-plan-2026-02-15.json`](.kilocode/thinking/pr-12-review-response-plan-2026-02-15.json)
- [`.kilocode/thinking/adversarial-workflows-design-2026-02-12.json`](.kilocode/thinking/adversarial-workflows-design-2026-02-12.json)

**Failure mode:** “no match found” is ambiguous between “session missing” vs “session exists but not discoverable by naming convention.”

### Option B — Unified receipt log (REJECTED)
**Reason:** merges dissimilar receipt types (gate runs vs thinking sessions vs future artifacts) into a single stream, but *thinking session quality* still requires opening and parsing the full thinking JSON to answer any non-trivial question. This adds indirection without reducing complexity.

### Option C — Hybrid (ACCEPTED, refined)
**Refinement:** add a manifest file with *explicit receipt pointers* (including thinking session path), rather than relying on filename conventions.

## Persistence formats and schemas

### Existing: `gate_runs.jsonl` (unchanged)
Reference schema line:
```json
{"bead_id": "...", "elapsed_seconds": 0.101, "exit_code": 0, "gate_id": "ruff-format", "invocation": "...", "run_signature": "...", "run_timestamp": "2026-02-15T02:11:21.000Z", "schema_version": "gate_run.v1", "status": "pass", "stop_reason": null}
```

### New: `receipt_manifests.jsonl`
**One line per workflow completion**, recording explicit receipt pointers for that bead/workflow completion.

Schema (v1 draft):
```json
{
  "bead_id": "repomap-core-ywk.3",
  "workflow": "process-orchestrator",
  "completed_at": "2026-02-15T02:12:00Z",
  "receipts": [
    {"type": "gate_run", "source": "gate_runs.jsonl"},
    {"type": "thinking_session", "path": ".kilocode/thinking/task-ywk3-prep-2026-02-15.json"}
  ]
}
```

#### Semantics
- `receipt_manifests.jsonl` is append-only.
- `completed_at` is a stable “workflow completion time,” not “line appended time” (those can differ under buffered writes).
- Each `receipts[]` entry is a *pointer*, not an inlined payload.

#### Lookup complexity
- Bead/workflow lookup: scan JSONL (O(n)) unless/ until an index is introduced.
- Receipt dereference: O(1) given explicit pointers.
- Optional future optimization: maintain a compact sidecar index (e.g., `receipt_manifests.idx.json`) keyed by `(bead_id, workflow)` → line offsets, but only if profiling proves need.

## Writer responsibilities (orchestrator / landing)
At the end of a workflow (the “landing” phase), the orchestrator/landing script must append a single manifest line for the bead/workflow run.

Minimum invariant:
- if a thinking session export exists, the manifest line must point to it via `receipts[].path`

## Reader responsibilities (`receipt_audit.py`)
A planned audit tool (e.g., [`receipt_audit.py`](src/receipt_audit.py)) must:
- read manifests
- follow `thinking_session` pointers and compute the deterministic quality metrics defined in §10b
- read gate runs and compute pass/fail summaries per bead/workflow

## Diagram (data flow)
```mermaid
flowchart LR
  A[workflow runtime] --> B[append gate_runs.jsonl]
  A --> C[export thinking session JSON]
  A --> D[append receipt_manifests.jsonl\n(with explicit pointers)]

  E[receipt_audit.py] --> D
  E --> B
  E --> C
  E --> F[receipt report\n(per bead/workflow)]
```

---

# §10b — Thinking Session Introspection

## Decision
**Fully feasible offline — no MCP server needed at audit time.**

Rationale: the sequential thinking MCP server exports thinking sessions as transparent JSON files on disk. Auditing can operate by reading these exported JSON files directly.

## Evidence: exported thinking JSON is transparent and structured
Empirically verified from [`.kilocode/thinking/task-repomap-core-82w-prep-2026-02-15.json`](.kilocode/thinking/task-repomap-core-82w-prep-2026-02-15.json) by parsing it locally:
- top-level keys: `exportedAt`, `lastUpdated`, `metadata`, `thoughts`
- `metadata` keys: `stages`, `totalThoughts`
- `thoughts` is a list of structured records
- observed stages include: Problem Definition, Research, Analysis, Synthesis, Conclusion

## Thinking Session JSON schema (empirically verified)

### Top-level
- `thoughts`: list
- `lastUpdated`: ISO 8601 timestamp
- `exportedAt`: ISO 8601 timestamp
- `metadata`: dict

### `metadata`
- `totalThoughts`: int
- `stages`: dict (`stage_name` → count)

### Per-thought record
- `thought`: string
- `thoughtNumber`: int
- `totalThoughts`: int
- `nextThoughtNeeded`: bool
- `tags`: list[string]
- `axiomsUsed`: list[string]
- `assumptionsChallenged`: list[string]
- `timestamp`: ISO 8601 timestamp
- `id`: UUID string
- `stage`: one of {Problem Definition, Research, Analysis, Synthesis, Conclusion}

## Deterministically extractable thinking-quality metrics (9)

| # | Metric | Deterministic extraction | Quality signal heuristic |
|---:|---|---|---|
| 1 | Thought count | `metadata.totalThoughts` (or `len(thoughts)` cross-check) | ≥4 good; 2–3 degraded; 0–1 missing |
| 2 | Stage distribution | `metadata.stages` | Conclusion present = good; single-stage dominance = suspicious |
| 3 | Branch budget evidence | Count thoughts in Problem Definition and/or Analysis stages | ≥2 in those stages = good exploration; 0–1 = weak branching |
| 4 | Session exported | File existence on disk | Exists = good; missing = receipt incomplete |
| 5 | Session timing sanity | `exportedAt` − first `thoughts[].timestamp` | Extremely short/long durations can flag anomalies |
| 6 | Tags present | any `thoughts[].tags` non-empty | Traceability and retrieval affordance |
| 7 | Axioms used | count of thoughts with non-empty `axiomsUsed` | Principled reasoning vs unstructured narrative |
| 8 | Assumptions challenged | count of thoughts with non-empty `assumptionsChallenged` | Epistemic rigor / explicit uncertainty |
| 9 | Bead ID linkage | test whether any tag matches bead id pattern | Strong task linkage; missing indicates “orphan” thinking |

### Notes on determinism
- Metrics above are functions of the exported JSON file contents + file existence only.
- No network calls are required.
- No “semantic scoring” is assumed.

---

# Implementation guidance (Phase A, repomap-core-9hd)

1. Define `receipt_manifests.jsonl` schema and write contract (append-only, one line per workflow completion).
2. Implement [`receipt_audit.py`](src/receipt_audit.py):
   - manifest reader + `gate_runs.jsonl` reader
   - thinking session parsing + extraction of the 9 metrics
3. Amend landing script to append manifest entries at workflow completion.
4. Enforce future thinking session naming convention (must include bead id) to improve human discoverability, while still relying on manifest pointers for correctness.

---

# Acceptance criteria (this document)
- [x] Decision on receipt persistence format with rationale
- [x] Documented thinking session JSON schema (with evidence of transparency)
- [x] List of deterministically-extractable thinking quality metrics
