---
description: Branch-first task preparation protocol. Transform ambiguous requests into scoped, executable tasks through mandatory exploration, not linear analysis. Sequential thinking is the primary interface.
auto_execution_mode: 3
---

# Task Preparation Protocol

This workflow transforms user requests into executable tasks through **mandatory exploration**, not linear analysis. You must externalize reasoning, spend your branch budget, and reach Conclusion stage before implementation.

**Core principle:** Generate candidates → Compare approaches → Commit to one path.

---

## Session Management (MANDATORY)

### Resuming Work

If this is a continuation of previous work:

```python
# MANDATORY: Load previous session
import_session(file_path=".kilocode/thinking/[previous-session].json")

# Review what was decided
generate_summary()

# Continue reasoning from where you left off
process_thought(
    thought="Resuming: [context from summary]",
    thought_number=1,
    total_thoughts=1,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["session-resume"]
)
```

**Hard gate:** If user says "continue" or "resume" and you don't call `import_session`, you are violating protocol.

---

## The Branch-First Protocol

### Step 0: Sequential Thinking Protocol (MANDATORY)

Before proceeding with task preparation, you MUST externalize your reasoning through sequential thinking.

**Required actions:**
1. Create Problem Definition branch: State what you understand the task to be
2. If ambiguous, create 2+ interpretation branches
3. Spend your branch budget (minimum 2 branches for non-trivial tasks)
4. Reach Conclusion stage before proceeding to Phase 1

**Hard gate:** You may NOT proceed to Phase 1 without at least one `process_thought` call in your history.

**Example:**
```python
process_thought(
    thought="Task interpretation: User wants to refactor X module for better testability",
    thought_number=1,
    total_thoughts=2,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["task-prep", "refactoring"]
)

process_thought(
    thought="Alternative interpretation: User wants to add tests to existing X module without refactoring",
    thought_number=2,
    total_thoughts=2,
    next_thought_needed=False,
    stage="Problem Definition",
    tags=["task-prep", "testing"],
    assumptions_challenged=["Refactoring is required"]
)
```
### Phase 1: Problem Definition (Branch per Interpretation)

**Objective:** Generate 2-3 interpretations of the user's request. Spend your branch budget.

**Required actions:**

1. **Create interpretation branches** (minimum 2):

```python
process_thought(
    thought="Interpretation A: User wants [specific action on specific component]",
    thought_number=1,
    total_thoughts=5,  # Estimate total
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["interpretation", "task-prep"]
)

process_thought(
    thought="Interpretation B: User wants [alternative action or scope]",
    thought_number=2,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["interpretation", "task-prep"],
    assumptions_challenged=["Assumption from interpretation A"]
)
```

2. **If still ambiguous after branching, ask user:**
   - Present the interpretations you've generated
   - Ask which one matches their intent
   - Document their answer in a new thought

**Triggers for asking user:**
- Security/data integrity implications differ between interpretations
- Estimated effort differs by >2x between interpretations
- Interpretations touch different architectural layers

**Hard gate:** You may NOT proceed to Phase 2 without at least 2 interpretation branches.

---

### Phase 2: Research (Gather Context per Branch)

**Objective:** For each viable interpretation, gather the context needed to evaluate feasibility.

**Tools (run in parallel per interpretation):**
- `codebase-retrieval` — Find relevant code, patterns, similar implementations
- `read_file` — Read specific files identified by retrieval
- `resolve-library-id` + `query-docs` — Verify external library APIs
- `search_files` — Find all references to components you'll modify

**Document findings in thoughts:**

```python
process_thought(
    thought="Research for Interpretation A: Found 3 existing implementations in [files]. Pattern uses [approach]. Will require changes to [N] call sites.",
    thought_number=3,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Research",
    tags=["interpretation-a", "context"]
)
```

**Critical:** Always verify external library APIs with Context7. Training data is stale.

---

### Phase 3: Analysis (Generate Approach Candidates)

**Objective:** For the chosen interpretation, generate 2-3 implementation approaches.

**Required: Generate candidates** (simplest, safest, highest-leverage):

```python
process_thought(
    thought="Approach 1 (Simplest): [description]. Pros: [list]. Cons: [list]. Estimated effort: [X hours].",
    thought_number=4,
    total_thoughts=7,
    next_thought_needed=True,
    stage="Analysis",
    tags=["approach-candidate", "simplest"]
)

process_thought(
    thought="Approach 2 (Safest): [description]. Pros: [list]. Cons: [list]. Estimated effort: [X hours].",
    thought_number=5,
    total_thoughts=7,
    next_thought_needed=True,
    stage="Analysis",
    tags=["approach-candidate", "safest"]
)

process_thought(
    thought="Approach 3 (Highest-leverage): [description]. Pros: [list]. Cons: [list]. Estimated effort: [X hours].",
    thought_number=6,
    total_thoughts=7,
    next_thought_needed=True,
    stage="Analysis",
    tags=["approach-candidate", "leverage"]
)
```

