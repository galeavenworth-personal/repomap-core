---
description: Orchestrator-based task initiation workflow. Uses subtasks for discovery, exploration, and preparation with sequential thinking session handoffs.
auto_execution_mode: 3
---

> **⚠️ REFERENCE DOCUMENTATION ONLY — This is not a runtime template.**
>
> The Process Orchestrator mode embeds this logic natively in its `roleDefinition`
> (see `.kilocodemodes`). Do not treat the step lists below as executable instructions;
> they are preserved as reference material for understanding the orchestration design.

> **⚠️ DEPRECATED (reference-only)**
>
> This workflow is preserved for historical reference. Prefer the mode-based entrypoints:
> - `process-orchestrator` (discover → explore → prepare → execute → gate → land) replaces `/orchestrate-start-task`, `/orchestrate-execute-task`, `/orchestrate-refactor`.
> - `audit-orchestrator` (Identity Attack → Friction Audit → Surface Minimization → Leverage Hunt → Synthesis) replaces `/orchestrate-pressure-test`.
>
> Do not treat the step lists below as executable instructions; see `.kilocodemodes` for the runtime `roleDefinition`.

# Orchestrate Start Task Workflow

**Purpose:** Factory-line task initiation using Orchestrator Mode with isolated subtask contexts and sequential thinking session handoffs.

**Trigger:** User invokes `/orchestrate-start-task <task-id>`

**Philosophy:** Parent task = foreman, subtasks = specialist workers, session exports = work orders moving down the line.

---

## Overview

This workflow transforms the monolithic `/start-task` into a multi-subtask orchestration:

```
┌─────────────────────────────────────────────────────────────────┐
│  PARENT (Orchestrator Mode)                                     │
│  ├── Subtask A (Architect): Discovery                           │
│  ├── Subtask B (Architect): Exploration                         │
│  ├── Subtask C (Architect): Preparation                         │
│  └── STOP: Present plan + handoff packet                        │
└─────────────────────────────────────────────────────────────────┘
```

**Key Benefits:**
- **Cleaner cognition**: Discovery, exploration, and prep don't contaminate each other
- **Session baton pass**: Each subtask exports reasoning, next subtask imports it
- **Modular tooling**: Each subtask uses specialized tool sets
- **Progress tracking**: Native todo list tracks subtask completion
- **Safer automation**: Auto-approve subtask creation/completion, manual approval for edits

---

## Prerequisites

- Beads preflight (fail-fast): `.kilocode/tools/beads_preflight.sh`
- Beads synced: `.kilocode/tools/bd sync --no-push`
- Task ID known
- Orchestrator mode available
- Sequential thinking MCP server connected

> Packaging note (split story): the `repomap claims ...` command group is provided by the optional `repomap-claims` extension package.

---

## Parent Task: Orchestration

### Step 0: Runtime Model Report (MANDATORY)

The agent cannot switch models/accounts programmatically. The enforceable invariant is to **report what model is actually running** (from `environment_details`).

**Required output (parent + every subtask):**
- `runtime_model_reported`
- `runtime_mode_reported`

The parent must record these in its own output and include a parent rollup entry in `runtime_attestations` when presenting the handoff packet.
**Optional:** If the operator wants to enforce a particular selection, paste an operator-declared `model_plan` into the handoff packet using [`model-plan-free-tier-lane.md`](./model-plan-free-tier-lane.md).

### Step 1: Initialize Todo List

```python
update_todo_list(
    todos="""
[ ] Runtime Model Report (record runtime model/mode)
[ ] Subtask A: Discovery (fetch task details from beads)
[ ] Subtask B: Exploration (gather codebase context)
[ ] Subtask C: Preparation (sequential thinking prep)
[ ] Present handoff packet and STOP
"""
)
```

### Step 2: Spawn Discovery Subtask

