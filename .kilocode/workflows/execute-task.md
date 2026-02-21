---
description: Implementation workflow that begins after /start-task preparation is complete. Enforces pre-execution verification and structured execution loop.
auto_execution_mode: 3
punch_card: execute-task
---

# Task Execution Protocol

This workflow begins where `/start-task` ends — when you have completed sequential
thinking, reached Conclusion stage, exported your session, and the `start-task` punch
card checkpoint has passed.

**You may NOT execute without proper preparation.**

**Punch Card:** `execute-task` (10 rows, 9 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

**Core principle:** Verify reasoning → Execute subtask → Verify completion → Repeat.

---

## Pre-Execution Gate (MANDATORY)

**YOU MUST RUN THESE VERIFICATION STEPS FIRST. NO EXCEPTIONS.**

### Step 1: Load Preparation Session

> 📌 `import session` → [`commands.import_session`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--import_session`

File path: `.kilocode/thinking/task-{task-id}-prep-{YYYY-MM-DD}.json`

**If this fails:** The prep session doesn't exist. HALT and run `/start-task {task-id}` first.

### Step 2: Verify Conclusion Stage Reached

> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--generate_summary`

Check the summary output for:
- `currentStage: Conclusion` appears in the output
- Multiple thoughts in Problem Definition and Analysis stages
- At least 2 interpretation branches explored
- At least 2 approach branches explored

**If Conclusion stage not reached:** Preparation is incomplete. HALT and complete
`/start-task` workflow with proper sequential thinking.

### Step 3: Review Preparation Decisions

After verifying the session is valid, review:
- What approach was selected and why?
- What are the success criteria?
- What are the identified risks and mitigations?

---

## Core Execution Loop

For each subtask, follow this protocol:

```
┌─────────────────────────────────────────────────────────────────┐
│  FOR EACH SUBTASK:                                              │
│                                                                 │
│  0. PRE-EDIT REASONING (if non-trivial)                         │
│     ├── decompose task          → commands.decompose_task       │
│     └── Reach Conclusion stage before editing                   │
│                                                                 │
│  1. ACTIVATE                                                    │
│     └── update_todo_list: mark IN_PROGRESS                      │
│                                                                 │
│  2. GATHER CONTEXT                                              │
│     ├── retrieve codebase       → commands.retrieve_codebase    │
│     ├── read_file (batch up to 5)                               │
│     └── query docs (if external APIs) → commands.query_docs     │
│                                                                 │
│  3. EDIT CODE                                                   │
│     └── edit_file / apply_diff / write_to_file                  │
│                                                                 │
│  4. FIND IMPACTS                                                │
│     ├── retrieve codebase       → commands.retrieve_codebase    │
│     └── search_files for all references                         │
│                                                                 │
│  5. UPDATE DOWNSTREAM                                           │
│     ├── edit_file: update call sites                            │
│     ├── edit_file: update tests                                 │
│     └── edit_file: update imports/types                         │
│                                                                 │
│  6. VALIDATE                                                    │
│     └── gate quality            → commands.gate_quality         │
│                                                                 │
│  7. UPDATE DOCUMENTATION (if needed)                            │
│     └── edit_file: update .md files                             │
│                                                                 │
│  8. COMPLETE                                                    │
│     └── update_todo_list: mark COMPLETE                         │
│                                                                 │
│  9. SAVE PROGRESS                                               │
│     └── export session          → commands.export_session       │
│                                                                 │
│  REPEAT for next subtask...                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Step Details

#### 0. Pre-Edit Reasoning (Non-Trivial Changes Only)

**When to use:** Changes that touch >1 file, modify interfaces, or affect tests.

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--process_thought`

```
decompose task: "About to modify [component]. Risk: [breaking N callers]. Mitigation: [verify first]."
  stage=Analysis, tags=[execution, risk-assessment]

decompose task: "Edit strategy: [step-by-step]. Success criteria: [tests pass, no lint errors]."
  stage=Conclusion, tags=[execution, edit-plan]
```

**Skip this for:** Trivial changes (typo fixes, adding comments, single-file renames).

#### 2. Gather Context

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Query for exact signatures, usage patterns, and caller relationships before editing.

For external library APIs:

> 📌 `resolve library` → [`commands.resolve_library`](../commands.toml)
> 📌 `query docs` → [`commands.query_docs`](../commands.toml)

#### 6. Validate

> 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
> Composite: `format_ruff` → `check_ruff` → `check_mypy` → `test_pytest`
> All run through `bounded_gate.py` with receipt tracking.

Each gate produces a `gate_pass` or `gate_fail` punch. All 4 must pass.

#### 9. Save Progress

> 📌 `export session` → [`commands.export_session`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--export_session`

File path: `.kilocode/thinking/execution-{task-name}-{YYYY-MM-DD}.json`

If execution is interrupted, resume with `import session` → `summarize thinking`.

---

## Verification Phase

Before marking overall work complete:

### 1. Quality Gates

> 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
> All 4 gates must pass with receipts.

### 2. Todo List Review

All subtasks marked COMPLETE via `update_todo_list`.

### 3. Success Criteria Confirmation

Review the success criteria defined during planning:
- Each criterion explicitly satisfied
- No partial completions
- No deferred items unless user-approved

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} execute-task` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} execute-task`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the completed work.

---

## Session Continuity

### If Resuming Execution Work

> 📌 `import session` → [`commands.import_session`](../commands.toml)
> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)

Then continue with:

```
decompose task: "Resuming execution: [N] of [M] subtasks complete. Next: [description]"
  stage=Problem Definition, tags=[execution-resume]
```

---

## Related Workflows

- [`/start-task`](./start-task.md) — Preparation phase (must complete first)
- [`/prep-task`](./prep-task.md) — Detailed task preparation methodology
- [`/respond-to-pr-review`](./respond-to-pr-review.md) — PR review response workflow
- [`/fix-ci`](./fix-ci.md) — Quality gate fixes

## Related Skills

- [`beads-local-db-ops`](../skills/beads-local-db-ops/SKILL.md) — Beads CLI operations
- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning
- [`context7-docs-ops`](../skills/context7-docs-ops/SKILL.md) — Library documentation

## Philosophy

This workflow enforces **verified preparation before execution** and **self-verified
completion before exit**. No code changes without proper reasoning. No execution without
verified prep session. No exit without punch card checkpoint PASS.

**Structure discipline:** commands.toml routes all the way down — from instruction to
invocation to verification.
