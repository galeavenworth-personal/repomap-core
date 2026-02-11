---
description: Orchestrator-based task execution workflow. Uses subtasks for implementation with sequential thinking session continuity and per-subtask progress tracking.
auto_execution_mode: 3
---

# Orchestrate Execute Task Workflow

**Purpose:** Factory-line task execution using Orchestrator Mode with isolated implementation subtasks and session handoffs.

**Trigger:** User invokes `/orchestrate-execute-task <task-id>`

**Philosophy:** Parent = foreman tracking progress, subtasks = workers implementing features, session exports = progress checkpoints.

---

## Overview

This workflow transforms the monolithic `/execute-task` into a multi-subtask orchestration:

```
┌─────────────────────────────────────────────────────────────────┐
│  PARENT (Orchestrator Mode)                                     │
│  ├── Pre-Execution Gate: Load + verify prep session             │
│  ├── Subtask 1 (Code): Implement feature component A            │
│  ├── Subtask 2 (Code): Implement feature component B            │
│  ├── Subtask 3 (Code): Add tests                                │
│  ├── Subtask 4 (Code): Quality gates                            │
│  └── Complete: Update beads, sync, present results              │
└─────────────────────────────────────────────────────────────────┘
```

**Key Benefits:**
- **Isolated implementation contexts**: Each subtask focuses on one component
- **Session continuity**: Import prep session, export progress after each subtask
- **Native progress tracking**: Todo list shows completion status
- **Modular verification**: Each subtask validates its own changes
- **Resumability**: If interrupted, parent knows exactly what's done

---

## Prerequisites

- Prep session exists: `.kilocode/thinking/task-<task-id>-prep-<YYYY-MM-DD>.json`
- Handoff packet available (from `/orchestrate-start-task`)
- Orchestrator mode available
- Sequential thinking MCP server connected

---

## Parent Task: Orchestration

### Step 0: Runtime Model Report (MANDATORY)

The agent cannot switch models/accounts programmatically. At the start of execution, the parent must record what the runtime reports:
The agent cannot switch models/accounts programmatically. At the start of execution, the parent must record what the runtime reports:

- `runtime_model_reported` (from `environment_details`)
- `runtime_mode_reported` (mode slug)

Include this parent-level runtime report in the final execution summary alongside subtask runtime reports.
**Optional:** If the handoff packet contains an operator-declared `model_plan`, verify whether runtime matches it.

### Step 1: Load Handoff Packet

The parent must have access to the handoff packet from `/orchestrate-start-task`:

```markdown
# Expected Handoff Packet Structure
- Exported session path
- Decision summary
- Success criteria
- Proposed subtasks
- Files touched
- Risks + mitigations
```

### Step 2: Initialize Todo List

```python
update_todo_list(
    todos="""
[ ] Runtime Model Report (record runtime model/mode)
[ ] Pre-Execution Gate: Load and verify prep session
[ ] Subtask 1: <implementation-subtask-1>
[ ] Subtask 2: <implementation-subtask-2>
[ ] Subtask 3: <implementation-subtask-3>
[ ] Subtask 4: Add/update tests
[ ] Subtask 5: Run quality gates
[ ] Complete: Update beads and present results
"""
)
```

### Step 3: Pre-Execution Gate Subtask

```python
new_task(
    mode="architect",
    message="""
# Pre-Execution Gate

**Objective:** Load and verify prep session before implementation begins.

**Prep Session Path:** `.kilocode/thinking/task-<task-id>-prep-<YYYY-MM-DD>.json`

**Optional Model Plan (from handoff packet):** <paste-model-plan-here-if-provided>

**MANDATORY Steps:**

## Step 1: Load Prep Session

```python
mcp--sequentialthinking--import_session(
    file_path=".kilocode/thinking/task-<task-id>-prep-<YYYY-MM-DD>.json"
)
```

**If this fails:** Prep session doesn't exist. HALT and run `/orchestrate-start-task` first.

## Step 2: Verify Conclusion Stage Reached

```python
summary = mcp--sequentialthinking--generate_summary()

