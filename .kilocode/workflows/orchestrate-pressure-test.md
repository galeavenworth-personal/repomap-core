---
description: Orchestrator-based adversarial reasoning workflow to pressure-test repomap's identity, ergonomics, and leverage with explicit role-based subtasks.
auto_execution_mode: 3
---

> **📚 Reference Documentation**
>
> This document is reference documentation. The Audit Orchestrator mode
> (`audit-orchestrator` in `.kilocodemodes`) embeds this logic natively.
> Do not load this file at runtime—use the Audit Orchestrator mode directly.

# Orchestrate Pressure Test Workflow

**Purpose:** Adversarial orchestration that stress tests repomap’s identity (“why use this tool?”), ergonomics (“where is the friction?”), and leverage (“what’s the narrowest high-impact move?”).

**Trigger:** User invokes `/orchestrate-pressure-test <focus-area>`

**Philosophy:** Parent = foreman, subtasks = adversarial roles, session exports = inspectable cognition. This workflow **does not** implement features. It produces pressure-tested recommendations.

---

## Overview

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```
┌───────────────────────────────────────────────────────────────────┐
│  PARENT (Orchestrator Mode)                                       │
│  ├── Subtask A (product-skeptic): Identity Attack                 │
│  ├── Subtask B (product-skeptic): Friction Audit                  │
│  ├── Subtask C (product-skeptic): Surface Minimization            │
│  ├── Subtask D (architect): Leverage Hunter                       │
│  ├── Subtask E (architect): Synthesis + Recommendations           │
│  └── STOP: Present Pressure Test Report                           │
└───────────────────────────────────────────────────────────────────┘
```

**Key Benefits:**
- **Adversarial coverage**: multiple roles attack the system from different angles
- **Inspectable cognition**: sequential thinking exports preserve reasoning
- **Structural clarity**: outputs focus on leverage, friction, and identity
- **Actionable outputs**: ranked recommendations with explicit tradeoffs

---

## Prerequisites

- Orchestrator mode available
- Sequential thinking MCP server connected
- Focus area defined (e.g., “onboarding ergonomics”, “artifact queryability”)

---

## Parent Task: Orchestration

> ⚙️ **Handled natively by Audit Orchestrator mode.**

### Step 0: Runtime Model Report (MANDATORY)

> ⚙️ **Handled natively by Audit Orchestrator mode.**

Report the runtime model/mode from `environment_details` in parent + every subtask.

### Step 1: Initialize Todo List

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
update_todo_list(
    todos="""
[ ] Runtime Model Report (record runtime model/mode)
[ ] Subtask A: Identity Attack (product-skeptic)
[ ] Subtask B: Friction Audit (product-skeptic)
[ ] Subtask C: Surface Minimization (product-skeptic)
[ ] Subtask D: Leverage Hunt (architect)
[ ] Subtask E: Synthesis (architect)
[ ] Present Pressure Test Report and STOP
"""
)
```

### Step 2: Spawn Identity Attack Subtask

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
new_task(
    mode="product-skeptic",
    message="""
# Identity Attack Subtask

**Objective:** Argue why repomap should *not* be used. Attack its identity and value proposition.

**Focus Area:** <focus-area>

**Required Perspective:** Adversarial. Assume you want to disprove the tool’s inevitability.

**Questions:**
1. Why would I *not* use repomap?
2. What does it fail to collapse? (ambiguity it does *not* resolve)
3. Where does it produce data without meaning?
4. Where does determinism fail to pay off?

**MANDATORY: Sequential Thinking Protocol**

Use sequential thinking. Minimum 2 branches (interpretations) + 2 approaches (attack vectors).

```python
mcp--sequentialthinking--process_thought(
    thought="Identity attack vector 1: [argument against adoption]",
    thought_number=1,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["pressure-test", "identity"]
)

mcp--sequentialthinking--process_thought(
    thought="Identity attack vector 2: [alternative argument]",
    thought_number=2,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["pressure-test", "identity"]
)

