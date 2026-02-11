---
description: Meta-workflow for software fabrication task initiation. Orchestrates beads task discovery, codebase exploration, and task preparation in a single invocation.
auto_execution_mode: 3
---

# Start Task Workflow

A meta-workflow that orchestrates the initial phases of software fabrication task execution. This workflow consolidates task discovery, context gathering, and preparation into a single, streamlined invocation.

## Usage

```
/start-task <task-id>
```

Example:
```
/start-task repomap-609.3
```

## What This Workflow Does

This workflow executes three sequential phases:

1. **Task Discovery** — Fetch task details from beads, including parent epic context
2. **Codebase Exploration** — Gather semantic and structural understanding of relevant code
3. **Task Preparation** — Transform the task into actionable, well-scoped work

## Phase 1: Task Discovery (Beads)

**Objective:** Understand what needs to be done and why.

**Actions:**
- Preflight Beads setup (fail-fast):

  ```bash
  .kilocode/tools/beads_preflight.sh
  ```

  If it reports `.beads/ not initialized`, run once per clone:

  ```bash
  .kilocode/tools/bd init
  ```

- Fetch task details using `.kilocode/tools/bd show <task-id>`
- If the task has a parent epic, fetch that as well using `.kilocode/tools/bd show <parent-id>`
- Review task description, acceptance criteria, and any linked context
- Identify key components, files, or systems mentioned in the task

**Skill Trigger:** The task ID reference should automatically trigger the [`beads-local-db-ops`](../skills/beads-local-db-ops/SKILL.md) skill.

**Key Questions:**
- What is the task asking for? (bug fix, feature, refactor, investigation)
- What is the expected outcome?
- Are there dependencies or blockers mentioned?
- What is the parent epic's strategic context?

**Output:** Clear understanding of task scope and strategic alignment.

---

## Phase 2: Codebase Exploration

**Objective:** Gather comprehensive context about the code involved in this task.

**Invoke:** `/codebase-exploration` workflow

This workflow uses a multi-tool strategy to build layered understanding:

### Layer 1: Semantic Understanding (Augment)
Use the Augment context engine to gather high-level architectural context:

```
Use codebase-retrieval to understand:
- How does [feature/component mentioned in task] work?
- What are the architectural patterns around [task area]?
- What are the key files and modules involved?
```

**Skill Trigger:** Queries about code architecture and patterns should trigger [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md).

### Layer 2: Structural Analysis (Kilo Native Tools)
- Use `list_files` to understand directory structure (recursive or top-level)
- Use `read_file` to examine key files identified in Layer 1 (batch up to 5 files)
- Use `search_files` to find specific patterns or references (Rust regex)

### Layer 3: Claims/Verification Workflows (Experimental)

Claims pipelines and `repomap claims ...` commands are **experimental / out-of-scope** for repomap-core and are not required for default development or CI parity.

If you explicitly need claims workflows, treat them as extension work and expect additional prerequisites (network/secrets).

**Output:** Comprehensive understanding of code structure, patterns, and constraints.

---

## Phase 3: Task Preparation

**Objective:** Transform the task into actionable, well-scoped work using sequential thinking.

**Invoke:** `/prep-task` workflow

### MANDATORY: Use Sequential Thinking

**You MUST use the sequential thinking MCP tools for Phase 3. This is not optional.**

#### Step 1: Problem Definition (2-3 thoughts)
```python
mcp--sequentialthinking--process_thought(
    thought="Task interpretation 1: [first way to understand the task]",
    thought_number=1,
    total_thoughts=6,  # adjust as needed
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["prep", "interpretation"]
)

mcp--sequentialthinking--process_thought(
    thought="Task interpretation 2: [alternative understanding]",
    thought_number=2,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["prep", "interpretation"]
)
```

**Branch Budget: Minimum 2 interpretations required.**

