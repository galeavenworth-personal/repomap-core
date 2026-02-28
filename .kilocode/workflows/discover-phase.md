---
description: Specialist child workflow for task discovery. Spawned by process-orchestrator in architect mode. Fetch task details, understand scope, gather strategic context.
auto_execution_mode: 3
punch_card: discover-phase
---

# Discover Phase (Specialist Child)

You are an **architect** child spawned by a process-orchestrator to perform task discovery.
Your job is bounded: understand the task, gather context, and return a structured summary.

**Punch Card:** `discover-phase` (5 rows, 3 required, 1 forbidden)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

**You must NOT spawn child tasks.** You are a Tier 3 specialist — you do the work yourself.

---

## Inputs (from parent handoff packet)

- `task_id` — the bead identifier
- `bead_id` — optional bead issue ID
- `objective` — what to discover
- `context_pointers` — file paths for background reading

---

## Step 1: Fetch Task Details

> 📌 `show issue {task-id}` → [`commands.show_issue`](../commands.toml)
> Resolves to: `.kilocode/tools/bd show {id}`

If the task has a parent epic, fetch that context too:

> 📌 `show issue {parent-id}` → [`commands.show_issue`](../commands.toml)

---

## Step 2: Semantic Codebase Discovery (MANDATORY)

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Query for:
- How does the feature/component mentioned in the task work?
- What are the architectural patterns around the task area?
- What are the key files and modules involved?

**Hard gate:** You MUST call `retrieve codebase` at least once.

---

## Step 3: Read Key Files (MANDATORY)

Use `read_file` to examine key files identified by retrieval (batch up to 5).

**Hard gate:** You MUST call `read_file` at least once.

---

## Step 4: Structured Output

Return via `attempt_completion` with this structure:

```markdown
## Discovery Summary

### Task Understanding
- What: [specific action required]
- Why: [strategic context from epic]
- Type: [bug fix | feature | refactor | investigation]

### Key Components
- [file/module 1]: [role in this task]
- [file/module 2]: [role in this task]

### Dependencies and Blockers
- [dependency 1]
- [blocker 1, if any]

### Scope Boundaries
- IN scope: [list]
- OUT of scope: [list]

### Evidence
- runtime_model_reported: [model]
- runtime_mode_reported: architect
```

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint auto`

> 🚪 `checkpoint punch-card {task_id} discover-phase` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint auto discover-phase`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the discovery summary.