mcp--sequentialthinking--process_thought(
    thought="Attack approach A: [reasoning path]",
    thought_number=3,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Analysis",
    tags=["pressure-test", "identity"]
)

mcp--sequentialthinking--process_thought(
    thought="Attack approach B: [reasoning path]",
    thought_number=4,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Analysis",
    tags=["pressure-test", "identity"]
)

mcp--sequentialthinking--generate_summary()

mcp--sequentialthinking--process_thought(
    thought="Conclusion: strongest identity critique and evidence",
    thought_number=5,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["pressure-test", "identity"]
)

mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/pressure-test-identity-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- `runtime_model_reported`
- `runtime_mode_reported`
- Strongest identity critiques (ranked)
- Evidence or examples (if available)
- Exported session path

**Completion:**
Use `attempt_completion` with a structured Identity Attack report.
""",
    todos=None
)
```

### Step 3: Update Progress

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Identity Attack (product-skeptic)
[-] Subtask B: Friction Audit (product-skeptic)
[ ] Subtask C: Surface Minimization (product-skeptic)
[ ] Subtask D: Leverage Hunt (architect)
[ ] Subtask E: Synthesis (architect)
[ ] Present Pressure Test Report and STOP
"""
)
```

### Step 4: Spawn Friction Audit Subtask

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
new_task(
    mode="product-skeptic",
    message="""
# Friction Audit Subtask

**Objective:** Identify cognitive and workflow friction for agents using repomap.

**Focus Area:** <focus-area>

**Required Perspective:** Agent-as-user. Examine the tool as a cognitive substrate.

**Questions:**
1. Where does the tool require unnecessary state or ceremony?
2. What steps feel heavy or ambiguous?
3. What slows an agent’s reasoning loop?
4. Which artifacts are hard to query or interpret?

**MANDATORY: Sequential Thinking Protocol**

Use sequential thinking. Minimum 2 branches (friction types) + 2 approaches (audit angles).

```python
mcp--sequentialthinking--process_thought(
    thought="Friction type 1: [ceremony/state burden]",
    thought_number=1,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["pressure-test", "friction"]
)

mcp--sequentialthinking--process_thought(
    thought="Friction type 2: [interpretation burden]",
    thought_number=2,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["pressure-test", "friction"]
)

mcp--sequentialthinking--process_thought(
    thought="Audit angle A: [artifact usability]",
    thought_number=3,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Analysis",
    tags=["pressure-test", "friction"]
)

mcp--sequentialthinking--process_thought(
    thought="Audit angle B: [workflow entry points]",
    thought_number=4,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Analysis",
    tags=["pressure-test", "friction"]
)

mcp--sequentialthinking--generate_summary()

mcp--sequentialthinking--process_thought(
    thought="Conclusion: ranked friction points with evidence",
    thought_number=5,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["pressure-test", "friction"]
)

mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/pressure-test-friction-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- `runtime_model_reported`
- `runtime_mode_reported`
- Ranked friction points (severity + rationale)
- Suggested friction reductions
- Exported session path

**Completion:**
Use `attempt_completion` with a structured Friction Audit report.
""",
    todos=None
)
```

### Step 5: Update Progress

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Identity Attack (product-skeptic)
[x] Subtask B: Friction Audit (product-skeptic)
[-] Subtask C: Surface Minimization (product-skeptic)
[ ] Subtask D: Leverage Hunt (architect)
[ ] Subtask E: Synthesis (architect)
[ ] Present Pressure Test Report and STOP
"""
)
```

### Step 6: Spawn Surface Minimization Subtask

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
new_task(
    mode="product-skeptic",
    message="""
# Surface Minimization Subtask

**Objective:** Identify what can be removed without loss of core capability.

**Focus Area:** <focus-area>

**Required Perspective:** Minimalist. Reduce surface area and decision points.

**Questions:**
1. What commands, artifacts, or outputs are redundant?
2. What can be removed to make the tool more inevitable?
3. Which options increase cognitive surface without increasing leverage?

**MANDATORY: Sequential Thinking Protocol**

Use sequential thinking. Minimum 2 branches (removal candidates) + 2 approaches (minimization angles).

```python
mcp--sequentialthinking--process_thought(
    thought="Removal candidate set 1: [commands/artifacts to remove]",
    thought_number=1,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["pressure-test", "minimization"]
)