#### Step 2: Analysis (2-3 thoughts)
```python
mcp--sequentialthinking--process_thought(
    thought="Approach A: [first implementation strategy]. Pros: [...]. Cons: [...]",
    thought_number=3,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Analysis",
    tags=["prep", "approach"]
)

mcp--sequentialthinking--process_thought(
    thought="Approach B: [alternative strategy]. Pros: [...]. Cons: [...]",
    thought_number=4,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Analysis",
    tags=["prep", "approach"]
)
```

**Branch Budget: Minimum 2 approaches required.**

#### Step 3: Verify Exploration Completeness
```python
mcp--sequentialthinking--generate_summary()
# Review output - ensure you have:
# - Multiple Problem Definition thoughts (interpretations)
# - Multiple Analysis thoughts (approaches)
# - Clear reasoning for each branch
```

#### Step 4: Synthesis & Conclusion
```python
mcp--sequentialthinking--process_thought(
    thought="Choosing [selected approach] because [rationale]. Implementation plan: [step-by-step].",
    thought_number=5,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Synthesis",
    tags=["prep", "decision"]
)

mcp--sequentialthinking--process_thought(
    thought="Success criteria: [measurable outcomes]. Risks: [potential issues]. Mitigation: [how to handle].",
    thought_number=6,
    total_thoughts=6,
    next_thought_needed=False,
    stage="Conclusion",
    tags=["prep", "success-criteria"]
)
```

**CRITICAL: You MUST reach Conclusion stage before proceeding.**

### 8-Step Methodology (Apply During Sequential Thinking)

While using sequential thinking above, ensure you address:

This workflow applies the 8-step methodology:

### Step 1: Clarify Ambiguous Language
- Replace vague terms with specific file/function/component references
- Use `sequentialthinking` to reason through ambiguities
- Use `codebase-retrieval` to find how terms are used in the codebase

### Step 2: Add Missing Context
- Include relevant architecture patterns from Phase 2
- Reference coding standards from project documentation
- Verify third-party library APIs using Context7 if needed

### Step 3: Specify Success Criteria
- Define measurable outcomes (tests pass, no lint errors, etc.)
- Identify edge cases and validation requirements
- Reference quality gates from [`AGENTS.md`](../../AGENTS.md)

### Step 4: Break Down Complexity
- Decompose into sequential or parallel subtasks
- Identify dependencies between subtasks
- Create structured task list with clear phases

### Step 5: Correct Technical Errors
- Verify API signatures and file paths
- Check for outdated assumptions about the codebase
- Use Context7 for any external library usage

### Step 6: Align with Project Conventions
- Follow patterns from [`repomap.toml`](../../repomap.toml) layer definitions
- Use virtual environment for all Python commands (`.venv/bin/python -m ...`)
- Follow quality gate requirements (ruff, mypy, pytest)

### Step 7: Remove Scope Creep
- Eliminate implied work not explicitly requested
- Focus on the task's stated objective
- Don't add "nice to have" features

### Step 8: Preserve Code Samples
- Keep any user-provided code blocks unchanged
- Reference them during implementation

**Output:** Actionable task with clear subtasks, success criteria, and implementation plan.

---

