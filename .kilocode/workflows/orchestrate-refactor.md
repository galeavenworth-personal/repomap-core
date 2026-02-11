---
description: Orchestrator-based refactoring workflow. Uses subtasks for analysis, planning, implementation, and verification with architecture-aware decision making.
auto_execution_mode: 3
---

# Orchestrate Refactor Workflow

**Purpose:** Factory-line refactoring using Orchestrator Mode with isolated analysis, planning, and implementation subtasks.

**Trigger:** User invokes `/orchestrate-refactor <description>`

**Philosophy:** Parent = refactoring coordinator, subtasks = specialists (analyzer, planner, implementer, verifier), session exports = refactoring decisions.

---

## Overview

This workflow transforms complex refactoring into a multi-subtask orchestration:

```
┌─────────────────────────────────────────────────────────────────┐
│  PARENT (Orchestrator Mode)                                     │
│  ├── Subtask A (Architect): Analyze current state               │
│  ├── Subtask B (Architect): Plan refactoring with alternatives  │
│  ├── STOP: Present plan for approval                            │
│  ├── Subtask C (Code): Implement refactoring                    │
│  ├── Subtask D (Code): Update tests                             │
│  ├── Subtask E (Code): Verify architecture constraints          │
│  └── Complete: Quality gates + results                          │
└─────────────────────────────────────────────────────────────────┘
```

**Key Benefits:**
- **Separation of concerns**: Analysis doesn't contaminate implementation
- **Architecture awareness**: Explicit verification of layer boundaries
- **Multiple alternatives**: Sequential thinking explores approaches
- **Approval gate**: User reviews plan before implementation
- **Constraint verification**: Repomap verify ensures compliance

---

## Prerequisites

- Refactoring description or target component known
- Orchestrator mode available
- Sequential thinking MCP server connected
- Repomap artifacts generated (for architecture verification)

> Packaging note (split story): the `repomap claims ...` command group is provided by the optional `repomap-claims` extension package.

---

## Parent Task: Orchestration

### Step 1: Initialize Todo List

```python
update_todo_list(
    todos="""
[ ] Subtask A: Analyze current state
[ ] Subtask B: Plan refactoring with alternatives
[ ] STOP: Present plan for approval
[ ] Subtask C: Implement refactoring
[ ] Subtask D: Update tests
[ ] Subtask E: Verify architecture constraints
[ ] Complete: Quality gates + results
"""
)
```

### Step 2: Spawn Analysis Subtask

```python
new_task(
    mode="architect",
    message="""
# Refactoring Analysis Subtask

**Objective:** Analyze current state of code to be refactored.

**Target:** <refactoring-description>

**Analysis Protocol:**

## Step 1: Semantic Understanding

Use `mcp--augment-context-engine--codebase-retrieval` to understand:
- What does the target code do?
- Why was it implemented this way?
- What are its responsibilities?
- What patterns does it follow?

## Step 2: Dependency Analysis

Use `mcp--augment-context-engine--codebase-retrieval` to find:
- What calls this code?
- What does this code call?
- What are the data flows?
- What are the control flows?

## Step 3: Architecture Context

Query repomap claims:
- What layer is this code in?
- What architectural patterns apply?
- What constraints exist?
- Are there any violations?

Use repomap verify:
- What are the layer boundaries?
- What dependencies are allowed?
- What dependencies are forbidden?

## Step 4: Test Coverage

Use `search_files` to find:
- What tests cover this code?
- What test patterns are used?
- What edge cases are tested?

## Step 5: Code Quality Assessment

Identify:
- Code smells (duplication, complexity, coupling)
- Design pattern opportunities
- Maintainability issues
- Performance concerns

**Output Requirements:**
- Current state summary
- Dependency map
- Architecture context
- Test coverage status
- Quality issues identified
- Refactoring motivations

**Completion:**
Use `attempt_completion` with analysis report including:
- What the code does
- Why it needs refactoring
- Current architecture context
- Dependencies and impacts
- Test coverage
- Quality assessment
""",
    todos=None
)
```

**Wait for subtask completion.** Parent receives analysis report.

### Step 3: Update Progress

```python
update_todo_list(
    todos="""
[x] Subtask A: Analyze current state
[-] Subtask B: Plan refactoring with alternatives
[ ] STOP: Present plan for approval
[ ] Subtask C: Implement refactoring
[ ] Subtask D: Update tests
[ ] Subtask E: Verify architecture constraints
[ ] Complete: Quality gates + results
"""
)
```