mcp--sequentialthinking--process_thought(
    thought="Removal candidate set 2: [alternative removals]",
    thought_number=2,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["pressure-test", "minimization"]
)

mcp--sequentialthinking--process_thought(
    thought="Minimization angle A: [surface area reduction path]",
    thought_number=3,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Analysis",
    tags=["pressure-test", "minimization"]
)

mcp--sequentialthinking--process_thought(
    thought="Minimization angle B: [alternative reduction path]",
    thought_number=4,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Analysis",
    tags=["pressure-test", "minimization"]
)

mcp--sequentialthinking--generate_summary()

mcp--sequentialthinking--process_thought(
    thought="Conclusion: ranked removals with impact analysis",
    thought_number=5,
    total_thoughts=6,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["pressure-test", "minimization"]
)

mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/pressure-test-minimize-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- `runtime_model_reported`
- `runtime_mode_reported`
- Ranked removals with expected impact
- Risk analysis for each removal
- Exported session path

**Completion:**
Use `attempt_completion` with a structured Surface Minimization report.
""",
    todos=None
)
```

### Step 7: Update Progress

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Identity Attack (product-skeptic)
[x] Subtask B: Friction Audit (product-skeptic)
[x] Subtask C: Surface Minimization (product-skeptic)
[-] Subtask D: Leverage Hunt (architect)
[ ] Subtask E: Synthesis (architect)
[ ] Present Pressure Test Report and STOP
"""
)
```

### Step 8: Spawn Leverage Hunt Subtask

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
new_task(
    mode="architect",
    message="""
# Leverage Hunt Subtask

**Objective:** Identify the narrowest high-leverage move that increases repomap’s inevitability.

**Context:**
<paste-identity-attack-summary>
<paste-friction-audit-summary>
<paste-surface-minimization-summary>

**Required Perspective:** Systems engineer. Favor structural clarity and deterministic wins.

**Questions:**
1. What single change increases value density 10×?
2. Where does determinism pay off most?
3. Which artifact or entry point is the choke point for ambiguity collapse?

**MANDATORY: Sequential Thinking Protocol**

Use sequential thinking. Minimum 2 approaches.

```python
mcp--sequentialthinking--process_thought(
    thought="Leverage approach A: [narrowest move]",
    thought_number=1,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Analysis",
    tags=["pressure-test", "leverage"]
)

mcp--sequentialthinking--process_thought(
    thought="Leverage approach B: [alternative narrow move]",
    thought_number=2,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Analysis",
    tags=["pressure-test", "leverage"]
)

mcp--sequentialthinking--generate_summary()

mcp--sequentialthinking--process_thought(
    thought="Conclusion: selected leverage move with rationale",
    thought_number=3,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["pressure-test", "leverage"]
)

mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/pressure-test-leverage-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- `runtime_model_reported`
- `runtime_mode_reported`
- Selected leverage move + rationale
- Alternatives considered
- Exported session path

**Completion:**
Use `attempt_completion` with a structured Leverage Hunt report.
""",
    todos=None
)
```

### Step 9: Update Progress

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Identity Attack (product-skeptic)
[x] Subtask B: Friction Audit (product-skeptic)
[x] Subtask C: Surface Minimization (product-skeptic)
[x] Subtask D: Leverage Hunt (architect)
[-] Subtask E: Synthesis (architect)
[ ] Present Pressure Test Report and STOP
"""
)
```

### Step 10: Spawn Synthesis Subtask

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
new_task(
    mode="architect",
    message="""
# Synthesis Subtask

**Objective:** Consolidate adversarial findings into ranked recommendations and a pressure test report.

**Context:**
<paste-identity-attack-summary>
<paste-friction-audit-summary>
<paste-surface-minimization-summary>
<paste-leverage-hunt-summary>

**MANDATORY: Sequential Thinking Protocol**

Use sequential thinking to integrate and prioritize. Minimum 2 synthesis approaches.

```python
mcp--sequentialthinking--process_thought(
    thought="Synthesis approach A: [priority framing]",
    thought_number=1,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Synthesis",
    tags=["pressure-test", "synthesis"]
)

