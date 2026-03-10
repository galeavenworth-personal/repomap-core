---
description: Delegation orchestrator for epic decomposition. Spawns architect children for discover, explore, and prepare phases scoped to an epic. Parent mints child beads from the preparation output. Follows the start-task delegation pattern.
auto_execution_mode: 3
punch_card: decompose-epic
---

# Decompose Epic (Delegation Orchestrator)

A delegation orchestrator that decomposes an epic into implementable child beads.
Each phase runs in its own isolated child session via `new_task`, ensuring context isolation,
bounded cost, and punch card enforcement at every phase boundary.

The parent's unique responsibility: **mint the beads** from the prepare phase output.
Children discover, explore, and plan. The parent acts on the plan.

**Punch Card:** `decompose-epic` (8 rows, 3 required, 4 forbidden)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Usage

```
/decompose-epic <epic-id>
```

## Architecture

**You are a plant-manager (Tier 1).** You coordinate, you do not explore or plan directly.

```
plant-manager (this workflow)
├── Phase 1: new_task → architect (discover-phase)
│   └── Objective: understand epic scope, read beads, gather strategic context
│   └── punch card: discover-phase
├── Phase 2: new_task → architect (explore-phase)
│   └── Objective: explore codebase, map implementation surface
│   └── punch card: explore-phase
├── Phase 3: new_task → architect (prepare-phase)
│   └── Objective: design subtask graph via sequential thinking
│   └── punch card: prepare-phase
├── Phase 4: PARENT MINTS BEADS (bd create --parent {epic_id})
└── punch card: decompose-epic (requires child_spawn, forbids direct tool use)
```

**Anti-delegation enforcement:** If you call `edit_file`, `apply_diff`, `write_to_file`,
or `codebase_retrieval` directly, your punch card checkpoint will FAIL.
Delegate specialist work to children.

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

2. Fetch epic details (orchestrator reads task metadata — this is coordination, not exploration):

   > `show issue {epic-id}` → [`commands.show_issue`](../commands.toml)
   > Resolves to: `.kilocode/tools/bd show {id}`

3. If the epic has a parent or dependencies, read those too:

   > `show issue {parent-id}` → [`commands.show_issue`](../commands.toml)

4. Build the handoff packet for Phase 1 from the epic details.

---

## Phase 1: Discover (Delegate to Architect Child)

> `dispatch architect` → [`commands.dispatch_architect`](../commands.toml)
> Resolves to: `new_task` with `target_mode=architect`
> Contract: [`.kilocode/contracts/composability/handoff_packet.md`](../contracts/composability/handoff_packet.md)

**Handoff packet must include:**
- `task_id` (use the epic_id)
- `objective`: "Perform epic discovery — understand the full scope of epic {epic_id}, its acceptance criteria, existing children, dependency context, and related architecture documents"
- `evidence`: [epic description, acceptance criteria, existing children list, dependency chain, related docs]
- `success_criteria`: ["Discovery summary with: epic scope interpretation, existing children assessment, dependency context, key architecture references, open questions"]
- `workflow_instruction`: "Follow `/discover-phase` workflow. Your punch card is `discover-phase`."

**Additional context to include in the handoff:**
- List existing children and their status
- Reference any architecture docs mentioned in the epic
- Note which dependencies are already satisfied

**Child workflow:** [`discover-phase.md`](./discover-phase.md)

**Wait for child completion.** Parse the discovery summary from the child's return.

---

## Phase 2: Explore (Delegate to Architect Child)

> `dispatch architect` → [`commands.dispatch_architect`](../commands.toml)
> Resolves to: `new_task` with `target_mode=architect`

**Handoff packet must include:**
- `task_id` (use the epic_id)
- `objective`: "Perform codebase exploration for epic {epic_id} — deep structural and semantic analysis of the implementation surface the epic requires"
- `evidence`: [discovery summary from Phase 1, key components identified, existing infrastructure to build on]
- `success_criteria`: ["Exploration summary with: architecture map of relevant code, existing patterns and conventions, test infrastructure, files that will be created or modified, risk assessment"]
- `workflow_instruction`: "Follow `/explore-phase` workflow. Your punch card is `explore-phase`."