# Check the summary output for:
# - "currentStage": "Conclusion" appears
# - Multiple thoughts in "Problem Definition" and "Analysis" stages
# - At least 2 interpretation branches explored
# - At least 2 approach branches explored
```

**If Conclusion stage not reached:** Prep is incomplete. HALT.

## Step 3: Optional — Verify Model Plan (operator-declared)

If a `model_plan` was provided in the handoff packet, paste it above and verify it. Using the `model_plan` pasted above:
- Confirm `model_plan_version` is present (expected `v1`).
- Summarize planned routing for `architect` and `orchestrator`.
        - Record `runtime_model_reported` from `environment_details`.
        - Record `runtime_mode_reported` (mode slug from `environment_details`).
        - Set `model_plan_match`: `MATCH` if `runtime_model_reported` equals the declared `model_plan.routing[runtime_mode_reported].model`; `MISMATCH` if it differs; `N/A` if no `model_plan` was provided.

        **Mapping logic:** The `runtime_mode_reported` field (e.g., `architect`, `code`) indexes into `model_plan.routing[*]` to find the expected model. The `model_plan_match` decision indicates whether the observed `runtime_model_reported` corresponds to the routing entry for the current mode.

**If `MISMATCH`:** HALT and instruct the operator to correct UI selection before proceeding.

## Step 4: Review Preparation Decisions

Extract from summary:
- What approach was selected and why?
- What are the success criteria?
- What are the identified risks and mitigations?

**Output Requirements:**
- `model_plan_present`: YES/NO
- `runtime_model_reported`: <from environment_details>
- `runtime_mode_reported`: <mode slug>
- `model_plan_match`: MATCH|MISMATCH|N/A
- Confirmation that prep session is valid
- Summary of key decisions
- List of success criteria
- Risk assessment

**Completion:**
Use `attempt_completion` with verification report including:
- Session validity: PASS/FAIL
- Approach summary
- Success criteria list
- Risk summary
""",
    todos=None
)
```

**Wait for subtask completion.** If FAIL, HALT entire workflow.

### Step 4: Update Progress

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Pre-Execution Gate: Load and verify prep session
[-] Subtask 1: <implementation-subtask-1>
[ ] Subtask 2: <implementation-subtask-2>
[ ] Subtask 3: <implementation-subtask-3>
[ ] Subtask 4: Add/update tests
[ ] Subtask 5: Run quality gates
[ ] Complete: Update beads and present results
"""
)
```

### Step 5: Spawn Implementation Subtasks

For each implementation subtask from the handoff packet:

```python
new_task(
    mode="code",
    message="""
# Implementation Subtask: <subtask-name>

**Objective:** <subtask-description>

**Context from Prep:**
- Approach: <chosen-approach>
- Success criteria: <relevant-criteria>
- Files to modify: <file-list>
- Risks: <relevant-risks>

**MANDATORY: Runtime model report (and optional Model Plan match)**

In your completion summary include:
- `runtime_model_reported` (from `environment_details`)
- `runtime_mode_reported` (mode slug)
- `model_plan_match`: MATCH|MISMATCH|N/A

If a `model_plan` exists and `MISMATCH`: STOP and correct the UI model/account selection before continuing.

**MANDATORY: Import Prep Session First**

```python
mcp--sequentialthinking--import_session(
    file_path=".kilocode/thinking/task-<task-id>-prep-<YYYY-MM-DD>.json"
)
```

**Implementation Protocol:**

## Step 1: Pre-Edit Reasoning (if non-trivial)

If this change touches >1 file, modifies interfaces, or affects tests:

```python
mcp--sequentialthinking--process_thought(
    thought="About to modify [component]. Risk: [breaking changes]. Mitigation: [strategy].",
    thought_number=1,
    total_thoughts=2,
    next_thought_needed=True,
    stage="Analysis",
    tags=["execution", "risk-assessment", "subtask-<N>"]
)

mcp--sequentialthinking--process_thought(
    thought="Edit strategy: [step-by-step]. Success: [tests pass, no lint errors].",
    thought_number=2,
    total_thoughts=2,
    next_thought_needed=False,
    stage="Conclusion",
    tags=["execution", "edit-plan", "subtask-<N>"]
)
```

## Step 2: Gather Context

- Use `mcp--augment-context-engine--codebase-retrieval` to verify signatures
- Use `read_file` to read target files (batch up to 5)
- Use `mcp--context7--query-docs` for external API verification

## Step 3: Make Changes

- Use `edit_file` or `apply_diff` for targeted edits
- Use `write_to_file` for new files only