```python
new_task(
    mode="architect",
    message="""
# Discovery Subtask

**Objective:** Fetch task details from beads and understand strategic context.

**Task ID:** <task-id>

**Actions:**
1. Run `.kilocode/tools/bd show <task-id>` to get task details
2. If parent epic exists, run `.kilocode/tools/bd show <parent-id>`
3. Extract key information:
   - Task description and acceptance criteria
   - Expected outcome (bug fix, feature, refactor, investigation)
   - Dependencies or blockers
   - Parent epic's strategic context
   - Key components, files, or systems mentioned

**Output Requirements:**
- `runtime_model_reported`: <from environment_details>
- `runtime_mode_reported`: <mode slug>
- `model_plan_match`: MATCH|MISMATCH|N/A
- Clear task scope summary
- Strategic alignment notes
- List of key components/files mentioned
- Any ambiguities or questions

**Completion:**
Use `attempt_completion` with structured summary including:
- Task type and scope
- Strategic context
- Key components identified
- Open questions (if any)
""",
    todos=None  # Architect mode doesn't require todos
)
```

**Wait for subtask completion.** Parent receives summary only.

### Step 3: Update Progress

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Discovery (fetch task details from beads)
[-] Subtask B: Exploration (gather codebase context)
[ ] Subtask C: Preparation (sequential thinking prep)
[ ] Present handoff packet and STOP
"""
)
```

### Step 4: Spawn Exploration Subtask

```python
new_task(
    mode="architect",
    message="""
# Exploration Subtask

**Objective:** Gather comprehensive codebase context using layered tool strategy.

**Context from Discovery:**
<paste-discovery-summary-here>

**Layered Exploration Strategy:**

## Layer 1: Semantic Understanding (Augment)
Use `mcp--augment-context-engine--codebase-retrieval` to understand:
- How does [feature/component from discovery] work?
- What are the architectural patterns around [task area]?
- What are the key files and modules involved?

## Layer 2: Structural Analysis (Kilo Native)
- Use `list_files` to understand directory structure
- Use `read_file` to examine key files (batch up to 5)
- Use `search_files` for specific patterns or references

## Layer 3: Claims Analysis (Repomap)
Query repomap claims database:
- What architectural patterns exist in [task area]?
- What are the layer boundaries and dependencies?
- Are there any known design patterns or anti-patterns?

## Layer 4: Verification Context (Repomap)
If task involves architectural changes:
- What are the layer boundaries in [affected area]?
- What dependencies are allowed/forbidden?
- Are there any architectural violations to be aware of?

**Output Requirements:**
- `runtime_model_reported`: <from environment_details>
- `runtime_mode_reported`: <mode slug>
- `model_plan_match`: MATCH|MISMATCH|N/A
- Key files and their purposes
- Architectural patterns identified
- Layer boundaries and constraints
- Dependencies and relationships
- Edge cases or gotchas
- Test coverage status

