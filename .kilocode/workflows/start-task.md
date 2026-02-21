---
description: Meta-workflow for software fabrication task initiation. Orchestrates beads task discovery, codebase exploration, and task preparation in a single invocation.
auto_execution_mode: 3
punch_card: start-task
---

# Start Task Workflow

A meta-workflow that orchestrates the initial phases of software fabrication task execution.
This workflow consolidates task discovery, context gathering, and preparation into a single,
streamlined invocation.

**Punch Card:** `start-task` (7 rows, 6 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Usage

```
/start-task <task-id>
```

## What This Workflow Does

Three sequential phases, each driven by commands.toml routes:

1. **Task Discovery** — Fetch task details from beads
2. **Codebase Exploration** — Gather semantic understanding of relevant code
3. **Task Preparation** — Transform the task into actionable work via sequential thinking

**Exit Gate:** `checkpoint punch-card` must PASS before returning to parent.

---

## Phase 1: Task Discovery

**Objective:** Understand what needs to be done and why.

**Steps:**

1. Preflight Beads setup (fail-fast):

   ```bash
   .kilocode/tools/beads_preflight.sh
   ```

   If it reports `.beads/ not initialized`, run once per clone:

   ```bash
   .kilocode/tools/bd init
   ```

2. Fetch task details:

   > 📌 `show issue {task-id}` → [`commands.show_issue`](../commands.toml)
   > Resolves to: `.kilocode/tools/bd show {id}`

3. If the task has a parent epic, fetch that context:

   > 📌 `show issue {parent-id}` → [`commands.show_issue`](../commands.toml)

4. Review task description, acceptance criteria, and any linked context.
   Identify key components, files, or systems mentioned.

**Key Questions:**
- What is the task asking for? (bug fix, feature, refactor, investigation)
- What is the expected outcome?
- Are there dependencies or blockers?
- What is the parent epic's strategic context?

**Output:** Clear understanding of task scope and strategic alignment.

---

## Phase 2: Codebase Exploration

**Objective:** Gather comprehensive context about the code involved in this task.

### Layer 1: Semantic Understanding

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Query for:
- How does the feature/component mentioned in the task work?
- What are the architectural patterns around the task area?
- What are the key files and modules involved?

### Layer 2: Structural Analysis (Kilo Native Tools)

Use `list_files` to understand directory structure, `read_file` to examine key files
(batch up to 5), and `search_files` to find specific patterns.

### Layer 3: Library Documentation (if external deps involved)

> 📌 `resolve library` → [`commands.resolve_library`](../commands.toml)
> 📌 `query docs` → [`commands.query_docs`](../commands.toml)

**Output:** Comprehensive understanding of code structure, patterns, and constraints.

---

## Phase 3: Task Preparation

**Objective:** Transform the task into actionable, well-scoped work using sequential thinking.

**MANDATORY: All reasoning must go through sequential thinking commands.**

### Step 1: Problem Definition (≥2 thoughts)

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--process_thought`

Minimum 2 interpretation branches required:

```
decompose task: "Task interpretation 1: [first way to understand the task]"
  stage=Problem Definition, tags=[prep, interpretation]

decompose task: "Task interpretation 2: [alternative understanding]"
  stage=Problem Definition, tags=[prep, interpretation]
```

### Step 2: Analysis (≥2 thoughts)

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

Minimum 2 approach branches required:

```
decompose task: "Approach A: [strategy]. Pros: [...]. Cons: [...]"
  stage=Analysis, tags=[prep, approach]

decompose task: "Approach B: [alternative]. Pros: [...]. Cons: [...]"
  stage=Analysis, tags=[prep, approach]
```

### Step 3: Verify Exploration Completeness

> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--generate_summary`

Verify output shows:
- Multiple Problem Definition thoughts (interpretations)
- Multiple Analysis thoughts (approaches)
- Clear reasoning for each branch

### Step 4: Synthesis & Conclusion

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Choosing [approach] because [rationale]. Implementation plan: [steps]."
  stage=Synthesis, tags=[prep, decision]

decompose task: "Success criteria: [outcomes]. Risks: [issues]. Mitigation: [how]."
  stage=Conclusion, tags=[prep, success-criteria]
```

**CRITICAL: You MUST reach Conclusion stage before proceeding.**

### 8-Step Methodology (Apply During Sequential Thinking)

While using sequential thinking above, ensure you address:

1. **Clarify ambiguous language** — Replace vague terms with specific file/function references
2. **Add missing context** — Include architecture patterns from Phase 2
3. **Specify success criteria** — Define measurable outcomes
4. **Break down complexity** — Decompose into subtasks with dependencies
5. **Correct technical errors** — Verify API signatures and file paths
6. **Align with conventions** — Follow [`repomap.toml`](../../repomap.toml) layer rules
7. **Remove scope creep** — Eliminate implied work not explicitly requested
8. **Preserve code samples** — Keep user-provided code blocks unchanged

**Output:** Actionable task with clear subtasks, success criteria, and implementation plan.

---

## Execution Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: TASK DISCOVERY                                        │
│  ├── show issue {task-id}           → commands.show_issue       │
│  ├── show issue {parent-id}         → commands.show_issue       │
│  └── Review task description and acceptance criteria            │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 2: CODEBASE EXPLORATION                                  │
│  ├── retrieve codebase              → commands.retrieve_codebase│
│  ├── list_files + read_file (structural analysis)               │
│  └── resolve library / query docs   → commands.resolve_library  │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 3: TASK PREPARATION                                      │
│  ├── decompose task (≥2 interpretations) → commands.decompose_task
│  ├── decompose task (≥2 approaches)      → commands.decompose_task
│  ├── summarize thinking                  → commands.summarize_thinking
│  ├── decompose task (synthesis+conclusion)→ commands.decompose_task
│  └── export session                      → commands.export_session│
├─────────────────────────────────────────────────────────────────┤
│  EXIT GATE: PUNCH CARD CHECKPOINT                               │
│  ├── mint punches {task_id}         → commands.punch_mint       │
│  ├── checkpoint punch-card {task_id} start-task                 │
│  │                                  → commands.punch_checkpoint  │
│  └── MUST PASS — blocks attempt_completion on failure           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Rules

### Virtual Environment Mandate
**ALWAYS** use `.venv/bin/python -m ...` for Python execution.

### Beads Sync-Branch Model

> 📌 `sync remote` → [`commands.sync_remote`](../commands.toml)
> Resolves to: `.kilocode/tools/bd sync --no-push`

Run at session start if not already synced.

### Quality Gates (Non-Negotiable)

> 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
> Composite: `format_ruff` → `check_ruff` → `check_mypy` → `test_pytest`
> All run through `bounded_gate.py` with receipt tracking.

### Layered Architecture
Respect layer boundaries defined in [`repomap.toml`](../../repomap.toml).

---

## MANDATORY: Export Session

After completing Phase 3:

> 📌 `export session` → [`commands.export_session`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--export_session`

File path: `.kilocode/thinking/task-{task-id}-prep-{YYYY-MM-DD}.json`

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} start-task` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} start-task`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the prepared task.

---

## STOP HERE

**This workflow STOPS after preparation is complete and the punch card checkpoint passes.**

✋ **DO NOT PROCEED TO IMPLEMENTATION.**

Present the prepared task with:
- Summary of task understanding
- Key files and components identified
- Proposed subtasks and success criteria
- Punch card checkpoint result (PASS)

**To execute the task, the user must explicitly approve or run:**
```
/execute-task <task-id>
```

---

## Related Workflows

- [`/execute-task`](./execute-task.md) — Implementation phase (after approval)
- [`/codebase-exploration`](./codebase-exploration.md) — Deep dive into code structure
- [`/prep-task`](./prep-task.md) — Detailed task preparation methodology

## Related Skills

- [`beads-local-db-ops`](../skills/beads-local-db-ops/SKILL.md) — Beads CLI operations
- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning
- [`context7-docs-ops`](../skills/context7-docs-ops/SKILL.md) — Library documentation

## Philosophy: Software Fabrication

- **Determinism** — Same task → same preparation → same execution
- **Evidence-based** — Decisions backed by codebase analysis
- **Structure discipline** — commands.toml routes all the way down
- **Self-verifying** — Punch card checkpoint gates the exit
