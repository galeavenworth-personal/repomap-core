---
description: Delegation orchestrator for task preparation. Spawns architect children for discover, explore, and prepare phases. Process-orchestrator runs this — it coordinates, never implements.
auto_execution_mode: 3
punch_card: start-task-orchestrate
---

# Start Task Workflow (Delegation Orchestrator)

A delegation orchestrator that coordinates the preparation phases of software fabrication.
Each phase runs in its own isolated child session via `new_task`, ensuring context isolation,
bounded cost, and punch card enforcement at every phase boundary.

**Punch Card:** `start-task-orchestrate` (8 rows, 3 required, 4 forbidden)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Usage

```
/start-task <task-id>
```

## Architecture

**You are a process-orchestrator (Tier 2).** You coordinate, you do not implement.

```
process-orchestrator (this workflow)
├── Phase 1: new_task → architect (discover-phase)
│   └── punch card: discover-phase
├── Phase 2: new_task → architect (explore-phase)
│   └── punch card: explore-phase
├── Phase 3: new_task → architect (prepare-phase)
│   └── punch card: prepare-phase
└── punch card: start-task-orchestrate (requires architect child_spawn, forbids direct tool use)
```

**Anti-delegation enforcement:** If you call `retrieve codebase`, `edit_file`, `apply_diff`,
or `write_to_file` directly, your punch card checkpoint will FAIL. Delegate to children.

---

## Pre-Flight

1. Beads preflight (fail-fast):

   ```bash
   .kilocode/tools/beads_preflight.sh
   ```

   If `.beads/ not initialized`:

   ```bash
   .kilocode/tools/bd init
   ```

2. Fetch task details (orchestrator reads task metadata — this is coordination, not exploration):

   > 📌 `show issue {task-id}` → [`commands.show_issue`](../commands.toml)
   > Resolves to: `.kilocode/tools/bd show {id}`

3. If the task has a parent epic:

   > 📌 `show issue {parent-id}` → [`commands.show_issue`](../commands.toml)

4. Build the handoff packet for Phase 1 from the task details.

---

## Phase 1: Discover (Delegate to Architect Child)

> 📌 `dispatch architect` → [`commands.dispatch_architect`](../commands.toml)
> Resolves to: `new_task` with `target_mode=architect`
> Contract: [`.kilocode/contracts/composability/handoff_packet.md`](../contracts/composability/handoff_packet.md)

**Handoff packet must include:**
- `task_id`
- `objective`: "Perform task discovery — understand scope, gather strategic context"
- `evidence`: [bead description, acceptance criteria, epic context]
- `success_criteria`: ["Discovery summary with key components, scope boundaries, dependencies"]
- `workflow_instruction`: "Follow `/discover-phase` workflow. Your punch card is `discover-phase`."

**Child workflow:** [`discover-phase.md`](./discover-phase.md)

**Wait for child completion.** Parse the discovery summary from the child's return.

---

## Phase 2: Explore (Delegate to Architect Child)

> 📌 `dispatch architect` → [`commands.dispatch_architect`](../commands.toml)
> Resolves to: `new_task` with `target_mode=architect`

**Handoff packet must include:**
- `task_id`
- `objective`: "Perform codebase exploration — deep structural and semantic analysis"
- `evidence`: [discovery summary from Phase 1, key components list]
- `success_criteria`: ["Exploration summary with architecture map, test coverage, impact analysis"]
- `workflow_instruction`: "Follow `/explore-phase` workflow. Your punch card is `explore-phase`."

**Child workflow:** [`explore-phase.md`](./explore-phase.md)

**Wait for child completion.** Parse the exploration summary from the child's return.

---

## Phase 3: Prepare (Delegate to Architect Child)

> 📌 `dispatch architect` → [`commands.dispatch_architect`](../commands.toml)
> Resolves to: `new_task` with `target_mode=architect`

**Handoff packet must include:**
- `task_id`
- `objective`: "Prepare implementation plan via sequential thinking"
- `evidence`: [discovery summary, exploration summary]
- `success_criteria`: ["Preparation summary with chosen approach, success criteria, subtask plan, exported session"]
- `workflow_instruction`: "Follow `/prepare-phase` workflow. Your punch card is `prepare-phase`."

**Child workflow:** [`prepare-phase.md`](./prepare-phase.md)

**Wait for child completion.** Parse the preparation summary from the child's return.
The preparation summary contains the **subtask plan** needed by `/execute-task`.

---

