---
description: Specialist child workflow for codebase exploration. Spawned by process-orchestrator in architect mode. Deep structural and semantic analysis of code relevant to the task.
auto_execution_mode: 3
punch_card: explore-phase
---

# Explore Phase (Specialist Child)

You are an **architect** child spawned by a process-orchestrator to perform codebase exploration.
Your job is bounded: gather comprehensive structural and semantic context about the code
involved in this task, then return a structured analysis.

**Punch Card:** `explore-phase` (4 rows, 2 required, 1 forbidden)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

**You must NOT spawn child tasks.** You are a Tier 3 specialist — you do the work yourself.

---

## Inputs (from parent handoff packet)

- `task_id` — the bead identifier
- `discovery_summary` — output from discover-phase child
- `key_components` — files/modules identified during discovery
- `objective` — what to explore in depth

---

## Step 1: Semantic Understanding (MANDATORY)

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Query for:
- How does each key component interact with others?
- What are the call chains and data flows?
- What tests exist for the components being modified?
- What are the downstream consumers of APIs being changed?

**Hard gate:** You MUST call `retrieve codebase` at least once.

---

## Step 2: Structural Analysis

Use `read_file` to examine implementation details of key files (batch up to 5).
Use `search_files` to find all references to components that will be modified.

---

## Step 3: Library Documentation (if external deps involved)

> 📌 `resolve library` → [`commands.resolve_library`](../commands.toml)
> 📌 `query docs` → [`commands.query_docs`](../commands.toml)

Verify external library APIs. Training data is stale.

---

## Step 4: Structured Output

Return via `attempt_completion` with this structure:

```markdown
## Exploration Summary

### Architecture Map
- [component 1] → [component 2]: [relationship]
- [component 2] → [component 3]: [relationship]

### Code Patterns Found
- Pattern: [name] in [files]
- Convention: [description]

### Test Coverage
- [test file 1]: covers [components]
- [test file 2]: covers [components]
- Gaps: [untested areas]

### Impact Analysis
- Direct changes: [files that need editing]
- Downstream impacts: [files with call sites to update]
- Test updates: [test files to modify]

### Constraints
- Layer boundaries: [from repomap.toml]
- API contracts: [verified via Context7]

### Evidence
- runtime_model_reported: [model]
- runtime_mode_reported: architect
```

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} explore-phase` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} explore-phase`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the exploration summary.