## Execution Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: TASK DISCOVERY                                        │
│  ├── .kilocode/tools/bd show <task-id>                          │
│  ├── .kilocode/tools/bd show <parent-epic-id> (if exists)        │
│  └── Review task description and acceptance criteria            │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 2: CODEBASE EXPLORATION                                  │
│  ├── codebase-retrieval (semantic understanding)                │
│  ├── list_files + read_file (structural analysis)               │
│  ├── repomap claims query (architectural insights)              │
│  └── repomap verify (constraint checking)                       │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 3: TASK PREPARATION                                      │
│  ├── Clarify ambiguous language                                 │
│  ├── Add missing context                                        │
│  ├── Specify success criteria                                   │
│  ├── Break down complexity                                      │
│  ├── Correct technical errors                                   │
│  ├── Align with project conventions                             │
│  ├── Remove scope creep                                         │
│  └── Preserve code samples                                      │
├─────────────────────────────────────────────────────────────────┤
│  OUTPUT: READY TO EXECUTE                                       │
│  ├── Clear understanding of task scope                          │
│  ├── Comprehensive codebase context                             │
│  ├── Actionable subtasks with success criteria                  │
│  └── STOP — Wait for user approval to proceed                   │
└─────────────────────────────────────────────────────────────────┘
```

## Critical Rules

### Virtual Environment Mandate
**ALWAYS** use `.venv/bin/python -m ...` for Python execution. See [`virtual-environment-mandate.md`](../rules/virtual-environment-mandate.md).

### Beads Sync-Branch Model
- Local SQLite (`.beads/beads.db`) is a cache
- Remote `beads-sync` branch is the shared truth
- Run `.kilocode/tools/bd sync --no-push` at session start if not already synced
- See [`beads.md`](../rules/beads.md) for full workflow

### Quality Gates (Non-Negotiable)
Before committing any code changes:
```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```

### Layered Architecture
Respect layer boundaries defined in [`repomap.toml`](../../repomap.toml):
- Foundation → depends on nothing
- Verification → depends on foundation only
- Interface → depends on all layers

See [`architecture.md`](../rules/memory-bank/architecture.md) for details.

## MANDATORY: Export Session and STOP

**After completing Phase 3, you MUST export your thinking session:**

```python
# MANDATORY - Export your preparation session
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/task-{task-id}-prep-{YYYY-MM-DD}.json"
)
```

Example:
```python
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/task-repomap-542-prep-2026-01-23.json"
)
```

---

## STOP HERE

**This workflow STOPS after Phase 3 preparation is complete.**

✋ **DO NOT PROCEED TO IMPLEMENTATION.**

Before calling attempt_completion, you MUST:
1. Call `generate_summary` to verify sequential thinking was used
2. Confirm at least 6 thoughts exist across Problem Definition → Conclusion stages
3. Verify branch budget was spent (minimum 2 approach branches)

Present the prepared task with:
- Summary of task understanding
- Key files and components identified
- Proposed subtasks and success criteria
- Any clarifying questions or concerns

**To execute the task, the user must explicitly approve or run:**
```
/execute-task <task-id>
```

## Related Workflows

- [`/codebase-exploration`](./codebase-exploration.md) — Deep dive into code structure
- [`/prep-task`](./prep-task.md) — Detailed task preparation methodology
- [`/execute-task`](./execute-task.md) — Implementation phase (after approval)
- [`/beads-sync`](./beads-sync.md) — Sync beads state with remote

## Related Skills

- [`beads-local-db-ops`](../skills/beads-local-db-ops/SKILL.md) — Beads CLI operations
- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`repomap-query-claims`](../skills/repomap-query-claims/SKILL.md) — Architectural insights
- [`repomap-verify-architecture`](../skills/repomap-verify-architecture/SKILL.md) — Layer boundary checking
- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning

## Example Usage

### User Prompt
```
/start-task repomap-609.3
```

### Agent Response
```
Phase 1: Task Discovery

- Fetched task repomap-core-XXX: "Tighten deterministic artifact generation"

Phase 2: Codebase Exploration

- Key files: src/artifacts/**, src/scan/**, src/verify/**
- Architectural pattern: deterministic scanning + reproducible artifacts

Phase 3: Task Preparation
Success Criteria:

- Artifacts remain deterministic
- Quality gates pass (ruff, mypy, pytest)

Proposed Subtasks:

1. [ ] Implement change
2. [ ] Update tests
3. [ ] Run quality gates

Ready to proceed? (yes/no)
```

## Philosophy: Software Fabrication

This workflow embodies the "software fabrication" philosophy:
- **Determinism** — Same task → same preparation → same execution
- **Evidence-based** — Decisions backed by codebase analysis
- **Layered understanding** — Build context incrementally
- **Epistemic humility** — Acknowledge uncertainty, seek clarification

See [`brief.md`](../rules/memory-bank/brief.md) for project philosophy.
