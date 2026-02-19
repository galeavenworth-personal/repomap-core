# Concrete Thinking Contract (Make It Real)

## Purpose

Collapse ambiguity into executable steps and tests. The goal is to produce a step plan where every step has a verification check.

## When to Use

- After abstract/adversarial/systems thinking has identified the approach
- Translating a design into implementation steps
- Planning a migration or deployment
- Any task where "done" needs to be defined explicitly
- When the risk is "we thought we were done but we weren't"

## Required Stages and Minimums

| Stage | Min Thoughts | What Must Be Produced |
|-------|-------------|----------------------|
| Problem Definition | 1 | Scope and constraints summary |
| Analysis | 2 | Step decomposition + dependency ordering |
| Conclusion | 2 | Execution checklist + acceptance criteria |

**Total minimum:** 5 thoughts

## Stage-Specific Requirements

### Problem Definition (≥1 thought)

Summarize what's being made real:
- What's the input (prior thinking, design doc, ticket)?
- What are the hard constraints (budget, time, dependencies)?
- What does "done" look like at the highest level?

### Analysis (≥2 thoughts)

**Thought 1: Step decomposition** — Break the work into atomic steps. Each step must be:
- Small enough to verify independently
- Ordered by dependency (what must happen first?)
- Reversible where possible (prefer changes that can be undone)

**Thought 2: Dependency graph** — Which steps block other steps? What can be parallelized? Where are the serial bottlenecks?

### Conclusion (≥2 thoughts)

**Thought 1: Execution checklist** — Each step as a checklist item with:
- The action (what to do)
- The verification (how to confirm it worked)
- The rollback (what to do if it fails)

**Thought 2: Acceptance criteria** — The complete list of checks that must pass before the work is "done." These must be executable (commands, tests, inspections), not subjective ("looks good").

## Required Metadata

| Field | Requirement |
|-------|------------|
| `tags` | Must include at least one of: `step`, `check`, `artifact`, `acceptance` |
| `axioms_used` | Must include at least one of: "no step without a check", "prefer reversible changes", "done means verified" |

## Required Output

The `attempt_completion` result must include:

1. **Execution checklist** — numbered steps with action + verification + rollback
2. **Acceptance criteria** — executable checks for "done"
3. **Dependency diagram** — which steps block which (ASCII or list)
4. **Estimated effort** — per step (S/M/L) and total
5. **Standard thinking handoff** — per [`thinking_handoff.md`](thinking_handoff.md)

## Example: Correct Concrete Thinking

```python
# Scope
process_thought(
    thought="Making real: Dolt schema initialization (bead 4f0.14a). Input: punch-card-schema.sql DDL. Constraints: must work offline, no Docker dependency for schema-only work. Done: Dolt database initialized with all punch card tables.",
    thought_number=1, total_thoughts=5, next_thought_needed=True,
    stage="Problem Definition",
    tags=["scope", "constraints"],
    axioms_used=["Done means verified"]
)

# Step decomposition
process_thought(
    thought="Steps: (1) Install Dolt binary, (2) Initialize Dolt repo at .dolt/, (3) Run DDL from punch-card-schema.sql, (4) Verify tables exist, (5) Add .dolt/ to .gitignore, (6) Run quality gates.",
    thought_number=2, total_thoughts=5, next_thought_needed=True,
    stage="Analysis",
    tags=["step", "decomposition"],
    axioms_used=["No step without a check"]
)

# Dependencies
process_thought(
    thought="Dependency chain: (1)→(2)→(3)→(4) is serial. (5) can happen anytime after (2). (6) is independent. Bottleneck: step (1) — Dolt installation may vary by OS.",
    thought_number=3, total_thoughts=5, next_thought_needed=True,
    stage="Analysis",
    tags=["step", "dependency"],
    axioms_used=["Prefer reversible changes"]
)

# Execution checklist
process_thought(
    thought="Checklist: (1) Install Dolt → verify: `dolt version` returns version string. (2) Init Dolt repo → verify: `.dolt/` directory exists. (3) Run DDL → verify: `dolt sql -q 'SHOW TABLES'` returns 5 tables. (4) Add .gitignore entry → verify: `git status` doesn't show .dolt/. (5) Quality gates → verify: all 4 gates pass.",
    thought_number=4, total_thoughts=5, next_thought_needed=True,
    stage="Conclusion",
    tags=["check", "artifact"],
    axioms_used=["No step without a check"]
)

# Acceptance criteria
process_thought(
    thought="Acceptance: (a) `dolt sql -q 'SELECT COUNT(*) FROM tasks'` returns 0 without error, (b) `dolt sql -q 'SHOW TABLES'` lists tasks/punches/punch_cards/checkpoints/child_relationships, (c) quality gates pass, (d) no .dolt/ files in git status.",
    thought_number=5, total_thoughts=5, next_thought_needed=False,
    stage="Conclusion",
    tags=["acceptance", "artifact"],
    axioms_used=["Done means verified"]
)
```
