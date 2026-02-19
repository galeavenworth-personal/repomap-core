# Sequential Thinking Protocol

Sequential thinking is the plant's primary reasoning interface. All multi-step analysis MUST be externalized through the sequential-thinking MCP tool suite. Internal reasoning without externalization is a protocol violation for non-trivial decisions.

## Core Rules (Non-Negotiable)

### 1. Granularity Rule

One `process_thought` call = one discrete reasoning step.

- **Maximum 4 sentences per thought.** If you need more, split into multiple thoughts.
- Each thought must be about ONE thing: one frame, one failure mode, one constraint, one step.
- If a thought contains the word "also" or "additionally" — it should be two thoughts.

### 2. Stage Purity Rule

The `stage` field must match the actual content of the thought.

| Stage | What belongs here | What does NOT belong here |
|-------|------------------|--------------------------|
| Problem Definition | Frames, interpretations, objectives, scope | Solutions, implementation details |
| Research | Facts gathered, evidence found, constraints discovered | Opinions, decisions, recommendations |
| Analysis | Evaluations, comparisons, failure modes, tradeoffs | Final decisions, action items |
| Synthesis | Patterns across analyses, how pieces connect, leverage points | New raw data, implementation steps |
| Conclusion | Decisions, action plans, acceptance criteria, handoffs | New analysis, reopening settled questions |

### 3. Stage Coverage Rule

Before entering `Conclusion`, you must have thoughts in **at least 3 distinct stages**. Call `generate_summary` to verify this — if `hasAllStages` is false and you have fewer than 3 stages, go back and fill gaps.

### 4. Session Hygiene

- **Start:** Call `clear_history` at the beginning of every new thinking session (not when resuming via import).
- **Before Conclusion:** Call `generate_summary` to verify stage coverage.
- **End:** Call `export_session` to save the session artifact.
- **Resume:** Call `import_session` then `generate_summary` to review prior reasoning before continuing.

### 5. Metadata Is Not Optional

For each `process_thought` call, at least ONE of these metadata fields must be populated:

- `tags` — categorize the thought (always include)
- `axioms_used` — what principle drove this reasoning step
- `assumptions_challenged` — what you're questioning or testing

### 6. Hard Gate

You may NOT call `edit_file`, `write_to_file`, `execute_command`, or `attempt_completion` until at least one `process_thought` call exists with `stage="Conclusion"`.

Exception: reading files and gathering information does not require prior thinking.

## When Sequential Thinking Is Required

- Multiple implementation strategies exist
- Missing information requires assumptions
- Task touches security, data integrity, or migrations
- Estimated effort > 3 steps
- User request is ambiguous
- Architectural or design decisions
- Debugging issues where root cause isn't obvious
- Planning changes that affect multiple components
- Resuming work from a previous session (import session first)

## Thinking Styles (Composable Contracts)

When a task calls for a specific kind of reasoning, use the appropriate thinking-style contract. These are enforced when used via thinker modes (`thinker-abstract`, `thinker-adversarial`, `thinker-systems`, `thinker-concrete`, `thinker-epistemic`) and recommended for inline use.

| Style | Contract | When to Use |
|-------|----------|-------------|
| Abstract | [`.kilocode/contracts/thinking/abstract_thinking.md`](../contracts/thinking/abstract_thinking.md) | Generate competing problem frames |
| Adversarial | [`.kilocode/contracts/thinking/adversarial_thinking.md`](../contracts/thinking/adversarial_thinking.md) | Falsify plans, enumerate failure modes |
| Systems | [`.kilocode/contracts/thinking/systems_thinking.md`](../contracts/thinking/systems_thinking.md) | Find feedback loops, bottlenecks, leverage |
| Concrete | [`.kilocode/contracts/thinking/concrete_thinking.md`](../contracts/thinking/concrete_thinking.md) | Collapse ambiguity into executable steps |
| Epistemic | [`.kilocode/contracts/thinking/epistemic_thinking.md`](../contracts/thinking/epistemic_thinking.md) | Separate know/believe/guess, assign confidence |

See [`.kilocode/contracts/thinking/thinking_handoff.md`](../contracts/thinking/thinking_handoff.md) for the universal output format.

## Composable Thinking Plans

For complex tasks requiring multiple thinking styles in sequence, see the thinking plan templates:

- [`design-subsystem.md`](../contracts/thinking/plans/design-subsystem.md) — Abstract → Systems → Adversarial → Concrete
- [`debug-incident.md`](../contracts/thinking/plans/debug-incident.md) — Concrete → Research → Adversarial → Concrete
- [`evaluate-dependency.md`](../contracts/thinking/plans/evaluate-dependency.md) — Abstract → Systems → Adversarial → Concrete
- [`strategic-decision.md`](../contracts/thinking/plans/strategic-decision.md) — Abstract → Epistemic → Adversarial → Concrete