## Step 4: Find Impacts

- Use `mcp--augment-context-engine--codebase-retrieval` to find callers
- Use `search_files` to find all references

## Step 5: Update Downstream

- Update call sites
- Update imports/types
- Update related code

## Step 6: Validate

```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
```

## Step 7: Export Progress

```python
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/execution-<task-id>-subtask-<N>-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- `model_plan_present`: YES/NO
- `runtime_model_reported`: <from environment_details>
- `runtime_mode_reported`: <mode slug>
- `model_plan_match`: MATCH|MISMATCH|N/A
- Files modified
- Changes summary
- Validation results (lint/format)
- Exported session path

**Completion:**
Use `attempt_completion` with progress report including:
- Changes made
- Files touched
- Validation status
- Session export path
""",
    todos="""
[ ] Import prep session
[ ] Pre-edit reasoning (if needed)
[ ] Gather context
[ ] Make changes
[ ] Find impacts
[ ] Update downstream
[ ] Validate (lint/format)
[ ] Export progress
"""
)
```

**Wait for subtask completion.** Repeat for each implementation subtask.

### Step 6: Update Progress After Each Subtask

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Pre-Execution Gate: Load and verify prep session
[x] Subtask 1: <implementation-subtask-1>
[-] Subtask 2: <implementation-subtask-2>
[ ] Subtask 3: <implementation-subtask-3>
[ ] Subtask 4: Add/update tests
[ ] Subtask 5: Run quality gates
[ ] Complete: Update beads and present results
"""
)
```

### Step 7: Spawn Test Subtask

```python
new_task(
    mode="code",
    message="""
# Test Subtask

**Objective:** Add or update tests for implemented changes.

**Context from Implementation:**
<paste-implementation-summaries>

**MANDATORY: Import Latest Session**

```python
# Import the most recent execution session
mcp--sequentialthinking--import_session(
    file_path=".kilocode/thinking/execution-<task-id>-subtask-<N>-<YYYY-MM-DD>.json"
)
```

**Test Protocol:**

## Step 1: Identify Test Needs

Based on implementation:
- What new functions/classes need tests?
- What existing tests need updates?
- What edge cases need coverage?

## Step 2: Write Tests

- Follow project test patterns
- Use appropriate test tier (tier0, tier1, tier2)
- Cover happy path + edge cases

## Step 3: Run Tests

```bash
.venv/bin/python -m pytest tests/ -v
```

## Step 4: Export Progress

```python
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/execution-<task-id>-tests-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- `model_plan_present`: YES/NO
- `runtime_model_reported`: <from environment_details>
- `runtime_mode_reported`: <mode slug>
- `model_plan_match`: MATCH|MISMATCH|N/A
- Tests added/modified
- Test coverage summary
- Test results
- Session export path

**Completion:**
Use `attempt_completion` with test report.
""",
    todos="""
[ ] Import latest session
[ ] Identify test needs
[ ] Write tests
[ ] Run tests
[ ] Export progress
"""
)
```

**Wait for subtask completion.**

