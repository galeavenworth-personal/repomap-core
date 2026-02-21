---
description: AI-enhanced refactoring workflow with tool integration and design pattern mapping
auto_execution_mode: 3
punch_card: refactor
---

# Refactoring Workflow

Use this workflow when refactoring code, whether triggered by SonarQube issues, code
review feedback, or proactive improvement. This workflow integrates codebase exploration
tools, design pattern mappings, and verification checkpoints.

**Punch Card:** `refactor` (6 rows, 5 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Phase 0: Detect Issues

Refactoring work can originate from multiple sources. Each has different context and urgency.

### Source A: SonarQube Issues

> 📌 `search issues` → [`commands.search_issues`](../commands.toml)
> Resolves to: `mcp--sonarqube--search_sonar_issues_in_projects`

Filter by severity for prioritization:
- `BLOCKER`, `CRITICAL` → address immediately
- `MAJOR` → address when touching the file
- `MINOR`, `INFO` → opportunistic

**Context available**: Rule ID, exact line, severity, clean code attribute

### Source B: Beads Issues

> 📌 `list ready` → [`commands.list_ready`](../commands.toml)
> Resolves to: `.kilocode/tools/bd ready`

Refactoring needs discovered during exploration tasks:
```bash
.kilocode/tools/bd ready --json | jq '.[] | select(.labels | contains(["refactor"]))'
```

When creating refactor issues from exploration:
```bash
.kilocode/tools/bd create --title "Refactor: [description]" --json
.kilocode/tools/bd dep add <new-id> <parent-id> --type discovered-from
```

**Context available**: Parent task context, discovery notes, scope constraints

### Source C: PR/Code Review Feedback

Reviewer comments identifying:
- Code smells or complexity concerns
- Maintainability suggestions
- Pattern violations

> 📌 `fetch pr` → [`commands.fetch_pr`](../commands.toml)
> 📌 `list pr-comments` → [`commands.list_pr_comments`](../commands.toml)

**Context available**: Reviewer reasoning, specific code locations, sometimes suggested approach

### Source D: Linter/Type Checker Warnings

> 📌 `check ruff` → [`commands.check_ruff`](../commands.toml)
> Resolves to: `.venv/bin/python -m ruff check .`

> 📌 `check mypy` → [`commands.check_mypy`](../commands.toml)
> Resolves to: `.venv/bin/python -m mypy src`

Common refactor-relevant codes:
- `C901` (ruff/flake8): Function too complex
- `R0912` (pylint): Too many branches
- `R0914` (pylint): Too many local variables
- `R0915` (pylint): Too many statements

**Context available**: Metric thresholds, exact locations, sometimes fix suggestions

### Source E: Exploration-Driven Discovery

During `/codebase-exploration` or feature investigation:
- Encountered complexity that slowed understanding
- Found code that should be refactored before adding features
- Identified technical debt blocking progress

**Action**: Create Beads issue immediately, continue with original task or pivot to refactor.

---

### Prioritization Matrix

| Source | Urgency | Context Quality | Typical Scope |
|--------|---------|-----------------|---------------|
| SonarQube BLOCKER | High | High (rule + metrics) | Targeted |
| PR Feedback | High | Medium (human judgment) | Varies |
| Beads (blocking) | High | High (linked context) | Scoped |
| Linter warnings | Medium | Medium (thresholds) | Targeted |
| Exploration discovery | Low-Medium | Varies | Often broad |
| SonarQube MINOR | Low | High | Targeted |

---

## Phase 1: Understand Context

**Goal**: Understand what the code does and why, before changing it.

### Step 1.1: Semantic Overview

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Query: "What does [function/class] do and what depends on it?"
→ Get purpose, callers, related components

### Step 1.2: Quantitative Analysis

Use `search_files` to find ALL references to the target function/class.

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)

Query: "[function name] error handling edge cases"
→ Know the blast radius before making changes