### Step 4: Spawn Planning Subtask

```python
new_task(
    mode="architect",
    message="""
# Refactoring Planning Subtask

**Objective:** Plan refactoring with multiple alternatives using sequential thinking.

**Context from Analysis:**
<paste-analysis-report>

**MANDATORY: Sequential Thinking Protocol**

You MUST use sequential thinking to explore alternatives.

## Phase 1: Problem Definition (2-3 thoughts)

```python
mcp--sequentialthinking--process_thought(
    thought="Refactoring goal 1: [first way to frame the problem]",
    thought_number=1,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["refactor", "problem-framing"]
)

mcp--sequentialthinking--process_thought(
    thought="Refactoring goal 2: [alternative framing]",
    thought_number=2,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["refactor", "problem-framing"]
)
```

## Phase 2: Research (2-3 thoughts)

```python
mcp--sequentialthinking--process_thought(
    thought="Pattern option: [design pattern from REFACTORING_PLAYBOOK.md]. Applicability: [...]",
    thought_number=3,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Research",
    tags=["refactor", "patterns"]
)
```

Consult REFACTORING_PLAYBOOK.md for patterns:
- Extract Method
- Extract Class
- Strategy Pattern
- Repository Pattern
- Facade Pattern
- Dataclass Conversion

## Phase 3: Analysis (3-4 thoughts)

Branch Budget: Minimum 3 approaches required.

```python
mcp--sequentialthinking--process_thought(
    thought="Approach A: [strategy]. Pros: [...]. Cons: [...]. Risk: [...]",
    thought_number=4,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Analysis",
    tags=["refactor", "approach"]
)

mcp--sequentialthinking--process_thought(
    thought="Approach B: [alternative]. Pros: [...]. Cons: [...]. Risk: [...]",
    thought_number=5,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Analysis",
    tags=["refactor", "approach"]
)

mcp--sequentialthinking--process_thought(
    thought="Approach C: [another alternative]. Pros: [...]. Cons: [...]. Risk: [...]",
    thought_number=6,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Analysis",
    tags=["refactor", "approach"]
)
```

## Phase 4: Verify Exploration

```python
mcp--sequentialthinking--generate_summary()
# Ensure you have:
# - Multiple problem framings
# - Pattern research
# - At least 3 approach alternatives
```

## Phase 5: Synthesis & Conclusion

```python
mcp--sequentialthinking--process_thought(
    thought="Choosing [approach] because [rationale]. Implementation steps: [...]",
    thought_number=7,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Synthesis",
    tags=["refactor", "decision"]
)

mcp--sequentialthinking--process_thought(
    thought="Migration strategy: [how to transition]. Backward compatibility: [...]",
    thought_number=8,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["refactor", "migration"]
)

mcp--sequentialthinking--process_thought(
    thought="Success criteria: [measurable outcomes]. Risks: [...]. Mitigation: [...]",
    thought_number=9,
    total_thoughts=10,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["refactor", "success-criteria"]
)
```

## MANDATORY: Export Session

```python
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/refactor-<component>-plan-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- Chosen approach with rationale
- Alternative approaches considered
- Implementation steps
- Migration strategy
- Success criteria
- Risk assessment
- Exported session path

**Completion:**
Use `attempt_completion` with refactoring plan including:
- Decision summary
- Alternatives explored
- Implementation roadmap
- Migration strategy
- Success criteria
- Session export path
""",
    todos=None
)
```

**Wait for subtask completion.** Parent receives refactoring plan.

### Step 5: Update Progress

```python
update_todo_list(
    todos="""
