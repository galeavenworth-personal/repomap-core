---
description: Delegation orchestrator for task execution. Spawns code children for each planned subtask sequentially. Process-orchestrator runs this — it coordinates, never implements.
auto_execution_mode: 3
punch_card: process-orchestrate
---

# Task Execution Protocol (Delegation Orchestrator)

This workflow begins where `/start-task` ends — when the prepare-phase child has produced
a subtask plan and exported its sequential thinking session.

**You may NOT execute without proper preparation.**

**Punch Card:** `process-orchestrate` (9 rows, 4 required, 4 forbidden)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

**Core principle:** Parse subtask plan → Spawn code child per subtask → Collect results → Gate exit.

---

## Architecture

**You are a process-orchestrator (Tier 2).** You coordinate, you do not implement.

```
process-orchestrator (this workflow)
├── Pre-execution verification (orchestrator reads prep output)
├── Subtask 1: new_task → code (execute-subtask)
│   └── punch card: execute-subtask
├── Subtask 2: new_task → code (execute-subtask)
│   └── punch card: execute-subtask
├── Subtask N: new_task → code (execute-subtask)
│   └── punch card: execute-subtask
└── punch card: process-orchestrate (requires child_spawn, forbids direct tool use)
```

**Anti-delegation enforcement:** If you call `retrieve codebase`, `edit_file`, `apply_diff`,
or `write_to_file` directly, your punch card checkpoint will FAIL. Delegate to children.

---

## Pre-Execution Gate (MANDATORY)

**YOU MUST VERIFY PREPARATION BEFORE DISPATCHING ANY CHILDREN.**

### Step 1: Locate Preparation Output

The prepare-phase child should have:
1. Exported a session to `.kilocode/thinking/task-{task-id}-prep-{YYYY-MM-DD}.json`
2. Returned a preparation summary with a **subtask plan**

Review the preparation summary (from the `/start-task` workflow output) and extract:
- The chosen approach and rationale
- The success criteria
- The **implementation subtask list** (each subtask becomes a child)
- Risks and mitigations

**If no subtask plan exists:** HALT. Run `/start-task {task-id}` first.

### Step 2: Build Todo List

Create a todo list with one entry per planned subtask:

```
update_todo_list:
  1. [subtask 1 description] — status: pending
  2. [subtask 2 description] — status: pending
  ...
  N. [subtask N description] — status: pending
```

---

## Execution Loop (Sequential Child Dispatch)

**For each subtask in order**, spawn a code child:

### Per-Subtask Dispatch

> 📌 `dispatch code` → [`commands.dispatch_code`](../commands.toml)
> Resolves to: `new_task` with `target_mode=code`
> Contract: [`.kilocode/contracts/composability/handoff_packet.md`](../contracts/composability/handoff_packet.md)

**Handoff packet must include:**
- `task_id`
- `bead_id` (if available, for gate_runs matching)
- `subtask_index`: which subtask this is (1 of N)
- `subtask_description`: what to implement (from prep subtask plan)
- `files`: specific files to modify (from prep subtask plan)
- `success_criteria`: measurable outcomes for this subtask
- `session_export_path`: path to prep-phase thinking session
- `constraints`: what NOT to touch
- `workflow_instruction`: "Follow `/execute-subtask` workflow. Your punch card is `execute-subtask`."

**Child workflow:** [`execute-subtask.md`](./execute-subtask.md)

### After Each Child Returns

1. **Parse child result** — check state (SUCCESS / ERROR / PARTIAL)
2. **Update todo list** — mark subtask complete or failed
3. **If ERROR:**
   - Review child's error output
   - If retryable: re-dispatch with amended handoff (max 1 retry per subtask)
   - If not retryable: HALT and escalate
4. **If SUCCESS:** Proceed to next subtask

### Sequential Discipline

Subtasks run **one at a time, in order**. Do not parallelize.
Each subtask may depend on changes made by previous subtasks.
The child's quality gates verify the codebase is healthy after each subtask.

---

## Execution Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│  PRE-EXECUTION GATE                                              │
│  ├── Verify prep output exists (subtask plan + session export)  │
│  ├── Extract subtask list from preparation summary              │
│  └── Build todo list with one entry per subtask                 │
├─────────────────────────────────────────────────────────────────┤
│  FOR EACH SUBTASK (sequential):                                  │
│  ├── dispatch code              → commands.dispatch_code        │
│  │   └── child runs /execute-subtask with punch card            │
│  ├── Parse child result (SUCCESS / ERROR / PARTIAL)             │
│  ├── Update todo list                                           │
│  └── If ERROR: retry once or escalate                           │
├─────────────────────────────────────────────────────────────────┤
│  VERIFICATION                                                    │
│  ├── All subtasks in todo list marked COMPLETE                  │
│  └── Review overall success criteria from prep phase            │
├─────────────────────────────────────────────────────────────────┤
│  EXIT GATE: PUNCH CARD CHECKPOINT                               │
│  ├── mint punches {task_id}         → commands.punch_mint       │
│  ├── checkpoint punch-card {task_id} process-orchestrate        │
│  │                                  → commands.punch_checkpoint  │
│  └── MUST PASS — checks child_spawn + forbids direct tool use   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Verification Phase

