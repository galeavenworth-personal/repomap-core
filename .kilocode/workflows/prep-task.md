---
description: Branch-first task preparation protocol. Transform ambiguous requests into scoped, executable tasks through mandatory exploration, not linear analysis. Sequential thinking is the primary interface.
auto_execution_mode: 3
punch_card: prep-task
---

# Task Preparation Protocol

This workflow transforms user requests into executable tasks through **mandatory exploration**, not linear analysis. You must externalize reasoning, spend your branch budget, and reach Conclusion stage before implementation.

**Punch Card:** `prep-task` (5 rows, 4 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

**Core principle:** Generate candidates → Compare approaches → Commit to one path.

---

## Session Management (MANDATORY)

### Resuming Work

If this is a continuation of previous work:

> 📌 `import session` → [`commands.import_session`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--import_session`

File path: `.kilocode/thinking/[previous-session].json`

After importing:

> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--generate_summary`

Then continue reasoning:

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--process_thought`

```
decompose task: "Resuming: [context from summary]"
  stage=Problem Definition, tags=[session-resume]
```

**Hard gate:** If user says "continue" or "resume" and you don't call `import session`, you are violating protocol.

---

## The Branch-First Protocol

### Step 0: Sequential Thinking Protocol (MANDATORY)

Before proceeding with task preparation, you MUST externalize your reasoning through sequential thinking.

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--process_thought`

**Required actions:**
1. Create Problem Definition branch: State what you understand the task to be
2. If ambiguous, create 2+ interpretation branches
3. Spend your branch budget (minimum 2 branches for non-trivial tasks)
4. Reach Conclusion stage before proceeding to Phase 1

**Hard gate:** You may NOT proceed to Phase 1 without at least one `decompose task` call in your history.

**Example:**
```
decompose task: "Task interpretation: User wants to refactor X module for better testability"
  stage=Problem Definition, tags=[task-prep, refactoring]

decompose task: "Alternative interpretation: User wants to add tests to existing X module without refactoring"
  stage=Problem Definition, tags=[task-prep, testing]
  assumptions_challenged=[Refactoring is required]
```

### Phase 1: Problem Definition (Branch per Interpretation)

**Objective:** Generate 2-3 interpretations of the user's request. Spend your branch budget.

**Required actions:**

1. **Create interpretation branches** (minimum 2):

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Interpretation A: User wants [specific action on specific component]"
  stage=Problem Definition, tags=[interpretation, task-prep]

decompose task: "Interpretation B: User wants [alternative action or scope]"
  stage=Problem Definition, tags=[interpretation, task-prep]
  assumptions_challenged=[Assumption from interpretation A]
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

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Find relevant code, patterns, similar implementations.

Use `read_file` to read specific files identified by retrieval (batch up to 5).

> 📌 `resolve library` → [`commands.resolve_library`](../commands.toml)
> 📌 `query docs` → [`commands.query_docs`](../commands.toml)

Verify external library APIs.

Use `search_files` to find all references to components you'll modify.

**Document findings in thoughts:**

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Research for Interpretation A: Found 3 existing implementations in [files]. Pattern uses [approach]. Will require changes to [N] call sites."
  stage=Research, tags=[interpretation-a, context]
```

**Critical:** Always verify external library APIs with Context7. Training data is stale.

---

### Phase 3: Analysis (Generate Approach Candidates)

**Objective:** For the chosen interpretation, generate 2-3 implementation approaches.

**Required: Generate candidates** (simplest, safest, highest-leverage):

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Approach 1 (Simplest): [description]. Pros: [list]. Cons: [list]. Estimated effort: [X hours]."
  stage=Analysis, tags=[approach-candidate, simplest]

decompose task: "Approach 2 (Safest): [description]. Pros: [list]. Cons: [list]. Estimated effort: [X hours]."
  stage=Analysis, tags=[approach-candidate, safest]

decompose task: "Approach 3 (Highest-leverage): [description]. Pros: [list]. Cons: [list]. Estimated effort: [X hours]."
  stage=Analysis, tags=[approach-candidate, leverage]
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

> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--generate_summary`

**Check the summary output:**
- Do you have ≥2 branches in Problem Definition?
- Do you have ≥2 branches in Analysis?
- Have you documented assumptions and axioms?
- Is your branch budget spent?

2. **Document comparison:**

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Comparison: Approach 1 is simplest but doesn't handle [edge case]. Approach 2 is safest but 3x effort. Approach 3 provides best long-term value and handles [edge case] correctly. Recommend Approach 3."
  stage=Synthesis, tags=[comparison, decision-rationale]
```

**If summary shows insufficient exploration:** Go back and add more branches. Don't proceed with weak reasoning.

---

### Phase 5: Conclusion (Commit to Approach)

**Objective:** Make final decision with clear rationale and define success criteria.

**Required actions:**

1. **State decision:**

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Decision: Implementing Approach 3 (highest-leverage). Rationale: [specific reasons]. This approach handles [edge cases], aligns with [project conventions], and provides [future benefits]."
  stage=Conclusion, tags=[decision, approach-3]
  axioms_used=[Deterministic artifacts, Evidence-based claims]
```

2. **Define success criteria in the thought:**
   - Measurable outcomes ("All tests pass", "No new lint errors")
   - Specific behaviors ("Function returns Pydantic model, not dict")
   - Verification commands

   > 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
   > Composite: `format_ruff` → `check_ruff` → `check_mypy` → `test_pytest`

3. **Save session for future reference:**

> 📌 `export session` → [`commands.export_session`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--export_session`

File path: `.kilocode/thinking/refactor-{YYYY-MM-DD}-{brief-description}.json`

**MANDATORY:** You must call `export session` before proceeding to execution. This preserves your reasoning for future sessions.

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
│  ├── retrieve codebase             → commands.retrieve_codebase │
│  ├── read_file (key files, batch up to 5)                      │
│  └── resolve library / query docs  → commands.resolve_library   │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 2: PLAN                                                  │
│  ├── decompose task (≥2 interpretations)                        │
│  │                                 → commands.decompose_task    │
│  ├── summarize thinking            → commands.summarize_thinking│
│  └── update_todo_list (structure the work with clear subtasks) │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 3: EXECUTE (repeat per task)                            │
│  ├── update_todo_list (mark [-] in progress)                   │
│  ├── retrieve codebase             → commands.retrieve_codebase │
│  ├── apply_diff or edit_file (make targeted changes)           │
│  ├── retrieve codebase (find ALL downstream impacts)           │
│  ├── apply_diff or edit_file (update call sites and tests)     │
│  └── update_todo_list (mark [x] complete)                      │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 4: VERIFY                                                │
│  └── gate quality                  → commands.gate_quality      │
├─────────────────────────────────────────────────────────────────┤
│  EXIT GATE: PUNCH CARD CHECKPOINT                               │
│  ├── mint punches {task_id}        → commands.punch_mint        │
│  ├── checkpoint punch-card {task_id} prep-task                  │
│  │                                 → commands.punch_checkpoint  │
│  └── MUST PASS — blocks attempt_completion on failure           │
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
- **Layered architecture** — Respect layer boundaries defined in [`repomap.toml`](../../repomap.toml)
- **Deterministic artifacts** — Same input → same output, always
- **Evidence-based claims** — Every claim backed by verifiable evidence
- **Virtual environment mandate** — ALWAYS use `.venv/bin/python -m ...`

### Testing Strategy
- **Pytest markers** — Use `@pytest.mark.live` for tests requiring external services
- **Update existing tests** — Don't create new test files unless explicitly requested
- **Quality gates** — All must pass via `gate quality`

### State Management
- **Artifacts in `.repomap/`** — Generated artifacts stored here
- **Canonical claims** — `repomap_claims.jsonl` tracked in git
- **Experimental claims** — `docs/experiments/claims-archive/` for analysis

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} prep-task` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} prep-task`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the prepared task.

---

## Example: Transforming a Vague Request

### Before (Vague)
> "Fix the memory bug"

### After Applying the Protocol

**Phase 1 — Problem Definition:**

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Interpretation 1: Memory leak in artifact storage causing disk space issues"
  stage=Problem Definition, tags=[interpretation, memory]

decompose task: "Interpretation 2: Claims not being garbage collected, causing RAM issues"
  stage=Problem Definition, tags=[interpretation, memory]
  assumptions_challenged=[Issue is disk-related]
```

**Phase 2 — Research:**

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)

Used to find artifact-related code in `artifact_store.py`, `io.py`, and `write.py`.

**Phase 3 — Analysis:**
Generated 3 approaches: fix leak, add cleanup, implement LRU cache

**Phase 4 — Synthesis:**

> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)