mcp--sequentialthinking--process_thought(
    thought="Synthesis approach B: [alternative framing]",
    thought_number=2,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Synthesis",
    tags=["pressure-test", "synthesis"]
)

mcp--sequentialthinking--generate_summary()

mcp--sequentialthinking--process_thought(
    thought="Conclusion: ranked recommendations and rationale",
    thought_number=3,
    total_thoughts=5,
    next_thought_needed=True,
    stage="Conclusion",
    tags=["pressure-test", "synthesis"]
)

mcp--sequentialthinking--export_session(
    file_path=".kilocode/thinking/pressure-test-synthesis-<YYYY-MM-DD>.json"
)
```

**Output Requirements:**
- `runtime_model_reported`
- `runtime_mode_reported`
- Ranked recommendations with rationale
- Quick wins vs long-term moves
- Exported session path

**Completion:**
Use `attempt_completion` with the final Pressure Test Report.
""",
    todos=None
)
```

### Step 11: Update Progress

> ⚙️ **Handled natively by Audit Orchestrator mode.**

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Identity Attack (product-skeptic)
[x] Subtask B: Friction Audit (product-skeptic)
[x] Subtask C: Surface Minimization (product-skeptic)
[x] Subtask D: Leverage Hunt (architect)
[x] Subtask E: Synthesis (architect)
[-] Present Pressure Test Report and STOP
"""
)
```

### Step 12: Present Pressure Test Report + STOP

> ⚙️ **Handled natively by Audit Orchestrator mode.**

Compile the synthesis output into a report and STOP. Example format:

```markdown
# Pressure Test Report: <focus-area>

## Identity Attacks (Top 3)
1. <attack-1>
2. <attack-2>
3. <attack-3>

## Friction Points (Ranked)
1. <friction-1>
2. <friction-2>
3. <friction-3>

## Surface Minimization
- Remove: <item> — <impact>
- Remove: <item> — <impact>

## Highest Leverage Move
<selected move + rationale>

## Recommendations (Ranked)
1. <recommendation-1>
2. <recommendation-2>
3. <recommendation-3>

## Session Exports
- Identity: `.kilocode/thinking/pressure-test-identity-<YYYY-MM-DD>.json`
- Friction: `.kilocode/thinking/pressure-test-friction-<YYYY-MM-DD>.json`
- Minimization: `.kilocode/thinking/pressure-test-minimize-<YYYY-MM-DD>.json`
- Leverage: `.kilocode/thinking/pressure-test-leverage-<YYYY-MM-DD>.json`
- Synthesis: `.kilocode/thinking/pressure-test-synthesis-<YYYY-MM-DD>.json`
```

```python
update_todo_list(
    todos="""
[x] Runtime Model Report (record runtime model/mode)
[x] Subtask A: Identity Attack (product-skeptic)
[x] Subtask B: Friction Audit (product-skeptic)
[x] Subtask C: Surface Minimization (product-skeptic)
[x] Subtask D: Leverage Hunt (architect)
[x] Subtask E: Synthesis (architect)
[x] Present Pressure Test Report and STOP
"""
)
```

**Use `attempt_completion` to present the report and wait for user approval.**

---

## Related Workflows

- [`/friction-audit`](./friction-audit.md) — Lightweight friction audit
- [`/orchestrate-start-task`](./orchestrate-start-task.md) — Task preparation pattern
- [`/orchestrate-refactor`](./orchestrate-refactor.md) — Refactor orchestration pattern

---

## Philosophy

> ⚙️ **Handled natively by Audit Orchestrator mode.**

This workflow turns orchestration into **epistemic pressure testing**:

- **Adversarial roles** reveal blind spots
- **Sequential thinking** makes reasoning inspectable
- **Synthesis** distills into leverage and ergonomics
- **Output** is a ranked set of moves that increase inevitability
