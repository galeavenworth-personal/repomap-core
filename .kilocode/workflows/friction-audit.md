---
description: Lightweight monolithic workflow to audit repomap ergonomics and cognitive friction from an agent-as-user perspective.
auto_execution_mode: 2
punch_card: friction-audit
---

# Friction Audit Workflow

**Purpose:** Fast, lightweight audit of repomap ergonomics and cognitive friction.

**Trigger:** User invokes `/friction-audit <focus-area>`

**Philosophy:** One agent, one pass. Capture friction points quickly with ranked impact.

**Punch Card:** `friction-audit` (5 rows, 4 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

---

## Overview

```
┌───────────────────────────────────────────────────────────────────┐
│  SINGLE AGENT (product-skeptic)                                  │
│  ├── Identify friction points                                    │
│  ├── Rank severity + evidence                                    │
│  ├── Propose minimal fixes                                       │
│  └── STOP: Present Friction Audit Report                         │
└───────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- product-skeptic mode available
- Focus area defined (e.g., "CLI entry point", "artifact queryability")

---

## Single-Agent Protocol

### Step 1: Initialize Todo List

```python
update_todo_list(
    todos="""
[ ] Runtime Model Report (record runtime model/mode)
[ ] Identify friction points
[ ] Rank severity + evidence
[ ] Propose minimal fixes
[ ] Present Friction Audit Report and STOP
"""
)
```

### Step 2: Runtime Model Report (MANDATORY)

Report `runtime_model_reported` and `runtime_mode_reported` from `environment_details`.

### Step 3: Audit Protocol

**Focus Area:** <focus-area>

**Required Perspective:** Agent-as-user. Evaluate the tool as a cognitive substrate.

**Audit Questions:**
1. Where does the tool require unnecessary state or ceremony?
2. What steps feel heavy or ambiguous?
3. What slows an agent's reasoning loop?
4. Which artifacts are hard to query or interpret?

**MANDATORY: Sequential Thinking Protocol**

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--process_thought`

```
decompose task: "Friction branch 1: [ceremony/state burden]"
  stage=Problem Definition, tags=[friction-audit]

decompose task: "Friction branch 2: [interpretation burden]"
  stage=Problem Definition, tags=[friction-audit]

decompose task: "Analysis: ranked friction points with evidence"
  stage=Analysis, tags=[friction-audit]
```

> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--generate_summary`

```
decompose task: "Conclusion: minimal fixes + expected impact"
  stage=Conclusion, tags=[friction-audit]
```

> 📌 `export session` → [`commands.export_session`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--export_session`

File path: `.kilocode/thinking/friction-audit-<YYYY-MM-DD>.json`

### Step 4: Present Friction Audit Report + STOP

```markdown
# Friction Audit Report: <focus-area>

## Ranked Friction Points
1. <friction-1> — Severity: <high/med/low> — Evidence: <evidence>
2. <friction-2> — Severity: <high/med/low> — Evidence: <evidence>
3. <friction-3> — Severity: <high/med/low> — Evidence: <evidence>

## Minimal Fixes (Smallest Moves)
1. <fix-1> — Expected impact: <impact>
2. <fix-2> — Expected impact: <impact>

## Session Export
- `.kilocode/thinking/friction-audit-<YYYY-MM-DD>.json`
```

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Identify friction points
[x] Rank severity + evidence
[x] Propose minimal fixes
[x] Present Friction Audit Report and STOP
"""
)
```

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id} --bead-id {bead_id}`

> 🚪 `checkpoint punch-card {task_id} friction-audit` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} friction-audit`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the audit report.

---

## Related Workflows

- [`/start-task`](./start-task.md) — Task preparation phase
- [`/execute-task`](./execute-task.md) — Task execution phase

## Related Modes

- **audit-orchestrator** — Full adversarial pressure test (multi-phase orchestrated)
- **process-orchestrator** — Task preparation and execution (multi-phase orchestrated)
- **product-skeptic** — The specialist mode that executes this audit

## Related Skills

- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning
- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search

## Philosophy

Friction audits are the fastest way to reduce cognitive entropy. Every reasoning step
routes through `commands.toml` — from sequential thinking to session export. Keep this
workflow light, frequent, and brutally honest. Structure discipline all the way down.