**Completion:**
Use `attempt_completion` with structured summary including:
- File inventory with purposes
- Pattern catalog
- Constraint map
- Risk assessment
""",
    todos=None
)
```

**Wait for subtask completion.** Parent receives summary only.

### Step 5: Update Progress

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Discovery (fetch task details from beads)
[x] Subtask B: Exploration (gather codebase context)
[-] Subtask C: Preparation (sequential thinking prep)
[ ] Present handoff packet and STOP
"""
)
```

### Step 6: Spawn Preparation Subtask

```python
new_task(
    mode="architect",
    message="""
# Preparation Subtask

**Objective:** Transform task into actionable work using sequential thinking with MANDATORY session export.

**Context from Discovery:**
<paste-discovery-summary-here>

**Context from Exploration:**
<paste-exploration-summary-here>

**MANDATORY: Sequential Thinking Protocol**

You MUST use sequential thinking MCP tools. This is not optional.

## Phase 1: Problem Definition (2-3 thoughts)

Branch Budget: Minimum 2 interpretations required.

```python
mcp--sequentialthinking--process_thought(
    thought="Task interpretation 1: [first way to understand the task]",
    thought_number=1,
    total_thoughts=8,  # adjust as needed
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["prep", "interpretation"]
)

mcp--sequentialthinking--process_thought(
    thought="Task interpretation 2: [alternative understanding]",
    thought_number=2,
    total_thoughts=8,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["prep", "interpretation"]
)
```

## Phase 2: Analysis (2-3 thoughts)

Branch Budget: Minimum 2 approaches required.

```python
mcp--sequentialthinking--process_thought(
    thought="Approach A: [first implementation strategy]. Pros: [...]. Cons: [...]",
    thought_number=3,
    total_thoughts=8,
    next_thought_needed=True,
    stage="Analysis",
    tags=["prep", "approach"]
)

mcp--sequentialthinking--process_thought(
    thought="Approach B: [alternative strategy]. Pros: [...]. Cons: [...]",
    thought_number=4,
    total_thoughts=8,
    next_thought_needed=True,
    stage="Analysis",
    tags=["prep", "approach"]
)
```

## Phase 3: Verify Exploration

```python
mcp--sequentialthinking--generate_summary()
# Ensure you have:
# - Multiple Problem Definition thoughts (interpretations)
# - Multiple Analysis thoughts (approaches)
# - Clear reasoning for each branch
```

## Phase 4: Synthesis & Conclusion

```python
mcp--sequentialthinking--process_thought(
    thought="Choosing [selected approach] because [rationale]. Implementation plan: [step-by-step].",
    thought_number=5,
    total_thoughts=8,
    next_thought_needed=True,
    stage="Synthesis",
    tags=["prep", "decision"]
)

mcp--sequentialthinking--process_thought(
    thought="Success criteria: [measurable outcomes]. Risks: [potential issues]. Mitigation: [how to handle].",
    thought_number=6,
    total_thoughts=8,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["prep", "success-criteria"]
)
```

## MANDATORY: Export Session

```python
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/task-<task-id>-prep-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- `runtime_model_reported`: <from environment_details>
- `runtime_mode_reported`: <mode slug>
- `model_plan_match`: MATCH|MISMATCH|N/A
- Chosen approach with rationale
- Success criteria (measurable)
- Implementation subtasks (prioritized)
- Risk assessment with mitigations
- Files to be modified
- Tests to be added/updated
- Exported session path

**Completion:**
Use `attempt_completion` with handoff packet including:
- Exported session path
- Decision summary
- Success criteria
- Proposed subtasks
- Files touched
- Risks + mitigations
""",
    todos=None
)
```

**Wait for subtask completion.** Parent receives handoff packet.

### Step 7: Update Progress

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Discovery (fetch task details from beads)
[x] Subtask B: Exploration (gather codebase context)
[x] Subtask C: Preparation (sequential thinking prep)
[-] Present handoff packet and STOP
"""
)
```

### Step 8: Present Handoff Packet

Compile the handoff packet from all subtask summaries:

```markdown
# Task Preparation Complete: <task-id>

## Exported Session
**Path:** `.kilocode/thinking/task-<task-id>-prep-<YYYY-MM-DD>.json`

## Decision
**Chosen Approach:** <approach-name>
**Rationale:** <why-this-approach>

## Success Criteria
1. <measurable-criterion-1>
2. <measurable-criterion-2>
3. <measurable-criterion-3>

## Implementation Subtasks
1. [ ] <subtask-1>
2. [ ] <subtask-2>
3. [ ] <subtask-3>

## Files Touched
- `<file-1>` - <purpose>
- `<file-2>` - <purpose>

## Risks + Mitigations
- **Risk:** <risk-1>
  **Mitigation:** <mitigation-1>

## Test Plan
- <test-1>
- <test-2>

## Discovery Context
<discovery-summary>

## Exploration Context
<exploration-summary>
```