**Each approach must include:**
- Concrete implementation strategy
- Pros and cons
- Estimated effort
- Risk assessment (security, data integrity, breaking changes)
- Downstream impact (how many files/tests affected)

**Hard gate:** You may NOT proceed to Phase 4 without at least 2 approach candidates.

---

### Phase 4: Synthesis (Compare and Verify)

**Objective:** Explicitly compare approaches and verify you've explored sufficiently.

**Required actions:**

1. **Generate summary to verify exploration:**

```python
generate_summary()
```

**Check the summary output:**
- Do you have ≥2 branches in Problem Definition?
- Do you have ≥2 branches in Analysis?
- Have you documented assumptions and axioms?
- Is your branch budget spent?

2. **Document comparison:**

```python
process_thought(
    thought="Comparison: Approach 1 is simplest but doesn't handle [edge case]. Approach 2 is safest but 3x effort. Approach 3 provides best long-term value and handles [edge case] correctly. Recommend Approach 3.",
    thought_number=7,
    total_thoughts=8,
    next_thought_needed=True,
    stage="Synthesis",
    tags=["comparison", "decision-rationale"]
)
```

**If summary shows insufficient exploration:** Go back and add more branches. Don't proceed with weak reasoning.

---

### Phase 5: Conclusion (Commit to Approach)

**Objective:** Make final decision with clear rationale and define success criteria.

**Required actions:**

1. **State decision:**

```python
process_thought(
    thought="Decision: Implementing Approach 3 (highest-leverage). Rationale: [specific reasons]. This approach handles [edge cases], aligns with [project conventions], and provides [future benefits].",
    thought_number=8,
    total_thoughts=8,
    next_thought_needed=False,
    stage="Conclusion",
    tags=["decision", "approach-3"],
    axioms_used=["Deterministic artifacts", "Evidence-based claims"]
)
```

2. **Define success criteria in the thought:**
   - Measurable outcomes ("All tests pass", "No new lint errors")
   - Specific behaviors ("Function returns Pydantic model, not dict")
    - Verification commands (".venv/bin/python -m pytest -q", ".venv/bin/python -m ruff check .")

3. **Save session for future reference:**

```python
export_session(file_path=".kilocode/thinking/refactor-2026-01-21-module-x.json")
```

**MANDATORY:** You must call `export_session` before proceeding to execution. This preserves your reasoning for future sessions.

---

## Scope Discipline

**Anti-patterns to avoid:**
- ❌ Creating `*.md` files unless explicitly requested
- ❌ Adding "nice to have" features beyond the request
- ❌ Creating new test files (update existing tests instead)
- ❌ Improving user-provided code samples without permission

**Required behaviors:**
- ✅ Find ALL downstream changes after edits
- ✅ Update affected call sites and tests
- ✅ Preserve user code samples verbatim
- ✅ Verify external library APIs with Context7

---

## Execution Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1: UNDERSTAND (parallel tool calls)                     │
│  ├── codebase-retrieval × N (architecture, patterns, related)  │
│  ├── read_file (key files, batch up to 5)                      │
│  └── resolve-library-id + query-docs (for dependencies)        │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 2: PLAN                                                  │
│  ├── process_thought (decompose, define success criteria)      │
│  ├── generate_summary (review reasoning before proceeding)     │
│  └── update_todo_list (structure the work with clear subtasks) │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 3: EXECUTE (repeat per task)                            │
│  ├── update_todo_list (mark [-] in progress)                   │
│  ├── codebase-retrieval (verify signatures before each edit)   │
│  ├── apply_diff or edit_file (make targeted changes)           │
│  ├── codebase-retrieval (find ALL downstream impacts)          │
│  ├── apply_diff or edit_file (update call sites and tests)     │
│  └── update_todo_list (mark [x] complete)                      │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 4: VERIFY                                                │
│  ├── execute_command: .venv/bin/python -m ruff format --check  │
│  ├── execute_command: .venv/bin/python -m ruff check           │
│  ├── execute_command: .venv/bin/python -m mypy src             │
│  └── execute_command: .venv/bin/python -m pytest -q            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Repomap-Specific Conventions

During **Phase 5**, verify alignment with these project patterns:

### Data Structures
- **Pydantic models for validation** — Use Pydantic for all data models
- **Type hints required** — All function signatures must be typed
- **JSONL for artifacts** — Use JSONL format for serialization

### Architecture Patterns
- **Layered architecture** — Respect layer boundaries defined in `repomap.toml`
- **Deterministic artifacts** — Same input → same output, always
- **Evidence-based claims** — Every claim backed by verifiable evidence
- **Virtual environment mandate** — ALWAYS use `.venv/bin/python -m ...`

### Testing Strategy
- **Pytest markers** — Use `@pytest.mark.live` for tests requiring external services
- **Update existing tests** — Don't create new test files unless explicitly requested
- **Quality gates** — ruff format, ruff check, mypy, pytest must all pass

### State Management
- **Artifacts in `.repomap/`** — Generated artifacts stored here
- **Canonical claims** — `repomap_claims.jsonl` tracked in git
- **Experimental claims** — `docs/experiments/claims-archive/` for analysis