Before marking overall work complete:

### 1. Todo List Review

All subtasks marked COMPLETE via `update_todo_list`.

### 2. Success Criteria Confirmation

Review the success criteria defined during preparation:
- Each criterion explicitly satisfied by child results
- No partial completions
- No deferred items unless user-approved

### 3. Roll Up Runtime Attestations

Collect from each child's result:
- `runtime_model_reported`
- `runtime_mode_reported`
- `files_created` and `files_modified`
- Quality gate results

---

## Critical Rules

### Delegation Is Mandatory
You are a Tier 2 orchestrator. You MUST delegate all implementation to code-mode children
via `new_task`. Direct calls to `retrieve codebase`, `edit_file`, `apply_diff`, or
`write_to_file` will cause your punch card checkpoint to FAIL (forbidden punch violations).

### One Subtask Per Child
Each planned subtask gets its own child session. Do not combine subtasks.
This ensures bounded cost, clean context, and independent punch card enforcement.

### Sequential Execution
Subtasks run in order. Each child's quality gates verify codebase health before the
next child starts.

### Bounded Retry
Max 1 retry per failed subtask. If a subtask fails twice, STOP and escalate.

### Virtual Environment Mandate
**ALWAYS** use `.venv/bin/python -m ...` for Python execution.

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} process-orchestrate` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} process-orchestrate`
> **receipt_required = true** — this is a hard gate.
>
> **Note:** Plant tooling (`.kilocode/tools/`) uses system `python3`, not `.venv/bin/python`. The virtual environment mandate applies to product code (`src/`) and quality gates only.

**Checkpoint verifies (enforced by punch card):**
- ✅ You spawned at least one `code` child (execute delegation happened)
- ❌ You did NOT call `edit_file`, `apply_diff`, `write_to_file`, or `codebase_retrieval` directly

**Operational expectations (not enforced by punch card, but required by this workflow):**
- ✅ You spawned at least one `architect` child (prep delegation — if this is a combined run)
- ✅ You received child completions

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review failures:
- Missing `child_spawn` → you forgot to delegate subtasks
- Forbidden violations → you did specialist work yourself; the children should do this

**If checkpoint PASSES:** Proceed to `attempt_completion` with the execution summary.

---

## Line Fault Handling

If a child's quality gate faults (timeout, stall, env_missing):

> 📌 `dispatch fitter` → [`commands.dispatch_fitter`](../commands.toml)
> Resolves to: `new_task` with `target_mode=fitter`
> Contract: [`.kilocode/contracts/line_health/line_fault_contract.md`](../contracts/line_health/line_fault_contract.md)

Fitter returns a Restoration Contract. After restoration, re-dispatch the failed subtask.
Max 1 retry after Restoration Contract. Escalate after that.

---

## Related Workflows

- [`/start-task`](./start-task.md) — Preparation phase (must complete first)
- [`/execute-subtask`](./execute-subtask.md) — Specialist child: bounded implementation
- [`/discover-phase`](./discover-phase.md) — Specialist child: task discovery
- [`/explore-phase`](./explore-phase.md) — Specialist child: codebase exploration
- [`/prepare-phase`](./prepare-phase.md) — Specialist child: sequential thinking prep
- [`/fitter-line-health`](./fitter-line-health.md) — Specialist child: gate fault recovery
- [`/prep-task`](./prep-task.md) — Detailed task preparation methodology
- [`/fix-ci`](./fix-ci.md) — Quality gate fixes

## Related Skills

- [`beads-local-db-ops`](../skills/beads-local-db-ops/SKILL.md) — Beads CLI operations
- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning
- [`context7-docs-ops`](../skills/context7-docs-ops/SKILL.md) — Library documentation

## Philosophy

This workflow enforces **verified preparation before execution** and **delegation at every
step**. The orchestrator never implements — it dispatches bounded children, collects results,
and gates the exit.

**Structure discipline:** commands.toml routes all the way down — from instruction to
delegation to verification. Punch cards enforce the delegation pattern at both the parent
(must spawn, must not implement) and child (must use required tools, must pass gates) levels.
