# Epistemic Thinking Contract (Epistemic Hygiene)

## Purpose

Separate what we KNOW from what we BELIEVE from what we GUESS. Assign confidence bands. Identify the fastest measurement to collapse uncertainty. Turn the plant into a truth machine instead of a word machine.

## When to Use

- Before committing to a plan based on uncertain information
- When multiple people disagree and you need to find the crux
- Evaluating claims or assertions that "feel right" but lack evidence
- After adversarial thinking reveals risks — which risks are real vs feared?
- When the cost of being wrong is high

## Required Stages and Minimums

| Stage | Min Thoughts | What Must Be Produced |
|-------|-------------|----------------------|
| Research | 2 | Knowledge inventory (know/believe/guess) |
| Analysis | 2 | Confidence bands + crux identification |
| Conclusion | 1 | Measurement plan for fastest uncertainty collapse |

**Total minimum:** 5 thoughts

## Stage-Specific Requirements

### Research (≥2 thoughts)

Build a knowledge inventory. For each relevant claim or assumption, classify it:

| Category | Definition | Example |
|----------|-----------|---------|
| **KNOW** | Verified by evidence we can point to | "Tests pass" (we ran them) |
| **BELIEVE** | Reasonable inference from indirect evidence | "The API is stable" (no breaking changes in 6 months) |
| **GUESS** | Plausible but unverified | "Users will adopt this" (no user research done) |

Each thought should inventory claims in one domain (technical, product, timeline, etc.).

### Analysis (≥2 thoughts)

**Thought 1: Confidence bands** — For each BELIEVE and GUESS item, assign a confidence level:
- **High (>80%)** — would bet money on it
- **Medium (40–80%)** — more likely than not but not confident
- **Low (<40%)** — uncertain, possibly wrong
- **Unknown** — can't even estimate

**Thought 2: Crux identification** — Find the crux: the single belief or assumption where, IF you were wrong, the entire plan changes. This is not necessarily the lowest-confidence item — it's the one with the highest decision-relevance.

### Conclusion (≥1 thought)

**Measurement plan** — What single measurement, experiment, or check would collapse the most uncertainty the fastest?

Requirements:
- Must be executable (not "do more research")
- Must have a timeline (when can we know?)
- Must have a decision rule (if result X → do A; if result Y → do B)

## Required Metadata

| Field | Requirement |
|-------|------------|
| `tags` | Must include at least one of: `known`, `believed`, `guessed`, `confidence`, `measurement`, `crux` |
| `assumptions_challenged` | **Mandatory every thought** |

## Required Output

The `attempt_completion` result must include:

1. **Knowledge inventory** — table of claims categorized as KNOW/BELIEVE/GUESS
2. **Confidence bands** — each BELIEVE/GUESS item with confidence level
3. **Crux** — the single highest-stakes assumption + why it matters
4. **Measurement plan** — what to measure, when, and the decision rule
5. **Standard thinking handoff** — per [`thinking_handoff.md`](thinking_handoff.md)

## Example: Correct Epistemic Thinking

```python
# Technical knowledge inventory
process_thought(
    thought="Technical claims inventory: KNOW — Dolt binary runs on Linux (tested). BELIEVE — Dolt performance is adequate for our schema size (no benchmark yet, based on docs claiming 'SQL-compatible'). GUESS — Dolt will integrate cleanly with Beads v0.50 (no integration test exists).",
    thought_number=1, total_thoughts=5, next_thought_needed=True,
    stage="Research",
    tags=["known", "believed", "guessed", "technical"],
    assumptions_challenged=["Dolt is production-ready for our use case"]
)

# Product knowledge inventory
process_thought(
    thought="Product claims inventory: KNOW — thinking sessions export correctly (tested). BELIEVE — agents will follow granularity rules when enforced via mode instructions (indirect evidence from existing mode compliance). GUESS — composable thinking plans will improve decision quality (no A/B data).",
    thought_number=2, total_thoughts=5, next_thought_needed=True,
    stage="Research",
    tags=["known", "believed", "guessed", "product"],
    assumptions_challenged=["Thinking infrastructure improves output quality"]
)

# Confidence bands
process_thought(
    thought="Confidence bands: Dolt performance adequate — HIGH (80%, small schema). Dolt-Beads integration — LOW (30%, no one has tried). Agent compliance with granularity — MEDIUM (60%, modes work but thinking rules are more complex). Decision quality improvement — UNKNOWN (no baseline measurement).",
    thought_number=3, total_thoughts=5, next_thought_needed=True,
    stage="Analysis",
    tags=["confidence", "bands"],
    assumptions_challenged=["We can estimate confidence accurately"]
)

# Crux identification
process_thought(
    thought="Crux: 'Agents will follow granularity rules when enforced via mode instructions.' If this is wrong, the entire thinking infrastructure is theater — contracts that nobody follows. This is the highest-stakes assumption because everything else builds on it. Decision-relevance: 10/10.",
    thought_number=4, total_thoughts=5, next_thought_needed=True,
    stage="Analysis",
    tags=["crux", "decision-relevance"],
    assumptions_challenged=["Mode instructions are sufficient enforcement"]
)

# Measurement plan
process_thought(
    thought="Fastest uncertainty collapse: Run ONE real task through thinker-adversarial mode. Check generate_summary output — does it show ≥5 Analysis thoughts and ≥1 Synthesis? If yes: agents comply, confidence HIGH. If no: need stronger enforcement (hard-coded validation in MCP server). Timeline: 1 task cycle (~30 min). Decision rule: ≥80% stage coverage = proceed; <80% = add server-side validation.",
    thought_number=5, total_thoughts=5, next_thought_needed=False,
    stage="Conclusion",
    tags=["measurement", "experiment", "decision-rule"],
    assumptions_challenged=["We know enough to proceed without testing"]
)
```