### Step 1.3: SonarQube Metrics (if applicable)

> 📌 `inspect measures` → [`commands.inspect_measures`](../commands.toml)
> Resolves to: `mcp--sonarqube--get_component_measures`

Get complexity, coverage, and violations for the target component.

---

## Phase 2: Map Smell → Pattern

Use this mapping to connect SonarQube rules to design patterns.

### Cognitive Complexity (S3776)
**Smell**: Function too complex, nested conditionals, multiple responsibilities
**Patterns**:
- **Extract Method**: Pull coherent sub-steps into separate functions
- **Strategy Pattern**: Replace if/elif chains dispatching on type/mode
- **Early Return**: Flatten nested conditionals with guard clauses
- **Template Method**: Separate orchestration from implementation

### Duplicated Literals (S1192)
**Smell**: Same string/value repeated multiple times
**Patterns**:
- **Constants Module**: Define once, import everywhere
- **Configuration Object**: Group related constants in a dataclass
- **Enum**: If values represent discrete states

### Unused Parameters (S1172)
**Smell**: Parameter exists but isn't used
**Patterns**:
- **Remove Parameter**: If truly unused
- **Adapter Pattern**: If signature must match interface but value isn't needed
- **Document Intent**: If parameter is for future use (rare, justify carefully)

### Duplicate Branches (S1871)
**Smell**: Multiple branches with identical code
**Patterns**:
- **Combine Conditions**: Merge branches with same outcome
- **Strategy Pattern**: If branches differ only in small ways
- **Extract Common Logic**: Pull shared code before/after branch

### Field Name Matches Class (S1700)
**Smell**: Field named same as containing class
**Patterns**:
- **Rename Field**: Use more specific name (e.g., `value`, `data`, `content`)
- **Unwrap**: If class is just a wrapper, consider removing indirection

### Long Functions (>40 lines)
**Smell**: Function does too much
**Patterns**:
- **Extract Method**: Identify coherent blocks
- **Command Pattern**: If function has multiple distinct operations
- **Facade Pattern**: If function orchestrates complex subsystem

### Data Clumps
**Smell**: Same parameters passed together repeatedly
**Patterns**:
- **Dataclass**: Group related parameters
- **Value Object**: If the group has behavior/validation

### God Class
**Smell**: Class with too many responsibilities
**Patterns**:
- **Repository Pattern**: Extract persistence
- **Service Pattern**: Extract business logic
- **Facade Pattern**: Keep simple interface, delegate to specialists

---

## Phase 3: Plan the Refactor

### Step 3.1: Use Sequential Thinking for Complex Decisions

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--process_thought`

Use when:
- Multiple valid patterns could apply (use `stage=Analysis`, branch for each pattern)
- Refactor affects multiple components (use `stage=Synthesis`)
- Risk assessment is non-trivial (track in `assumptions_challenged`)

> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--generate_summary`

Review reasoning before executing refactor.

### Step 3.2: Draft Explicit Plan

Before any edits, output:
```
REFACTOR PLAN:
- Target: [file:function/class]
- Smell: [description]
- Pattern: [chosen pattern and why]
- Steps:
  1. [specific change]
  2. [specific change]
  ...
- Risk: [low/medium/high] - [justification]
- Blast Radius: [N files, M call sites]
```

### Step 3.3: Scope Check

Ask yourself:
- Can this be done in ~30 minutes?
- Is the change behavior-preserving?
- Do I have enough context?

If NO to any: break into smaller refactors or gather more context.

---

## Phase 4: Execute Changes

### Step 4.1: Pre-Edit Verification

Use `search_files` to find ALL call sites of the target.
→ Ensure you know every place that needs updating

### Step 4.2: Apply Incrementally

- One coherent cluster of changes at a time
- After each cluster, ensure:
  - Imports are updated
  - Type hints are consistent
  - No broken references

### Step 4.3: Maintain Tool-Friendliness

