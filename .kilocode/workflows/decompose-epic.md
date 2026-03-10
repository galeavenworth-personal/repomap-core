---
description: Epic decomposition workflow. Spawned by plant-manager to break an epic into implementable child beads. Output is minted beads in the dependency graph, not markdown plans. Uses the start-task pattern (discover, explore, prepare) but scoped to epic-level understanding.
auto_execution_mode: 3
punch_card: decompose-epic
---

# Decompose Epic

You are a **plant-manager** dispatched to decompose an epic into implementable child beads.
Your job is bounded: understand the epic, explore the codebase, and mint child beads that
the factory can execute one at a time as a sequential line.

**Punch Card:** `decompose-epic`
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

**You are a Tier 1 orchestrator for this workflow.** You do the thinking yourself
(no child spawning needed for decomposition). You read beads, explore code, reason
through sequential thinking, and mint beads as the output artifact.

---

## Inputs

- `epic_id` — the bead identifier for the epic to decompose
- The epic's description, acceptance criteria, and dependency context come from `bd show`

---

## Phase 1: Understand the Epic

### Step 1.1: Read the Epic and Its Context

```bash
.kilocode/tools/bd show {epic_id}
```

Read the full epic description, acceptance criteria, labels, dependencies, and any
existing children. If the epic has a parent, read that too.

### Step 1.2: Read Related Architecture Docs

If the epic references specs, architecture docs, or related beads:
- Read each referenced document
- Read each related bead with `bd show`
- Build a mental model of what this epic needs to deliver

### Step 1.3: Problem Definition (Sequential Thinking)

> `decompose task` → [`commands.decompose_task`](../commands.toml)

Create at least 2 interpretation branches of the epic's scope:

```
decompose task: "Interpretation A: The epic requires [specific deliverables]"
  stage=Problem Definition, tags=[epic-decomposition, scope]

decompose task: "Interpretation B: The epic could also mean [alternative scope]"
  stage=Problem Definition, tags=[epic-decomposition, scope]
  assumptions_challenged=[assumption from A]
```

Resolve to a single interpretation grounded in the epic's acceptance criteria.

---

## Phase 2: Explore the Codebase

### Step 2.1: Identify Implementation Surface

> `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)

Search for:
- Existing code the epic builds on or extends
- Patterns and conventions the implementation must follow
- Test infrastructure the new code must integrate with
- Files that will be created or modified

### Step 2.2: Map Dependencies and Ordering

> `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Implementation surface: [files/modules involved]. 
  Natural ordering: [what must come first, what depends on what].
  Existing patterns: [conventions to follow]."
  stage=Research, tags=[epic-decomposition, codebase-map]
```

### Step 2.3: Identify Risks and Constraints

```
decompose task: "Risks: [what could go wrong]. Constraints: [what's non-negotiable].
  Testing strategy: [how each subtask gets verified]."
  stage=Research, tags=[epic-decomposition, risks]
```

---

## Phase 3: Design the Subtask Graph

### Step 3.1: Generate Candidate Decompositions

> `decompose task` → [`commands.decompose_task`](../commands.toml)

Generate at least 2 decomposition strategies:

```
decompose task: "Decomposition A (layer-by-layer): [list subtasks bottom-up].
  Pros: [each layer testable independently]. Cons: [no end-to-end until late]."
  stage=Analysis, tags=[decomposition-candidate]

decompose task: "Decomposition B (slice-by-slice): [list subtasks as vertical slices].
  Pros: [working end-to-end early]. Cons: [may need refactoring later]."
  stage=Analysis, tags=[decomposition-candidate]
```

### Step 3.2: Choose and Refine

```
decompose task: "Chosen decomposition: [A or B]. Rationale: [why].
  Final subtask list with ordering and dependencies."
  stage=Synthesis, tags=[decomposition-decision]
```

**Each subtask must be:**
- **Bounded** — completable in a single agent session (< 200 steps)
- **Testable** — has concrete verification criteria
- **Committable** — produces a single meaningful commit
- **Ordered** — clear which subtasks depend on which

### Step 3.3: Define Each Subtask Precisely

For each subtask, define:
1. **Title** — concise, action-oriented
2. **Type** — task, feature, or chore
3. **Priority** — P1 for critical path, P2 for important, P3 for optional
4. **Description** — what to implement, which files to touch, acceptance criteria
5. **Dependencies** — which sibling subtasks must complete first (if any)

---

## Phase 4: Mint the Beads

**This is the critical output phase.** The subtask plan becomes real beads in the graph.

### Step 4.1: Create Child Beads

For each subtask in order:

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

If subtask B depends on subtask A completing first:

```bash
.kilocode/tools/bd dep add {child_B_id} {child_A_id}
```

**Only add dependencies where they're structurally necessary.** Don't over-constrain —
the factory executes beads sequentially within a line anyway. Dependencies matter for
correctness (e.g., "the test harness must exist before the tests"), not just ordering.

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

## Phase 5: Export Session and Complete

### Step 5.1: Export Thinking Session

> `export session` → [`commands.export_session`](../commands.toml)

File path: `.kilocode/thinking/epic-{epic_id}-decomposition-{YYYY-MM-DD}.json`

### Step 5.2: Structured Output

Return with this structure:

```markdown
## Epic Decomposition: {epic_id}

### Epic
- Title: [epic title]
- Acceptance Criteria: [from epic description]

### Decomposition Strategy
- Approach: [chosen strategy]
- Rationale: [why this ordering]

### Minted Beads (in execution order)
1. **{child_id}** — {title} [P{n}]
   - Files: [target files]
   - Verification: [how to confirm it's done]
2. **{child_id}** — {title} [P{n}]
   - Files: [target files]  
   - Verification: [how to confirm it's done]
[...]

### Dependencies Between Subtasks
- {child_B} depends on {child_A} because [reason]

### Risks and Mitigations
- Risk: [description] -> Mitigation: [approach]

### Evidence
- runtime_model_reported: [model]
- beads_created: [count]
- epic_children_total: [count]
```

---

## EXIT GATE: Punch Card Checkpoint

**Before completing, you MUST run the punch card checkpoint.**

> `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> `checkpoint punch-card {task_id} decompose-epic` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} decompose-epic`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Review missing punches, complete them, re-mint, re-checkpoint.
**If checkpoint PASSES:** Proceed to completion.

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

## Critical Rules

### Bead Quality
- Each bead must be **self-contained enough** that an agent can execute it without
  reading the decomposition session. The bead description IS the spec.
- Include file paths, acceptance criteria, and verification commands in descriptions.
- Don't create more than 10 subtasks — if you need more, the epic needs sub-epics.

### Scope Discipline
- Stay within the epic's acceptance criteria. Don't add aspirational work.
- If you discover work that doesn't fit the epic, create a separate bead (not a child).
- Optional/nice-to-have items get P3 and a note in the description.

### Ordering Heuristic
- Architecture/contracts/types first (foundations)
- Core implementation second (the meat)
- Tests third (verification)
- Integration/wiring last (connecting to the rest of the system)
- Docs alongside or after (never before implementation)

---

## Related Workflows

- [`/start-task`](./start-task.md) — Task-level preparation (discover/explore/prepare)
- [`/execute-task`](./execute-task.md) — Task execution (after decomposition)
- [`/execute-subtask`](./execute-subtask.md) — Single bounded implementation unit
- [`/prepare-phase`](./prepare-phase.md) — Sequential thinking preparation (task-level)