## Execution Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│  PRE-FLIGHT (orchestrator reads task metadata)                   │
│  ├── show issue {task-id}           → commands.show_issue       │
│  ├── show issue {parent-id}         → commands.show_issue       │
│  └── Build handoff packet from task details                     │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 1: DISCOVER (delegate)                                    │
│  ├── dispatch architect             → commands.dispatch_architect│
│  │   └── child runs /discover-phase with punch card             │
│  └── Parse discovery summary from child return                  │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 2: EXPLORE (delegate)                                     │
│  ├── dispatch architect             → commands.dispatch_architect│
│  │   └── child runs /explore-phase with punch card              │
│  └── Parse exploration summary from child return                │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 3: PREPARE (delegate)                                     │
│  ├── dispatch architect             → commands.dispatch_architect│
│  │   └── child runs /prepare-phase with punch card              │
│  └── Parse preparation summary with subtask plan                │
├─────────────────────────────────────────────────────────────────┤
│  EXIT GATE: PUNCH CARD CHECKPOINT                               │
│  ├── mint punches {task_id}         → commands.punch_mint       │
│  ├── checkpoint punch-card {task_id} start-task-orchestrate     │
│  │                                  → commands.punch_checkpoint  │
│  └── MUST PASS — checks child_spawn + forbids direct tool use   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Rules

### Delegation Is Mandatory
You are a Tier 2 orchestrator. You MUST delegate specialist work to children via `new_task`.
Direct calls to `retrieve codebase`, `edit_file`, `apply_diff`, or `write_to_file` will
cause your punch card checkpoint to FAIL (forbidden punch violations).

### Virtual Environment Mandate
**ALWAYS** use `.venv/bin/python -m ...` for Python execution.

### Beads Sync-Branch Model

> 📌 `sync remote` → [`commands.sync_remote`](../commands.toml)
> Resolves to: `.kilocode/tools/bd sync --no-push`

Run at session start if not already synced.

### Layered Architecture
Respect layer boundaries defined in [`repomap.toml`](../../repomap.toml).

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} start-task-orchestrate` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} start-task-orchestrate`
> **receipt_required = true** — this is a hard gate.
>
> **task_id fallback:** Orchestrators should inject an explicit session/task UUID. If unavailable, pass `auto` so punch-engine discovery falls back to VS Code task-directory discovery.
>
> **Note:** Plant tooling (`.kilocode/tools/`) uses system `python3`, not `.venv/bin/python`. The virtual environment mandate applies to product code (`src/`) and quality gates only.

**Checkpoint verifies:**
- ✅ You spawned at least one `architect` child (delegation happened)
- ✅ You received child completions
- ❌ You did NOT call `edit_file`, `apply_diff`, `write_to_file`, or `codebase_retrieval` directly

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review failures:
- Missing `child_spawn` → you forgot to delegate a phase
- Forbidden violations → you did specialist work yourself; re-run with proper delegation

**If checkpoint PASSES:** Proceed to `attempt_completion` with the prepared task.

---

## STOP HERE (prep-only invocation)

**If invoked as `/start-task` (prep only), STOP after Phase 3.**

✋ **DO NOT PROCEED TO IMPLEMENTATION.**

Present the prepared task with:
- Discovery summary (from Phase 1 child)
- Exploration summary (from Phase 2 child)
- Preparation summary with subtask plan (from Phase 3 child)
- Punch card checkpoint result (PASS)

**To execute the task, the user must explicitly approve or run:**
```
/execute-task <task-id>
```

---

## Related Workflows

- [`/execute-task`](./execute-task.md) — Implementation phase (after approval)
- [`/discover-phase`](./discover-phase.md) — Specialist child: task discovery
- [`/explore-phase`](./explore-phase.md) — Specialist child: codebase exploration
- [`/prepare-phase`](./prepare-phase.md) — Specialist child: sequential thinking prep
- [`/execute-subtask`](./execute-subtask.md) — Specialist child: bounded implementation
- [`/codebase-exploration`](./codebase-exploration.md) — Deep dive into code structure
- [`/prep-task`](./prep-task.md) — Detailed task preparation methodology

## Related Skills

- [`beads-local-db-ops`](../skills/beads-local-db-ops/SKILL.md) — Beads CLI operations
- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning
- [`context7-docs-ops`](../skills/context7-docs-ops/SKILL.md) — Library documentation

## Philosophy: Software Fabrication

- **Determinism** — Same task → same preparation → same execution
- **Delegation** — Orchestrators coordinate, specialists implement
- **Evidence-based** — Decisions backed by codebase analysis, enforced by punch cards
- **Structure discipline** — commands.toml routes all the way down
- **Self-verifying** — Punch card checkpoint gates every phase boundary and the exit