### Step 9: STOP

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Discovery (fetch task details from beads)
[x] Subtask B: Exploration (gather codebase context)
[x] Subtask C: Preparation (sequential thinking prep)
[x] Present handoff packet and STOP
"""
)
```

**DO NOT PROCEED TO IMPLEMENTATION.**

Use `attempt_completion` to present the handoff packet and wait for user approval.

---

## Handoff Packet Format

The handoff packet is the "work order" that moves to execution.

**Required:** `runtime_attestations` with one entry per subtask **plus** a parent rollup entry, each including `runtime_model_reported` + `runtime_mode_reported`.

**Optional:** operator-declared `model_plan` (see `docs/reference/MODEL_PLAN_SCHEMA.md`).

```json
{
  "task_id": "<task-id>",
  "model_plan": {
    "model_plan_version": "v1",
    "billing_policy": "free-tier-lane-first",
    "accounts": {
      "openai_free": "ChatGPT Account",
      "paid_fallback": "<optional>"
    },
    "routing": {
      "orchestrator": {"account": "openai_free", "model": "gpt-5.2", "setting": "high"},
      "architect": {"account": "openai_free", "model": "gpt-5.2", "setting": "high"},
      "code": {"account": "openai_free", "model": "gpt-5.1-codex-max", "setting": "default"},
      "tool_strict": {"account": "openai_free", "model": "gpt-5.2", "setting": "default"}
    }
  },
  "session_export": ".kilocode/thinking/task-<task-id>-prep-<YYYY-MM-DD>.json",
  "decision": {
    "approach": "<approach-name>",
    "rationale": "<why>"
  },
  "success_criteria": [
    "<criterion-1>",
    "<criterion-2>"
  ],
  "subtasks": [
    {"id": 1, "description": "<subtask-1>", "status": "pending"},
    {"id": 2, "description": "<subtask-2>", "status": "pending"}
  ],
  "files_touched": [
    {"path": "<file-1>", "purpose": "<purpose>"}
  ],
  "risks": [
    {"risk": "<risk-1>", "mitigation": "<mitigation-1>"}
  ],
  "tests": [
    "<test-1>",
    "<test-2>"
  ],
  "runtime_attestations": [
    {
      "subtask": "Parent (Orchestrator)",
      "runtime_model_reported": "<from environment_details>",
      "runtime_mode_reported": "<mode slug>",
      "model_plan_match": "MATCH|MISMATCH|N/A"
    },
    {
      "subtask": "Discovery",
      "runtime_model_reported": "<from environment_details>",
      "runtime_mode_reported": "<mode slug>",
      "model_plan_match": "MATCH|MISMATCH|N/A"
    }
  ]
}
```

---

## Execution Trigger

After user approval, they invoke:
```
/orchestrate-execute-task <task-id>
```

This loads the handoff packet and spawns execution subtasks.

---

## Benefits Over Monolithic `/start-task`

1. **Isolated contexts**: Discovery doesn't pollute exploration, exploration doesn't pollute prep
2. **Specialist workers**: Each subtask uses optimal tool set for its phase
3. **Session handoffs**: Sequential thinking sessions move between subtasks via export/import
4. **Progress visibility**: Todo list shows exactly where you are in the pipeline
5. **Resumability**: If interrupted, parent todo list shows which subtasks completed
6. **Safer automation**: Auto-approve subtask spawn/close, manual approve file edits

---

## Related Workflows

- [`/orchestrate-execute-task`](./orchestrate-execute-task.md) — Execution phase (after approval)
- [`/start-task`](./start-task.md) — Original monolithic version (for reference)
- [`/prep-task`](./prep-task.md) — Standalone prep workflow

---

## Philosophy

This workflow embodies the "factory line" model:
- **Parent = foreman**: Coordinates work, doesn't do it
- **Subtasks = specialists**: Each does one thing well
- **Session exports = work orders**: Context moves explicitly, not implicitly
- **Handoff packet = quality gate**: No execution without verified prep