### Step 8: Update Progress

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Pre-Execution Gate: Load and verify prep session
[x] Subtask 1: <implementation-subtask-1>
[x] Subtask 2: <implementation-subtask-2>
[x] Subtask 3: <implementation-subtask-3>
[x] Subtask 4: Add/update tests
[-] Subtask 5: Run quality gates
[ ] Complete: Update beads and present results
"""
)
```

## Line Health Routing (Fitter) — Line Fault → Restoration → bounded retry (repomap-q4f)

This section defines how Orchestrator routes *workflow-layer* gate failures (timeouts/stalls) to **Fitter**, receives a **Restoration Contract**, and retries the gate **at most 1–2 times**.

### What constitutes a “Line Fault”?

A gate run is a **Line Fault** when it cannot complete deterministically within bounded budgets, including:

- **Timeout**: wall-clock budget exceeded.
- **Stall**: no new output for a bounded period (the gate appears hung).
- **Env missing**: missing dependency/interpreter/env var; secrets required → treat as **RED**.
- **Ambiguous**: cannot classify within bounded evidence.

### Run gates in a bounded way (repo-local runner)

This repo includes a workflow-layer bounded runner:

- [`bounded_gate.py`](../tools/bounded_gate.py)

Example (format check):

```bash
.venv/bin/python .kilocode/tools/bounded_gate.py \
  --gate-id ruff-format \
  --timeout-seconds 60 \
  --stall-seconds 30 \
  --tail-lines 50 \
  -- \
  .venv/bin/python -m ruff format --check .
```

#### Canonical Fit Profile (repomap-core default gates)

Use these as the **starting** budgets for repomap-core's offline quality gates:

| gate_id | invocation | timeout_seconds | stall_seconds | tail_lines |
|---|---|---:|---:|---:|
| `ruff-format` | `.venv/bin/python -m ruff format --check .` | 60 | 30 | 50 |
| `ruff-check` | `.venv/bin/python -m ruff check .` | 90 | 30 | 50 |
| `mypy-src` | `.venv/bin/python -m mypy src` | 120 | 30 | 50 |
| `pytest` | `.venv/bin/python -m pytest -q` | 180 | 30 | 50 |

If the command faults (`timeout`/`stall`/`env_missing`), the runner emits a **Line Fault Contract JSON** to stdout and exits with code `2`.

If the command completes normally, it exits with the underlying command's exit code.

**Required outputs of the bounded runner (conceptual):**

- PASS/FAIL
- If faulted: emit a **Line Fault Contract** (see template below)

Template:
- [`line_fault_contract.md`](../contracts/line_health/line_fault_contract.md)

### Routing behavior: fault → fitter → restoration

When a Line Fault occurs:

1. Create a Line Fault Contract payload (JSON) using the template above.
2. Spawn a **Fitter** subtask with **only**:
   - the contract payload
   - Fit Profile budgets (if known)
   - file pointers (paths) to any logs/artifacts
   - retry count so far

Fitter workflow:
- [`fitter-line-health.md`](./fitter-line-health.md)

Fitter returns a **Restoration Contract**:
- [`restoration_contract.md`](../contracts/line_health/restoration_contract.md)

### Bounded retry policy

- Default: **max 1 retry** after receiving a Restoration Contract.
- Optional: **max 2 retries** only if each retry is justified by a *materially different* mitigation.
- After max retries: STOP and report **YELLOW/RED**; do not loop.

### Context-bloat guardrails

- Orchestrator → Fitter handoff uses **contract payload only** + file pointers.
- `last_output_lines` MUST be a tail (recommended `<= 50`).
- Do not paste full logs into the subtask; keep evidence on disk and reference paths.


### Step 9: Spawn Quality Gate Subtask

```python
new_task(
    mode="code",
    message="""
# Quality Gate Subtask

**Objective:** Run all quality gates and fix any issues.

**CRITICAL:** All gates must pass. No exceptions, no ignores, no workarounds.

**Quality Gates:**

## Gate 1: Format Check

```bash
.venv/bin/python -m ruff format --check .
```

If fails:
```bash
.venv/bin/python -m ruff format .
```

## Gate 2: Lint Check

```bash
.venv/bin/python -m ruff check .
```

**If fails, DO NOT add global ignores.** Use clean fixes:

| Issue | Clean Fix |
|-------|-----------|
| TC003 | Per-file-ignores if runtime import |
| EM102/TRY003 | Extract message to variable |
| Complexity | Extract Method pattern |

## Gate 3: Type Check

```bash
.venv/bin/python -m mypy src
```

**If fails, DO NOT use `# type: ignore`.** Use clean fixes:

| Issue | Clean Fix |
|-------|-----------|
| Missing stubs | Per-module override in pyproject.toml |
| X \| None → X | Ternary + guard pattern |
| Incompatible types | Fix actual mismatch |

## Gate 4: Test Suite

```bash
.venv/bin/python -m pytest -q
```

All tests must pass.

**Output Requirements:**
- `model_plan_present`: YES/NO
- `runtime_model_reported`: <from environment_details>
- `runtime_mode_reported`: <mode slug>
- `model_plan_match`: MATCH|MISMATCH|N/A
- All gate results (PASS/FAIL)
- Any fixes applied
- Final status

**Completion:**
Use `attempt_completion` with quality gate report.
""",
    todos="""