**Child workflow:** [`explore-phase.md`](./explore-phase.md)

**Wait for child completion.** Parse the exploration summary from the child's return.

---

## Phase 3: Prepare (Delegate to Architect Child)

> `dispatch architect` → [`commands.dispatch_architect`](../commands.toml)
> Resolves to: `new_task` with `target_mode=architect`

**Handoff packet must include:**
- `task_id` (use the epic_id)
- `objective`: "Design the subtask decomposition for epic {epic_id} via sequential thinking. Output a precise subtask list that the parent will mint as child beads."
- `evidence`: [discovery summary, exploration summary, epic acceptance criteria]
- `success_criteria`: ["Preparation summary with: chosen decomposition strategy, ordered subtask list where each subtask has title/type/priority/description/files/verification, sibling dependency map, risk mitigations"]
- `workflow_instruction`: "Follow `/prepare-phase` workflow. Your punch card is `prepare-phase`."

**Critical instruction for prepare child:**

> Your subtask plan will be used by the parent to mint beads with `bd create`.
> Each subtask MUST include:
> 1. **Title** — concise, action-oriented
> 2. **Type** — task, feature, or chore
> 3. **Priority** — P1 for critical path, P2 for important, P3 for optional
> 4. **Description** — what to implement, which files to touch, acceptance criteria, verification commands
> 5. **Dependencies** — which sibling subtasks must complete first (by title reference)
>
> Constraints:
> - Each subtask must be completable in a single agent session (< 200 steps)
> - Each subtask must produce a single meaningful commit
> - No more than 10 subtasks — if you need more, recommend sub-epics
> - Stay within the epic's acceptance criteria — no aspirational additions
>
> Ordering heuristic:
> - Architecture/contracts/types first (foundations)
> - Core implementation second (the meat)
> - Tests third (verification)
> - Integration/wiring last (connecting to the system)
> - Docs alongside or after (never before implementation)

**Child workflow:** [`prepare-phase.md`](./prepare-phase.md)

**Wait for child completion.** Parse the preparation summary with the subtask plan.

---

## Phase 4: Mint the Beads (PARENT ACTION)

**This is the only phase where you act directly.** You take the subtask plan from
the prepare phase child and mint it into the beads graph.

### Step 4.1: Create Child Beads

For each subtask from the prepare phase output, in order:

```bash
.kilocode/tools/bd create \
  --type {type} \
  --priority {priority} \
  --title "{title}" \
  --parent {epic_id} \
  --description "{description}"
```

**Record each created bead ID.** You'll need them for dependency wiring.

### Step 4.2: Wire Sibling Dependencies (if any)

If the prepare phase specified that subtask B depends on subtask A:

```bash
.kilocode/tools/bd dep add {child_B_id} {child_A_id}
```

**Only add dependencies where they're structurally necessary.** Don't over-constrain —
the factory executes beads sequentially within a line anyway. Dependencies matter for
correctness (e.g., "the type definitions must exist before the implementation"), not
just ordering preference.

### Step 4.3: Verify the Graph

```bash
.kilocode/tools/bd show {epic_id}
```

Confirm:
- All children are listed under the epic
- Dependencies form a valid DAG (no cycles)
- Priorities are correct
- The first `bd ready` child is the right starting point

### Step 4.4: Export Beads State

```bash
.kilocode/tools/bd export -o .beads/issues.jsonl
```

---