[x] Subtask A: Analyze current state
[x] Subtask B: Plan refactoring with alternatives
[-] STOP: Present plan for approval
[ ] Subtask C: Implement refactoring
[ ] Subtask D: Update tests
[ ] Subtask E: Verify architecture constraints
[ ] Complete: Quality gates + results
"""
)
```

### Step 6: STOP and Present Plan

Compile refactoring plan from analysis and planning subtasks:

```markdown
# Refactoring Plan: <component>

## Current State Analysis
<analysis-summary>

## Alternatives Explored
1. **Approach A:** <description>
   - Pros: <pros>
   - Cons: <cons>
   - Risk: <risk>

2. **Approach B:** <description>
   - Pros: <pros>
   - Cons: <cons>
   - Risk: <risk>

3. **Approach C:** <description>
   - Pros: <pros>
   - Cons: <cons>
   - Risk: <risk>

## Chosen Approach
**Decision:** <approach-name>
**Rationale:** <why>

## Implementation Steps
1. <step-1>
2. <step-2>
3. <step-3>

## Migration Strategy
<how-to-transition>

## Success Criteria
1. <criterion-1>
2. <criterion-2>
3. <criterion-3>

## Risks + Mitigations
- **Risk:** <risk-1>
  **Mitigation:** <mitigation-1>

## Session Exports
- Analysis: (none - architect mode)
- Planning: `.kilocode/thinking/refactor-<component>-plan-<YYYY-MM-DD>.json`
```

```python
update_todo_list(
    todos="""
[x] Subtask A: Analyze current state
[x] Subtask B: Plan refactoring with alternatives
[x] STOP: Present plan for approval
[ ] Subtask C: Implement refactoring
[ ] Subtask D: Update tests
[ ] Subtask E: Verify architecture constraints
[ ] Complete: Quality gates + results
"""
)
```

**Use `attempt_completion` to present plan and wait for user approval.**

---

## Implementation Phase (After Approval)

### Step 7: Spawn Implementation Subtask

```python
new_task(
    mode="code",
    message="""
# Refactoring Implementation Subtask

**Objective:** Implement the approved refactoring plan.

**Context from Planning:**
<paste-refactoring-plan>

**MANDATORY: Import Planning Session**

```python
mcp--sequentialthinking--import_session(
    file_path=".kilocode/thinking/refactor-<component>-plan-<YYYY-MM-DD>.json"
)
```

**Implementation Protocol:**

## Step 1: Pre-Refactor Verification

- Read all files to be modified
- Verify current signatures match analysis
- Confirm no unexpected changes since analysis

## Step 2: Incremental Implementation

Follow the implementation steps from the plan:

For each step:
1. Make targeted changes
2. Run `ruff format --check .` and `ruff check .`
3. Verify imports and types
4. Run affected tests

## Step 3: Migration Execution

Follow migration strategy:
- Update call sites
- Update imports
- Maintain backward compatibility (if required)

## Step 4: Validation

```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
```

## Step 5: Export Progress

```python
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/refactor-<component>-impl-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- Files modified
- Changes summary
- Migration status
- Validation results
- Session export path

**Completion:**
Use `attempt_completion` with implementation report.
""",
    todos="""
[ ] Import planning session
[ ] Pre-refactor verification
[ ] Incremental implementation
[ ] Migration execution
[ ] Validation
[ ] Export progress
"""
)
```

**Wait for subtask completion.**

### Step 8: Update Progress

```python
update_todo_list(
    todos="""
[x] Subtask A: Analyze current state
[x] Subtask B: Plan refactoring with alternatives
[x] STOP: Present plan for approval
[x] Subtask C: Implement refactoring
[-] Subtask D: Update tests
[ ] Subtask E: Verify architecture constraints
[ ] Complete: Quality gates + results
"""
)
```

### Step 9: Spawn Test Update Subtask

```python
new_task(
    mode="code",
    message="""
# Test Update Subtask

**Objective:** Update tests to reflect refactored code.

**Context from Implementation:**
<paste-implementation-report>

**Test Update Protocol:**

## Step 1: Identify Test Changes

- What tests need updates due to signature changes?
- What new tests are needed for new components?
- What tests can be removed (if any)?

## Step 2: Update Existing Tests

- Update imports
- Update call signatures
- Update assertions
- Maintain test coverage

## Step 3: Add New Tests

- Test new components
- Test migration paths
- Test edge cases

## Step 4: Run Tests

```bash
.venv/bin/python -m pytest tests/ -v
```

## Step 5: Export Progress

```python
mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/refactor-<component>-tests-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- Tests updated
- Tests added
- Test results
- Session export path

**Completion:**
Use `attempt_completion` with test report.
""",
    todos="""
[ ] Identify test changes
[ ] Update existing tests
[ ] Add new tests
[ ] Run tests
[ ] Export progress
"""
)
```

**Wait for subtask completion.**

### Step 10: Update Progress

```python
update_todo_list(
    todos="""