[ ] Run format check
[ ] Run lint check
[ ] Run type check
[ ] Run test suite
[ ] Fix any issues
[ ] Verify all gates pass
"""
)
```

**Wait for subtask completion.** If any gate fails, HALT and fix.

### Step 10: Update Progress

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Pre-Execution Gate: Load and verify prep session
[x] Subtask 1: <implementation-subtask-1>
[x] Subtask 2: <implementation-subtask-2>
[x] Subtask 3: <implementation-subtask-3>
[x] Subtask 4: Add/update tests
[x] Subtask 5: Run quality gates
[-] Complete: Update beads and present results
"""
)
```

### Step 11: Complete and Present Results

Compile final report from all subtask summaries:

```markdown
# Task Execution Complete: <task-id>

## Implementation Summary
- Subtask 1: <summary>
- Subtask 2: <summary>
- Subtask 3: <summary>

## Test Summary
- Tests added: <count>
- Tests modified: <count>
- All tests passing: YES/NO

## Quality Gates
- Format: PASS
- Lint: PASS
- Type check: PASS
- Tests: PASS

## Files Modified
- `<file-1>` - <changes>
- `<file-2>` - <changes>

## Session Exports
- Prep: `.kilocode/thinking/task-<task-id>-prep-<YYYY-MM-DD>.json`
- Subtask 1: `.kilocode/thinking/execution-<task-id>-subtask-1-<YYYY-MM-DD>.json`
- Subtask 2: `.kilocode/thinking/execution-<task-id>-subtask-2-<YYYY-MM-DD>.json`
- Tests: `.kilocode/thinking/execution-<task-id>-tests-<YYYY-MM-DD>.json`

## Success Criteria Met
- [x] <criterion-1>
- [x] <criterion-2>
- [x] <criterion-3>

## Next Steps
1. Review changes
2. Commit with message: "<commit-message>"
3. Update beads: `.kilocode/tools/bd close <task-id>`
4. Push if approved: `git push`
```

### Step 12: Update Todo List

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Pre-Execution Gate: Load and verify prep session
[x] Subtask 1: <implementation-subtask-1>
[x] Subtask 2: <implementation-subtask-2>
[x] Subtask 3: <implementation-subtask-3>
[x] Subtask 4: Add/update tests
[x] Subtask 5: Run quality gates
[x] Complete: Update beads and present results
"""
)
```

### Step 13: Attempt Completion

Use `attempt_completion` to present the final report and wait for user approval to commit/push.

---

## Session Continuity Pattern

Each subtask follows this pattern:

```
1. Import prep session (or previous subtask session)
2. Do work
3. Export progress session
4. Complete with summary
```

This creates a "session chain":
```
prep.json → subtask-1.json → subtask-2.json → tests.json
```

Each link in the chain preserves the reasoning history.

---

## Resuming Interrupted Execution

If execution is interrupted, the parent todo list shows exactly what's done:

```python
# Parent sees:
[x] Pre-Execution Gate
[x] Subtask 1
[x] Subtask 2
[ ] Subtask 3  ← Resume here
[ ] Tests
[ ] Quality gates
```

To resume:
1. Check parent todo list
2. Spawn next pending subtask
3. That subtask imports the last completed session
4. Continue from there

---

## Benefits Over Monolithic `/execute-task`

1. **Isolated implementation**: Each subtask has clean context for its component
2. **Parallel potential**: Independent subtasks could run in parallel (future)
3. **Session chain**: Full reasoning history preserved across subtasks
4. **Progress visibility**: Todo list shows exactly what's done
5. **Resumability**: Interruption doesn't lose context
6. **Modular verification**: Each subtask validates its own work
7. **Safer automation**: Auto-approve subtask spawn/close, manual approve edits

---

## Integration with Beads

After all subtasks complete and quality gates pass:

```bash
# Update issue status
.kilocode/tools/bd update <task-id> --status done

# Close issue
.kilocode/tools/bd close <task-id>

# Sync to remote
.kilocode/tools/bd sync
```

---

## Related Workflows

- [`/orchestrate-start-task`](./orchestrate-start-task.md) — Preparation phase (must complete first)
- [`/execute-task`](./execute-task.md) — Original monolithic version (for reference)
- [`/fix-ci`](./fix-ci.md) — Quality gate fixes

---

## Philosophy

This workflow embodies the "factory line" model:
- **Parent = foreman**: Tracks progress, doesn't implement
- **Subtasks = workers**: Each implements one component
- **Session exports = progress checkpoints**: Context preserved at each step
- **Quality gates = final inspection**: No shipment without passing inspection