Verified 2 interpretations, 3 approaches explored.

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Comparison: Approach 1 (fix leak) is simplest and addresses root cause. Approach 2 (cleanup) is workaround. Approach 3 (LRU) is over-engineering. Recommend Approach 1."
  stage=Synthesis, tags=[comparison]
```

**Phase 5 — Conclusion:**

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Decision: Fix artifact storage leak in artifact_store.py. Add proper file handle cleanup. Success criteria: No open file handles after write, pytest passes, no disk space growth."
  stage=Conclusion, tags=[decision]
  axioms_used=[Fail hard, not silently]
```

> 📌 `export session` → [`commands.export_session`](../commands.toml)

File path: `.kilocode/thinking/fix-artifact-leak-{YYYY-MM-DD}.json`

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
- [ ] `summarize thinking` called to verify exploration

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

| Phase | Primary Commands |
|-------|-----------------|
| 0. Sequential Thinking | `decompose task` → `commands.decompose_task`, `summarize thinking` → `commands.summarize_thinking`, `export session` → `commands.export_session` |
| 1. Problem Definition | `decompose task` (branching), `retrieve codebase` → `commands.retrieve_codebase` |
| 2. Research | `retrieve codebase`, `read_file`, `resolve library` → `commands.resolve_library`, `query docs` → `commands.query_docs` |
| 3. Analysis | `decompose task` (approach candidates) |
| 4. Synthesis | `summarize thinking`, `decompose task` (comparison) |
| 5. Conclusion | `decompose task` (decision), `export session` |

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