Each plan is a delegation recipe: an orchestrator spawns thinker subtasks in sequence, passing handoff packets forward.

## Tools Reference

### process_thought

Records a thought with stage validation and epistemic metadata.

**Parameters**:
- `thought` (string, required): One reasoning step, ≤4 sentences
- `thought_number` (integer, required): Current step number in sequence
- `total_thoughts` (integer, required): Estimated total (adjustable)
- `next_thought_needed` (boolean, required): True if more thinking needed
- `stage` (string, required): One of `"Problem Definition"`, `"Research"`, `"Analysis"`, `"Synthesis"`, `"Conclusion"`
- `tags` (list[str]): Keywords/categories — **always include at least one**
- `axioms_used` (list[str]): Principles applied
- `assumptions_challenged` (list[str]): What you're questioning

### generate_summary

Returns session overview: total thoughts, stage breakdown, timeline, top tags, completion status.

**Mandatory usage:**
- Before entering Conclusion stage (verify stage coverage)
- Before calling `export_session`

### export_session

Saves the session to a file.

**Mandatory usage:**
- At end of every thinking session
- Before switching contexts

**Naming:** `.kilocode/thinking/{task-type}-{date}-{brief-description}.json`

### import_session

Loads a previous session.

**Mandatory usage:**
- At start of any session resuming previous work

**Workflow:** `import_session` → `generate_summary` (review) → `process_thought` (continue)

### clear_history

Clears the thought history.

**Mandatory usage:**
- At the start of every NEW thinking session (not when resuming)

## Stage Progression Template

For standard (non-style-specific) thinking:

1. **Problem Definition** (≥1 thought) — What are we solving? What's the scope?
2. **Research** (≥1 thought) — What information do we need? What did we find?
3. **Analysis** (≥2 thoughts) — Compare approaches. Evaluate tradeoffs.
4. **Synthesis** (≥1 thought) — How do the pieces connect? Call `generate_summary` here.
5. **Conclusion** (≥1 thought) — Decision with rationale. Action plan.

Minimum: 6 thoughts across ≥3 stages for any non-trivial task.

## Example: Correct Usage (Granular Thoughts)

```python
# Thought 1: ONE frame
process_thought(
    thought="Frame A: This is a performance optimization problem. The bottleneck is I/O bound.",
    thought_number=1, total_thoughts=6, next_thought_needed=True,
    stage="Problem Definition",
    tags=["performance", "framing"]
)

# Thought 2: A DIFFERENT frame
process_thought(
    thought="Frame B: This is actually an architecture problem. The I/O is a symptom of wrong abstraction level.",
    thought_number=2, total_thoughts=6, next_thought_needed=True,
    stage="Problem Definition",
    tags=["architecture", "framing"],
    assumptions_challenged=["The problem is I/O"]
)

# Thought 3: ONE piece of evidence
process_thought(
    thought="Profiling shows 80% of time in serialize(). This supports Frame B — serialization is the wrong abstraction.",
    thought_number=3, total_thoughts=6, next_thought_needed=True,
    stage="Research",
    tags=["profiling", "evidence"]
)

# Thought 4: ONE approach evaluation
process_thought(
    thought="Approach 1: Replace serializer with orjson. Fast fix, addresses symptom not cause.",
    thought_number=4, total_thoughts=6, next_thought_needed=True,
    stage="Analysis",
    tags=["approach", "serialization"],
    axioms_used=["Prefer root cause fixes over symptom patches"]
)

# Thought 5: ANOTHER approach evaluation
process_thought(
    thought="Approach 2: Restructure to avoid serialization entirely. Higher effort but eliminates the problem class.",
    thought_number=5, total_thoughts=6, next_thought_needed=True,
    stage="Analysis",
    tags=["approach", "architecture"]
)

# generate_summary before Conclusion
generate_summary()

# Thought 6: Decision
process_thought(
    thought="Choosing Approach 2. The serialization layer is vestigial. Removing it eliminates the problem class entirely.",
    thought_number=6, total_thoughts=6, next_thought_needed=False,
    stage="Conclusion",
    tags=["decision"],
    axioms_used=["Delete code before optimizing code"]
)

export_session(file_path=".kilocode/thinking/perf-fix-2026-02-19.json")
```

## Anti-Pattern: The Big Blob (DO NOT DO THIS)

```python
# BAD: One massive thought with multiple concerns mixed together
process_thought(
    thought="Looking at the performance issue, I think we have two options. Option A is to use orjson which would be faster. Option B is to restructure the code. I looked at profiling data and 80% is in serialize(). I think we should go with Option B because it's a better long-term fix. Also we need to consider the testing impact. The current tests mock the serializer so we'd need to update those too. Let me also think about whether this affects the API contract...",
    thought_number=1, total_thoughts=1, next_thought_needed=False,
    stage="Analysis",
    tags=["performance"]
)
# This violates: granularity rule, stage purity, stage coverage, metadata requirements
```