- Keep functions/classes small and focused
- Use clear, consistent naming
- Prefer explicit over implicit

---

## Phase 5: Verify

### Step 5.1: Structural Verification

Use `search_files` to find any broken references to renamed/moved items.

### Step 5.2: SonarQube Re-check (if applicable)

> 📌 `inspect measures` → [`commands.inspect_measures`](../commands.toml)
> Resolves to: `mcp--sonarqube--get_component_measures`

Confirm complexity/smell metrics improved.

### Step 5.3: Quality Gates

> 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
> Composite: `format_ruff` → `check_ruff` → `check_mypy` → `test_pytest`
> All run through `bounded_gate.py` with receipt tracking.

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} refactor` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} refactor`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the refactor summary.

---

## Anti-Patterns to Avoid

❌ **Starting edits before understanding context**
   → Always run Phase 1 first

❌ **Skipping search for call sites**
   → `retrieve codebase` may miss some references; `search_files` finds ALL

❌ **Over-engineering the fix**
   → Apply the simplest pattern that solves the smell

❌ **Leaving stubs or TODO comments**
   → Either implement fully or don't change

❌ **Speculative abstraction**
   → Only add patterns that solve current problems

❌ **Silent fallbacks**
   → Prefer explicit failure over hidden degradation

---

## Quick Reference: Tool Selection

| Need | Command Route |
|------|---------------|
| Find SonarQube issues | `search issues` → [`commands.search_issues`](../commands.toml) |
| Understand code purpose | `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml) |
| Find ALL references | `search_files` (Kilo native tool) |
| Complex decision-making | `decompose task` → [`commands.decompose_task`](../commands.toml) |
| Verify issue resolved | `inspect measures` → [`commands.inspect_measures`](../commands.toml) |
| Run quality gates | `gate quality` → [`commands.gate_quality`](../commands.toml) |

---

## Example: Refactoring Cognitive Complexity

**Issue**: S3776 on `process_data()` with complexity 21 (allowed 15)

### Phase 1: Understand

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)

Query: "What does process_data do and what calls it?"
→ "Processes incoming events, validates, transforms, persists. Called by EventHandler and BatchProcessor."

### Phase 2: Map
- Smell: Cognitive complexity from nested conditionals + multiple responsibilities
- Pattern: **Extract Method** for validation/transform/persist + **Early Return** for validation failures

### Phase 3: Plan
```
REFACTOR PLAN:
- Target: events/processor.py:process_data
- Smell: Cognitive complexity 21 (3 interleaved responsibilities)
- Pattern: Extract Method + Early Return
- Steps:
  1. Extract _validate_event() with early return on failure
  2. Extract _transform_event()
  3. Extract _persist_event()
  4. Simplify process_data to orchestration only
- Risk: Low - each extraction is behavior-preserving
- Blast Radius: 1 file, 2 callers (signatures unchanged)
```

### Phase 4: Execute
- Apply each extraction one at a time
- Verify tests pass after each step

### Phase 5: Verify
- `search_files`: "process_data" → Confirm callers still work
- `inspect measures` → Complexity now 8 ✓
- `gate quality` → All 4 gates pass ✓

---

## Related Workflows

- [`/start-task`](./start-task.md) — Task preparation phase
- [`/execute-task`](./execute-task.md) — Task execution phase
- [`/fix-ci`](./fix-ci.md) — Quality gate fixes
- [`/respond-to-pr-review`](./respond-to-pr-review.md) — PR review response

## Related Skills

- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning
- [`sonarqube-ops`](../skills/sonarqube-ops/SKILL.md) — Code quality metrics
- [`context7-docs-ops`](../skills/context7-docs-ops/SKILL.md) — Library documentation

## Philosophy

Refactoring is behavior-preserving transformation, not feature work. Every tool invocation
maps to a `commands.toml` route. Every quality check uses `bounded_gate.py` with receipts.
Structure discipline: from smell detection to pattern mapping to verified completion.