## Execution Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│  PRE-FLIGHT (orchestrator reads epic metadata)                  │
│  ├── show issue {epic-id}          → commands.show_issue        │
│  ├── show issue {parent-id}        → commands.show_issue        │
│  └── Build handoff packet from epic details                     │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 1: DISCOVER (delegate)                                   │
│  ├── dispatch architect            → commands.dispatch_architect │
│  │   └── child runs /discover-phase with punch card             │
│  └── Parse discovery summary from child return                  │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 2: EXPLORE (delegate)                                    │
│  ├── dispatch architect            → commands.dispatch_architect │
│  │   └── child runs /explore-phase with punch card              │
│  └── Parse exploration summary from child return                │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 3: PREPARE (delegate)                                    │
│  ├── dispatch architect            → commands.dispatch_architect │
│  │   └── child runs /prepare-phase with punch card              │
│  └── Parse preparation summary with subtask plan                │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 4: MINT BEADS (parent acts)                              │
│  ├── bd create --parent {epic_id}  (for each subtask)           │
│  ├── bd dep add (wire sibling dependencies)                     │
│  ├── bd show {epic_id}             (verify graph)               │
│  └── bd export -o .beads/issues.jsonl                           │
├─────────────────────────────────────────────────────────────────┤
│  EXIT GATE: PUNCH CARD CHECKPOINT                               │
│  ├── mint punches {task_id}        → commands.punch_mint        │
│  ├── checkpoint punch-card {task_id} decompose-epic             │
│  │                                 → commands.punch_checkpoint   │
│  └── MUST PASS — checks child_spawn + forbids direct tool use   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Rules

### Delegation Is Mandatory
You are a Tier 1 orchestrator. You MUST delegate discovery, exploration, and planning
to children via `new_task`. Direct calls to `codebase_retrieval`, `edit_file`,
`apply_diff`, or `write_to_file` will cause your punch card checkpoint to FAIL.

The ONLY direct actions you take are:
- Reading beads (`bd show`, `bd ready`) for coordination
- Minting beads (`bd create`, `bd dep add`) from the prepare phase output
- Exporting beads state (`bd export`)

### Bead Quality
- Each bead must be **self-contained enough** that an agent can execute it without
  reading the decomposition session. The bead description IS the spec.
- Include file paths, acceptance criteria, and verification commands in descriptions.
- Don't create more than 10 subtasks — if you need more, the epic needs sub-epics.

### Scope Discipline
- Stay within the epic's acceptance criteria. Don't add aspirational work.
- If a child discovers work that doesn't fit the epic, note it but don't mint it.
- Optional/nice-to-have items get P3 and a note in the description.

### Virtual Environment Mandate
**ALWAYS** use `.venv/bin/python -m ...` for Python execution.

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> `checkpoint punch-card {task_id} decompose-epic` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} decompose-epic`
> **receipt_required = true** — this is a hard gate.

**Checkpoint verifies:**
- ✅ You spawned at least one `architect` child (delegation happened)
- ✅ You received child completions
- ✅ You created beads (`bd create`)
- ❌ You did NOT call `edit_file`, `apply_diff`, `write_to_file`, or `codebase_retrieval` directly

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review failures:
- Missing `child_spawn` → you forgot to delegate a phase
- Forbidden violations → you did specialist work yourself; re-run with proper delegation

**If checkpoint PASSES:** Proceed to `attempt_completion` with the decomposition summary.

---

## What Happens After Decomposition

After this workflow completes, the plant-manager transitions to **execution mode**:

1. Run `bd ready` to find the first eligible child bead
2. Claim it with `bd update {id} --status in_progress`
3. Execute it following `/execute-subtask` or `/execute-task` workflow
4. Commit the work: one commit per bead, message references the bead ID
5. Close the bead: `bd close {id}`
6. Repeat until all children are closed
7. Close the epic: `bd close {epic_id}`

**All work happens on a branch named after the epic** (e.g., `repomap-core-0mp`).
One commit per bead. The branch becomes the PR when the epic is complete.

---

## Related Workflows

- [`/start-task`](./start-task.md) — Task-level preparation (same delegation pattern)
- [`/discover-phase`](./discover-phase.md) — Specialist child: task/epic discovery
- [`/explore-phase`](./explore-phase.md) — Specialist child: codebase exploration
- [`/prepare-phase`](./prepare-phase.md) — Specialist child: sequential thinking prep
- [`/execute-task`](./execute-task.md) — Implementation phase (after decomposition)
- [`/execute-subtask`](./execute-subtask.md) — Single bounded implementation unit