---

## Example: Transforming a Vague Request

### Before (Vague)
> "Fix the memory bug"

### After Applying the Protocol

**Phase 1 — Problem Definition:**
```python
process_thought(
    thought="Interpretation 1: Memory leak in artifact storage causing disk space issues",
    thought_number=1,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["interpretation", "memory"]
)

process_thought(
    thought="Interpretation 2: Claims not being garbage collected, causing RAM issues",
    thought_number=2,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["interpretation", "memory"],
    assumptions_challenged=["Issue is disk-related"]
)
```

**Phase 2 — Research:**
Used `codebase-retrieval` to find artifact-related code in `artifact_store.py`, `io.py`, and `write.py`.

**Phase 3 — Analysis:**
Generated 3 approaches: fix leak, add cleanup, implement LRU cache

**Phase 4 — Synthesis:**
```python
generate_summary()  # Verified 2 interpretations, 3 approaches explored

process_thought(
    thought="Comparison: Approach 1 (fix leak) is simplest and addresses root cause. Approach 2 (cleanup) is workaround. Approach 3 (LRU) is over-engineering. Recommend Approach 1.",
    thought_number=5,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Synthesis",
    tags=["comparison"]
)
```

**Phase 5 — Conclusion:**
```python
process_thought(
    thought="Decision: Fix artifact storage leak in artifact_store.py. Add proper file handle cleanup. Success criteria: No open file handles after write, pytest passes, no disk space growth.",
    thought_number=6,
    total_thoughts=6,
    next_thought_needed=False,
    stage="Conclusion",
    tags=["decision"],
    axioms_used=["Fail hard, not silently"]
)

export_session(file_path=".kilocode/thinking/fix-artifact-leak-2026-01-21.json")
```

---

## Success Criteria Checklist

Before beginning implementation, verify all phases are complete:

```markdown
## Pre-Implementation Checklist

### Understanding
- [ ] At least 2 interpretation branches created
- [ ] Relevant architecture and patterns reviewed
- [ ] External library APIs verified with Context7

### Planning
- [ ] At least 2 approach candidates generated
- [ ] Success criteria defined with measurable outcomes
- [ ] generate_summary called to verify exploration

### Validation
- [ ] Conclusion stage reached with clear decision
- [ ] Alignment with project conventions confirmed
- [ ] Session exported for future reference

### Preservation
- [ ] User-provided code samples preserved verbatim
- [ ] No unsolicited documentation planned
- [ ] No new files unless explicitly required
```

---

## Quick Reference: Tool by Phase

| Phase | Primary Tools |
|-------|---------------|
| 0. Sequential Thinking | `process_thought`, `generate_summary`, `export_session` |
| 1. Problem Definition | `process_thought` (branching), `codebase-retrieval` |
| 2. Research | `codebase-retrieval`, `read_file`, `resolve-library-id` + `query-docs` |
| 3. Analysis | `process_thought` (approach candidates) |
| 4. Synthesis | `generate_summary`, `process_thought` (comparison) |
| 5. Conclusion | `process_thought` (decision), `export_session` |

---

## Context7 Integration

Context7 provides up-to-date documentation for third-party libraries. **This is critical**—LLM training data is often stale, and library APIs change. Using Context7 prevents fighting against libraries by ensuring you use them as intended.

### When to Use Context7

**Always use Context7 when:**
- Writing new code that imports any external library
- Debugging errors that might be API misuse
- Implementing patterns from a framework
- Upgrading or changing library versions
- Unsure about correct method signatures, parameters, or return types

**Key Repomap dependencies requiring Context7 verification:**
- `tree-sitter` — Language parsers, query syntax, node traversal
- `pydantic` — Model validation, serialization patterns
- `typer` — CLI framework, command decorators, parameter types
- `langchain` — LLM orchestration (experimental / out-of-scope for repomap-core)
- `weaviate-client` — Vector search, collections (optional)
- `pytest` — Fixtures, markers, parametrization

### Context7 Workflow

```
1. resolve-library-id("library-name")
   → Returns Context7-compatible library ID

2. query-docs(libraryID, query="specific-feature")
   → Returns current API reference and code examples

3. If context insufficient, refine query or paginate
```

### Integration with Execution Pattern

Context7 calls should happen in **Phase 2 (Research)**:

```
┌─────────────────────────────────────────────────────────────────┐
│  LIBRARY-AWARE RESEARCH                                         │
│  ├── Identify external imports in target code                   │
│  ├── resolve-library-id for each dependency                     │
│  ├── query-docs for relevant APIs                               │
│  ├── Document findings in process_thought                       │
│  └── THEN proceed to Analysis phase                             │
└─────────────────────────────────────────────────────────────────┘
```

### Anti-Patterns to Avoid

- ❌ **Guessing API signatures** from memory or training data
- ❌ **Assuming library behavior** without verification
- ❌ **Debugging for hours** when the issue is outdated API usage
- ❌ **Copy-pasting old code patterns** without checking if they're still valid
- ✅ **Verify first, code second** — 30 seconds of Context7 saves hours of debugging