[x] Subtask A: Analyze current state
[x] Subtask B: Plan refactoring with alternatives
[x] STOP: Present plan for approval
[x] Subtask C: Implement refactoring
[x] Subtask D: Update tests
[-] Subtask E: Verify architecture constraints
[ ] Complete: Quality gates + results
"""
)
```

### Step 11: Spawn Architecture Verification Subtask

```python
new_task(
    mode="code",
    message="""
# Architecture Verification Subtask

**Objective:** Verify refactored code complies with architecture constraints.

**Verification Protocol:**

## Step 1: Run Repomap Verify

```bash
.venv/bin/python -m repomap verify
```

Check for:
- Layer boundary violations
- Forbidden dependencies
- Architectural constraint violations

## Step 2: Query Claims

Use repomap claims query to verify:
- Refactored code follows project patterns
- No new anti-patterns introduced
- Architectural integrity maintained

## Step 3: Validate Against Plan

Compare implementation to plan:
- All success criteria met?
- All risks mitigated?
- Migration complete?

**Output Requirements:**
- Repomap verify results
- Claims query results
- Success criteria checklist
- Compliance status

**Completion:**
Use `attempt_completion` with verification report.
""",
    todos="""
[ ] Run repomap verify
[ ] Query claims
[ ] Validate against plan
[ ] Report compliance status
"""
)
```

**Wait for subtask completion.**

### Step 12: Update Progress

```python
update_todo_list(
    todos="""
[x] Subtask A: Analyze current state
[x] Subtask B: Plan refactoring with alternatives
[x] STOP: Present plan for approval
[x] Subtask C: Implement refactoring
[x] Subtask D: Update tests
[x] Subtask E: Verify architecture constraints
[-] Complete: Quality gates + results
"""
)
```

### Step 13: Run Quality Gates and Complete

Run final quality gates:

```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```

Compile final report:

```markdown
# Refactoring Complete: <component>

## Implementation Summary
<implementation-report>

## Test Summary
<test-report>

## Architecture Verification
<verification-report>

## Quality Gates
- Format: PASS
- Lint: PASS
- Type check: PASS
- Tests: PASS
- Architecture: PASS

## Files Modified
- `<file-1>` - <changes>
- `<file-2>` - <changes>

## Session Exports
- Planning: `.kilocode/thinking/refactor-<component>-plan-<YYYY-MM-DD>.json`
- Implementation: `.kilocode/thinking/refactor-<component>-impl-<YYYY-MM-DD>.json`
- Tests: `.kilocode/thinking/refactor-<component>-tests-<YYYY-MM-DD>.json`

## Success Criteria Met
- [x] <criterion-1>
- [x] <criterion-2>
- [x] <criterion-3>

## Next Steps
1. Review changes
2. Commit with message: "refactor: <description>"
3. Create PR if needed
```

```python
update_todo_list(
    todos="""
[x] Subtask A: Analyze current state
[x] Subtask B: Plan refactoring with alternatives
[x] STOP: Present plan for approval
[x] Subtask C: Implement refactoring
[x] Subtask D: Update tests
[x] Subtask E: Verify architecture constraints
[x] Complete: Quality gates + results
"""
)
```

**Use `attempt_completion` to present final report.**

---

## Benefits Over Monolithic Refactoring

1. **Separation of analysis and implementation**: Analysis doesn't pollute implementation context
2. **Explicit alternatives**: Sequential thinking forces exploration of multiple approaches
3. **Approval gate**: User reviews plan before code changes
4. **Architecture awareness**: Explicit verification of constraints
5. **Session chain**: Full reasoning history from analysis → planning → implementation
6. **Modular verification**: Each phase validates its own work
7. **Resumability**: Interruption doesn't lose context

---

## Related Workflows

- [`/refactor`](./refactor.md) — Original monolithic version (for reference)
- [`/orchestrate-start-task`](./orchestrate-start-task.md) — Task preparation pattern
- [`/orchestrate-execute-task`](./orchestrate-execute-task.md) — Execution pattern

---

## Philosophy

This workflow embodies the "factory line" model for refactoring:
- **Parent = refactoring coordinator**: Orchestrates phases, doesn't do work
- **Subtasks = specialists**: Analyzer, planner, implementer, verifier
- **Session exports = refactoring decisions**: Context preserved at each phase
- **Approval gate = quality control**: No implementation without approved plan
- **Architecture verification = compliance check**: No completion without constraint validation
