# Abstract Thinking Contract (Map-Making)

## Purpose

Generate candidate problem frames, not conclusions. The goal is to explore WHAT kind of problem this is before rushing to solve it.

## When to Use

- Problem statement is ambiguous or contested
- Multiple stakeholders would frame the problem differently
- You're not sure whether this is an optimization, diagnosis, design, or negotiation
- Early-stage thinking where premature convergence is the risk

## Required Stages and Minimums

| Stage | Min Thoughts | What Must Be Produced |
|-------|-------------|----------------------|
| Problem Definition | 3 | Three alternative framings of the problem |
| Research | 1 | Evidence that would discriminate between frames |
| Synthesis | 1 | Frame comparison + recommendation |

**Total minimum:** 5 thoughts

## Stage-Specific Requirements

### Problem Definition (≥3 thoughts)

Each thought must present ONE alternative framing:
- Different objective (what are we optimizing for?)
- Different stakeholder perspective (who experiences this problem?)
- Different success metric (how would we know it's solved?)

Explicitly name what kind of thing this is: optimization, diagnosis, design, negotiation, exploration, constraint satisfaction.

### Research (≥1 thought)

For each frame, identify what evidence would confirm or disconfirm it. What measurement, fact, or test would discriminate between the frames?

### Synthesis (≥1 thought)

Compare the frames. Which has the most evidence? Which is most actionable? Which carries the most risk of being wrong?

## Required Metadata

| Field | Requirement |
|-------|------------|
| `tags` | Must include `frame` for each framing thought |
| `assumptions_challenged` | **Mandatory every thought** — what are you questioning? |

Recommended tags: `frame`, `objective`, `definition`, `stakeholder`, `metric`

## Required Output

The `attempt_completion` result must include:

1. **2–4 frames** — each with a 1-sentence description + what kind of problem it names
2. **Discriminating evidence** — what measurement/fact would tell you which frame is correct
3. **Recommended frame** — with rationale for why it's the best starting point
4. **Standard thinking handoff** — per [`thinking_handoff.md`](thinking_handoff.md)

## Example: Correct Abstract Thinking

```python
# Frame 1
process_thought(
    thought="Frame A: This is a developer ergonomics problem. The CLI output is confusing, causing users to misinterpret results.",
    thought_number=1, total_thoughts=5, next_thought_needed=True,
    stage="Problem Definition",
    tags=["frame", "ergonomics"],
    assumptions_challenged=["The output is technically correct"]
)

# Frame 2
process_thought(
    thought="Frame B: This is a data quality problem. The underlying analysis produces ambiguous results that no output format can fix.",
    thought_number=2, total_thoughts=5, next_thought_needed=True,
    stage="Problem Definition",
    tags=["frame", "data-quality"],
    assumptions_challenged=["Better UX solves the problem"]
)

# Frame 3
process_thought(
    thought="Frame C: This is a scope problem. The tool tries to answer too many questions at once, making every answer shallow.",
    thought_number=3, total_thoughts=5, next_thought_needed=True,
    stage="Problem Definition",
    tags=["frame", "scope"],
    assumptions_challenged=["More features = more value"]
)

# Discriminating evidence
process_thought(
    thought="Test: If we simplify the output to one metric and users still misinterpret, Frame B is confirmed. If they get it right, Frame A was correct.",
    thought_number=4, total_thoughts=5, next_thought_needed=True,
    stage="Research",
    tags=["evidence", "discrimination"]
)

# Synthesis
process_thought(
    thought="Frame B has the most evidence: the analysis engine produces overlapping claim types that even the team finds ambiguous. Recommend starting from Frame B.",
    thought_number=5, total_thoughts=5, next_thought_needed=False,
    stage="Synthesis",
    tags=["frame", "recommendation"],
    assumptions_challenged=["All frames are equally likely"]
)
```
