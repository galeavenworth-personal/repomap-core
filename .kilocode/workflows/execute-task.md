---
description: Implementation workflow that begins after /start-task preparation is complete. Enforces pre-execution verification and structured execution loop.
auto_execution_mode: 3
---

# Task Execution Protocol

This workflow begins where `/start-task` ends—when you have completed sequential thinking, reached Conclusion stage, and exported your session. **You may NOT execute without proper preparation.**

**Core principle:** Verify reasoning → Execute subtask → Verify completion → Repeat.

**Mode Management**: Each step specifies the BEST mode for that work. Switch modes between steps using `switch_mode(mode_slug, reason)`.

---

## Pre-Execution Gate (MANDATORY)

**YOU MUST RUN THESE VERIFICATION STEPS FIRST. NO EXCEPTIONS.**

### Step 1: Load Preparation Session
**Best Mode**: `code` (can read all files, access MCP tools)

```python
# MANDATORY - Load the prep session from /start-task
mcp--sequentialthinking--import_session(
    file_path=".kilocode/thinking/task-{task-id}-prep-{YYYY-MM-DD}.json"
)
```

Example:
```python
mcp--sequentialthinking--import_session(
    file_path=".kilocode/thinking/task-repomap-542-prep-2026-01-23.json"
)
```

**If this fails:** The prep session doesn't exist. HALT IMMEDIATELY and run `/start-task <task-id>` first.

### Step 2: Verify Conclusion Stage Reached
**Best Mode**: `code` (same as Step 1, avoid mode thrashing)

```python
# MANDATORY - Verify preparation was completed properly
summary = mcp--sequentialthinking--generate_summary()

# Check the summary output for:
# - "currentStage": "Conclusion" appears in the output
# - Multiple thoughts in "Problem Definition" and "Analysis" stages
# - At least 2 interpretation branches explored
# - At least 2 approach branches explored
```

**If Conclusion stage not reached:** Preparation is incomplete. HALT IMMEDIATELY and complete `/prep-task` workflow with proper sequential thinking.

### Step 3: Review Preparation Decisions
**Best Mode**: `code` (same as Steps 1-2, avoid mode thrashing)

After verifying the session is valid, review the key decisions:
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
│     Best Mode: code                                             │
│     ├── process_thought: What am I about to change?             │
│     ├── process_thought: What are the risks?                    │
│     └── Conclusion stage: Commit to edit strategy               │
│                                                                 │
│  1. ACTIVATE                                                    │
│     Best Mode: code (same as Step 0)                            │
│     └── update_todo_list: mark IN_PROGRESS                      │
│                                                                 │
│  2. GATHER CONTEXT                                              │
│     Best Mode: code (codebase-retrieval, read all files)        │
│     ├── codebase-retrieval: verify signatures                   │
│     ├── codebase-retrieval: find usage patterns                 │
│     ├── mcp--context7--query-docs: verify external APIs         │
│     └── read_file: read target file(s)                          │
│                                                                 │
│  3. EDIT CODE                                                   │
│     Best Mode: code (can edit .py files)                        │
│     └── edit_file/write_to_file: make targeted changes          │
│                                                                 │
│  4. FIND IMPACTS                                                │
│     Best Mode: code (codebase-retrieval for callers/tests)      │
│     ├── codebase-retrieval: find all callers                    │
│     ├── codebase-retrieval: find affected tests                 │
│     ├── search_files: find all references                       │
│     └── codebase-retrieval: find implementations                │
│                                                                 │
│  5. UPDATE DOWNSTREAM                                           │
│     Best Mode: code (edit .py test files)                       │
│     ├── edit_file: update call sites                            │
│     ├── edit_file: update tests                                 │
│     └── edit_file: update imports/types                         │
│                                                                 │
│  6. VALIDATE                                                    │
│     Best Mode: code (run quality gates)                         │
│     ├── execute_command: ruff check (lint)                      │
│     └── execute_command: pytest -m tier0 (if tests affected)    │
│                                                                 │
│  7. UPDATE DOCUMENTATION (if needed)                            │
│     Best Mode: architect (specialized for .md files)            │
│     ⚠️  Switch from code → architect for this step              │
│     └── edit_file: update .md files                             │
│                                                                 │
│  8. COMPLETE                                                    │
│     Best Mode: code (or architect if Step 7 was last)           │
│     └── update_todo_list: mark COMPLETE                         │
│                                                                 │
│  9. SAVE PROGRESS (after each subtask)                          │
│     Best Mode: code (or architect if Step 7 was last)           │
│     └── export_session: preserve reasoning state                │
│                                                                 │
│  REPEAT for next subtask...                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Mode Switching Strategy

**Minimize mode switches** to reduce cost and latency:

1. **Steps 0-6**: Stay in `code` mode (handles all code work)
2. **Step 7**: Switch to `architect` mode ONLY if documentation updates are needed
3. **Steps 8-9**: Stay in current mode (code or architect)