> 📌 `resolve library` → [`commands.resolve_library`](../commands.toml)
> Resolves to: `mcp--context7--resolve___library___id`

> 📌 `query docs` → [`commands.query_docs`](../commands.toml)
> Resolves to: `mcp--context7--query___docs`

If context insufficient, refine query or paginate.

### Integration with Execution Pattern

Context7 calls should happen in **Phase 2 (Research)**:

```
┌─────────────────────────────────────────────────────────────────┐
│  LIBRARY-AWARE RESEARCH                                         │
│  ├── Identify external imports in target code                   │
│  ├── resolve library               → commands.resolve_library   │
│  ├── query docs                    → commands.query_docs        │
│  ├── decompose task (document findings)                         │
│  │                                 → commands.decompose_task    │
│  └── THEN proceed to Analysis phase                             │
└─────────────────────────────────────────────────────────────────┘
```

### Anti-Patterns to Avoid

- ❌ **Guessing API signatures** from memory or training data
- ❌ **Assuming library behavior** without verification
- ❌ **Debugging for hours** when the issue is outdated API usage
- ❌ **Copy-pasting old code patterns** without checking if they're still valid
- ✅ **Verify first, code second** — 30 seconds of Context7 saves hours of debugging

---

## Related Workflows

- [`/start-task`](./start-task.md) — Meta-workflow that calls this as Phase 3
- [`/execute-task`](./execute-task.md) — Implementation phase (after approval)
- [`/codebase-exploration`](./codebase-exploration.md) — Deep dive into code structure

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
