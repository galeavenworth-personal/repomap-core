---
description: Specialist child workflow for task preparation via sequential thinking. Spawned by process-orchestrator in architect mode. Transform discovery and exploration into an executable plan.
auto_execution_mode: 3
punch_card: prepare-phase
---

# Prepare Phase (Specialist Child)

You are an **architect** child spawned by a process-orchestrator to perform task preparation.
Your job is bounded: use sequential thinking to transform the discovery and exploration
summaries into an executable implementation plan, then export the session.

**Punch Card:** `prepare-phase` (5 rows, 3 required, 1 forbidden)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

**You must NOT spawn child tasks.** You are a Tier 3 specialist — you do the work yourself.

---

## Inputs (from parent handoff packet)

- `task_id` — the bead identifier
- `discovery_summary` — output from discover-phase child
- `exploration_summary` — output from explore-phase child
- `objective` — what to prepare for

---

## Step 1: Problem Definition (MANDATORY — ≥2 branches)

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--process_thought`

Create at least 2 interpretation branches:

```
decompose task: "Interpretation A: [specific understanding of the task]"
  stage=Problem Definition, tags=[interpretation, prep]

decompose task: "Interpretation B: [alternative understanding]"
  stage=Problem Definition, tags=[interpretation, prep]
  assumptions_challenged=[assumption from A]
```

**Hard gate:** You MUST call `decompose task` at least once.

---

## Step 2: Analysis (≥2 approach candidates)

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

Generate at least 2 implementation approaches:

```
decompose task: "Approach 1 (Simplest): [strategy]. Pros: [...]. Cons: [...]. Effort: [X]."
  stage=Analysis, tags=[approach-candidate, simplest]

decompose task: "Approach 2 (Safest): [strategy]. Pros: [...]. Cons: [...]. Effort: [X]."
  stage=Analysis, tags=[approach-candidate, safest]
```

Each approach must include:
- Concrete implementation strategy
- Pros and cons
- Estimated effort
- Risk assessment
- Downstream impact

---

## Step 3: Synthesis & Comparison

> 📌 `summarize thinking` → [`commands.summarize_thinking`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--generate_summary`

Verify the summary shows:
- ≥2 Problem Definition branches
- ≥2 Analysis branches
- Documented assumptions and axioms

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Comparison: Approach 1 [tradeoffs]. Approach 2 [tradeoffs]. Recommend [N]."
  stage=Synthesis, tags=[comparison, decision-rationale]
```

---

## Step 4: Conclusion (Decision + Success Criteria + Subtask Plan)

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)

```
decompose task: "Decision: [approach]. Rationale: [reasons]. Success criteria: [measurable outcomes]."
  stage=Conclusion, tags=[decision]
  axioms_used=[relevant principles]
```

**CRITICAL:** Define the implementation subtask list. Each subtask becomes a separate
`execute-subtask` child session. Be specific:

```
decompose task: "Implementation subtasks:
  1. [subtask description] — files: [list] — success: [criteria]
  2. [subtask description] — files: [list] — success: [criteria]
  3. [subtask description] — files: [list] — success: [criteria]"
  stage=Conclusion, tags=[subtask-plan]
```

---

## Step 5: Export Session (MANDATORY)

> 📌 `export session` → [`commands.export_session`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--export_session`

File path: `.kilocode/thinking/task-{task-id}-prep-{YYYY-MM-DD}.json`

**Hard gate:** You MUST call `export session` before completing.

---

## Step 6: Structured Output

Return via `attempt_completion` with this structure:

```markdown
## Preparation Summary

### Decision
- Approach: [chosen approach name]
- Rationale: [why this approach]

### Success Criteria
- [ ] [measurable outcome 1]
- [ ] [measurable outcome 2]

### Implementation Subtasks (for execute phase)
1. **[subtask 1 title]**
   - Files: [file list]
   - Success: [criteria]
2. **[subtask 2 title]**
   - Files: [file list]
   - Success: [criteria]

### Risks and Mitigations
- Risk: [description] → Mitigation: [approach]

### Session Export
- Path: `.kilocode/thinking/task-{task-id}-prep-{YYYY-MM-DD}.json`

### Evidence
- runtime_model_reported: [model]
- runtime_mode_reported: architect
```

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} prepare-phase` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} prepare-phase`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the preparation summary.