**When to switch:**
```python
# Before Step 7 (if documentation updates needed)
if documentation_updates_needed:
    switch_mode(
        mode_slug="architect",
        reason="Updating documentation files (.md) - architect mode specialized for this"
    )

# Before next subtask (if returning to code work)
if next_subtask_involves_code:
    switch_mode(
        mode_slug="code",
        reason="Returning to code implementation work"
    )
```

**Mode capabilities** (from `.kilocodemodes`):
- **code**: Can edit all files, has all tool groups (read, edit, command, mcp, browser) ✅
- **architect**: Can edit `.md`, `.txt`, `.yaml`, `.yml`, `.toml`, `.json` only
- **claims-ops**: Can edit all files, specialized for claims pipeline
- **debug**: Can edit all files, specialized for debugging
- **pr-review**: Can edit `.md`, `.txt` only, specialized for PR reviews

**Why `code` mode is default:**
- Has unrestricted file access (no `fileRegex`)
- Has all tool groups (read, edit, command, mcp, browser)
- Specialized for Python implementation work
- Avoids mode thrashing between steps

### Step Details

#### 0. Pre-Edit Reasoning (Non-Trivial Changes Only)
**Best Mode**: `code`

**When to use:** Changes that touch >1 file, modify interfaces, or affect tests.

**Required reasoning:**

```python
mcp--sequentialthinking--process_thought(
    thought="About to modify [component]. Risk: [breaking changes to N callers]. Mitigation: [verify signatures first, update all call sites].",
    thought_number=1,
    total_thoughts=2,
    next_thought_needed=True,
    stage="Analysis",
    tags=["execution", "risk-assessment"]
)

mcp--sequentialthinking--process_thought(
    thought="Edit strategy: [step-by-step plan]. Success criteria: [tests pass, no lint errors].",
    thought_number=2,
    total_thoughts=2,
    next_thought_needed=False,
    stage="Conclusion",
    tags=["execution", "edit-plan"]
)
```

**Skip this for:** Trivial changes (typo fixes, adding comments, simple variable renames in single file).

#### 1-9. Execution Steps

Follow the loop above, using Kilo Code's native tools:
- `mcp--augment-context-engine--codebase-retrieval` for semantic search
- `read_file` for reading files (batch up to 5)
- `edit_file` or `apply_diff` for targeted edits
- `write_to_file` for new files only
- `search_files` for pattern matching
- `execute_command` for running tests/linters
- `update_todo_list` for progress tracking
- `switch_mode` for changing modes (minimize switches)

#### 9. Save Progress

**After EACH subtask completion**, save your reasoning state:

```python
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/execution-{task-name}-2026-01-23.json"
)
```

**Why:** If execution is interrupted, you can resume with full context of what was completed and why decisions were made.

---

## Tool Mapping (Kilo Code)

| Need | Tool | Example |
|------|------|---------|
| Semantic search | `mcp--augment-context-engine--codebase-retrieval` | "Exact signature of X in file Y" |
| Read files | `read_file` | Batch up to 5 files |
| Pattern search | `search_files` | Rust regex patterns |
| Edit existing | `edit_file` or `apply_diff` | Targeted replacements |
| Create new | `write_to_file` | New files only |
| Run commands | `execute_command` | Tests, linters, builds |
| Track progress | `update_todo_list` | Mark IN_PROGRESS/COMPLETE |
| External docs | `mcp--context7--query-docs` | Library API verification |
| Change mode | `switch_mode` | Switch between code/architect (minimize) |

---

## Verification Phase

Before marking the overall work complete, run final validation:

### 1. Quality Gates
**Best Mode**: `code` (can run all commands)

```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```

### 2. Todo List Review
**Best Mode**: `code` (same as Step 1)

All subtasks marked COMPLETE.

### 3. Success Criteria Confirmation
**Best Mode**: `code` (same as Steps 1-2)

Review the success criteria defined during planning:
- Each criterion explicitly satisfied
- No partial completions
- No deferred items unless user-approved

---

## Session Continuity

### If Resuming Execution Work
**Best Mode**: `code` (start where you left off)

If you're continuing execution from a previous session:

```python
# MANDATORY: Load previous session
mcp--sequentialthinking--import_session(
    file_path=".kilocode/thinking/execution-{task-name}-2026-01-23.json"
)

# Review what was completed
mcp--sequentialthinking--generate_summary()

# Continue with next subtask
mcp--sequentialthinking--process_thought(
    thought="Resuming execution: [N] of [M] subtasks complete. Next: [subtask description]",
    stage="Problem Definition",
    tags=["execution-resume"]
)
```

---

## Related Workflows

- [`/start-task`](./start-task.md) — Preparation phase (must complete first)
- [`/prep-task`](./prep-task.md) — Detailed task preparation methodology
- [`/respond-to-pr-review`](./respond-to-pr-review.md) — PR review response workflow
- [`/fix-ci`](./fix-ci.md) — Quality gate fixes

## Philosophy

This workflow enforces the "software fabrication" principle of **verified preparation before execution**. No code changes without proper reasoning. No execution without verified prep session.

**Mode optimization**: Use `code` mode for all implementation work (Steps 0-6), switch to `architect` mode ONLY for documentation updates (Step 7), then return to `code` for next subtask. This minimizes mode thrashing and associated costs.
