---
description: Lightweight monolithic workflow to audit repomap ergonomics and cognitive friction from an agent-as-user perspective.
auto_execution_mode: 2
---

# Friction Audit Workflow

**Purpose:** Fast, lightweight audit of repomap ergonomics and cognitive friction.

**Trigger:** User invokes `/friction-audit <focus-area>`

**Philosophy:** One agent, one pass. Capture friction points quickly with ranked impact.

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
- Focus area defined (e.g., “CLI entry point”, “artifact queryability”)

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
3. What slows an agent’s reasoning loop?
4. Which artifacts are hard to query or interpret?

**MANDATORY: Sequential Thinking Protocol**

```python
mcp--sequentialthinking--process_thought(
    thought="Friction branch 1: [ceremony/state burden]",
    thought_number=1,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["friction-audit"]
)

mcp--sequentialthinking--process_thought(
    thought="Friction branch 2: [interpretation burden]",
    thought_number=2,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["friction-audit"]
)

mcp--sequentialthinking--process_thought(
    thought="Analysis: ranked friction points with evidence",
    thought_number=3,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Analysis",
    tags=["friction-audit"]
)

mcp--sequentialthinking--generate_summary()

mcp--sequentialthinking--process_thought(
    thought="Conclusion: minimal fixes + expected impact",
    thought_number=4,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["friction-audit"]
)

mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/friction-audit-<YYYY-MM-DD>.json"
)
```

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

**Use `attempt_completion` to present the report and wait for user approval.**

---

## Related Modes

- **audit-orchestrator** — Full adversarial pressure test (multi-phase orchestrated)
- **process-orchestrator** — Task preparation and execution (multi-phase orchestrated)

---

## Philosophy

Friction audits are the fastest way to reduce cognitive entropy. Keep this workflow light, frequent, and brutally honest.
