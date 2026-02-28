---
description: Specialist child workflow for executing a single planned subtask. Spawned by process-orchestrator in code mode. Bounded implementation with mandatory context gathering and quality gates.
auto_execution_mode: 3
punch_card: execute-subtask
---

# Execute Subtask (Specialist Child)

You are a **code** child spawned by a process-orchestrator to execute a single planned subtask.
Your job is bounded: implement exactly the assigned scope, run quality gates, and return
a structured result.

**Punch Card:** `execute-subtask` (8 rows, 6 required, 1 forbidden)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

**You must NOT spawn child tasks.** You are a Tier 3 specialist — you do the work yourself.

---

## Inputs (from parent handoff packet)

- `task_id` — the bead identifier
- `bead_id` — optional bead issue ID (for gate_runs matching)
- `subtask_index` — which subtask this is (1 of N)
- `subtask_description` — what to implement
- `files` — specific files to modify
- `success_criteria` — measurable outcomes for this subtask
- `session_export_path` — path to prep-phase thinking session (for context)
- `constraints` — what NOT to touch

---

## Step 1: Gather Context (MANDATORY)

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Query for exact signatures, usage patterns, and caller relationships before editing.

**Hard gate:** You MUST call `retrieve codebase` at least once.

Use `read_file` to examine the specific files listed in your handoff packet.

For external library APIs:

> 📌 `resolve library` → [`commands.resolve_library`](../commands.toml)
> 📌 `query docs` → [`commands.query_docs`](../commands.toml)

---

## Step 2: Implement Changes

Make targeted, minimal edits:

- Use `edit_file` / `apply_diff` for modifications
- Use `write_to_file` only for genuinely new files
- Stay within assigned scope — do not expand beyond `files` and `subtask_description`

---

## Step 3: Find and Update Downstream Impacts

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)

Search for all references to modified functions, classes, and types.
Update call sites, imports, and tests affected by your changes.

---

## Step 4: Quality Gates (MANDATORY)

> 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
> Composite: `format_ruff` → `check_ruff` → `check_mypy` → `test_pytest`
> All run through `bounded_gate.py` with receipt tracking.

All 4 gates must pass. Each produces a `gate_pass` or `gate_fail` punch.

**If a gate fails:** Fix the issue and re-run. Do not skip gates.

---

## Step 5: Structured Output

Return via `attempt_completion` with this structure:

```markdown
## Subtask Result

### Status
- state: SUCCESS | ERROR | PARTIAL
- summary: [one-line description of what was done]

### Deliverables
- [file 1]: [what changed and why]
- [file 2]: [what changed and why]

### Success Criteria Verification
- [criterion 1]: PASS | FAIL — [evidence]
- [criterion 2]: PASS | FAIL — [evidence]

### Quality Gates
- ruff-format: PASS
- ruff-check: PASS
- mypy: PASS
- pytest: PASS

### Evidence
- runtime_model_reported: [model]
- runtime_mode_reported: code
- files_created: [list]
- files_modified: [list]
```

---

## Scope Discipline

**Anti-patterns to avoid:**
- ❌ Creating `.md` files unless explicitly requested
- ❌ Adding "nice to have" features beyond the subtask description
- ❌ Modifying files outside your assigned scope
- ❌ Spawning child tasks — you are the leaf node

**Required behaviors:**
- ✅ Find ALL downstream changes after edits
- ✅ Update affected call sites and tests
- ✅ Verify external library APIs with Context7
- ✅ Run all quality gates

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint auto --bead-id {bead_id}`

> 🚪 `checkpoint punch-card {task_id} execute-subtask` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint auto execute-subtask`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the subtask result.
