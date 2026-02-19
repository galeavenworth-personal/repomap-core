# Systems Thinking Contract (Dynamics + Constraints)

## Purpose

Find feedback loops, bottlenecks, and second-order effects. The goal is to understand the SYSTEM, not just the components.

## When to Use

- Designing or evaluating infrastructure with interacting parts
- A change in one area has unexpected effects elsewhere
- Need to find the bottleneck constraint (Theory of Constraints)
- Evaluating what to measure and why
- Understanding why a "simple fix" keeps not working

## Required Stages and Minimums

| Stage | Min Thoughts | What Must Be Produced |
|-------|-------------|----------------------|
| Research | 2 | Facts, constraints, and system boundaries |
| Analysis | 1 | Component interaction analysis |
| Synthesis | 2 | Feedback loops + leverage points |

**Total minimum:** 5 thoughts

## Stage-Specific Requirements

### Research (≥2 thoughts)

Identify the system's components and boundaries:
- What are the moving parts?
- What are the external constraints (time, budget, skill, policy)?
- Where does information/work flow?
- What is the system boundary? (What's inside vs outside our control?)

### Analysis (≥1 thought)

Map interactions between components:
- Which components depend on each other?
- Where are the coupling points?
- What happens when one component is slow, broken, or removed?

### Synthesis (≥2 thoughts)

**Thought 1: Feedback loops** — Identify at least 2 feedback loops:
- **Reinforcing loops** (R) — more of A leads to more of B leads to more of A (growth or collapse)
- **Balancing loops** (B) — more of A leads to less of B leads to more of A (stability or oscillation)

Label each loop: R or B, name the mechanism, identify the key variable.

**Thought 2: Leverage points** — Where does a small change produce a large effect?
- Identify the bottleneck constraint (the single thing limiting throughput)
- What moves the bottleneck? (What would make it no longer the constraint?)
- What must we measure to see the system's actual behavior?

## Required Metadata

| Field | Requirement |
|-------|------------|
| `tags` | Must include at least one of: `loop`, `bottleneck`, `constraint`, `leverage` |
| `axioms_used` | Recommended: "the bottleneck determines throughput", "local optimizations can worsen global performance" |

Recommended tags: `loop`, `bottleneck`, `constraint`, `leverage`, `coupling`, `boundary`, `feedback`, `reinforcing`, `balancing`

## Required Output

The `attempt_completion` result must include:

1. **System map** — components and their interactions (can be ASCII diagram)
2. **Feedback loops** — at least 2, labeled R/B with mechanism description
3. **Bottleneck identification** — what's the current constraint + what moves it
4. **Leverage points** — ranked list of where small changes have large effects
5. **Measurement plan** — what to measure to see actual system behavior
6. **Standard thinking handoff** — per [`thinking_handoff.md`](thinking_handoff.md)

## Example: Correct Systems Thinking

```python
# System boundary
process_thought(
    thought="System boundary: the plant orchestration loop. Components: Plant Manager, Process Orchestrator, specialist modes, sequential-thinking MCP, Dolt state, Beads tracking. External constraint: LLM token budget per session.",
    thought_number=1, total_thoughts=5, next_thought_needed=True,
    stage="Research",
    tags=["boundary", "constraint"],
    axioms_used=["Define the system before analyzing it"]
)

# Information flow
process_thought(
    thought="Work flows: Plant Manager → handoff packet → Process Orchestrator → subtask messages → specialists. State flows back: attempt_completion → parent reads result → updates todo. Dolt stores durable state across sessions.",
    thought_number=2, total_thoughts=5, next_thought_needed=True,
    stage="Research",
    tags=["coupling", "flow"]
)

# Interaction analysis
process_thought(
    thought="Coupling hotspot: the handoff packet format. Every orchestrator-to-specialist interaction depends on it. If the format drifts, all downstream modes break silently (they get context but misinterpret it).",
    thought_number=3, total_thoughts=5, next_thought_needed=True,
    stage="Analysis",
    tags=["coupling", "bottleneck"],
    axioms_used=["Local optimizations can worsen global performance"]
)

# Feedback loops
process_thought(
    thought="R1 (Reinforcing): Better thinking contracts → higher quality decisions → more trust in plant → more investment in contracts. R2 (Reinforcing, negative): More ceremony → slower execution → agents skip steps → worse quality → more ceremony added. B1 (Balancing): Token budget constrains thinking depth → forces conciseness → improves signal/noise.",
    thought_number=4, total_thoughts=5, next_thought_needed=True,
    stage="Synthesis",
    tags=["loop", "reinforcing", "balancing", "feedback"]
)

# Leverage points
process_thought(
    thought="Bottleneck: agent compliance with thinking protocol (R2 loop). Leverage point: the generate_summary gate before Conclusion — it's the cheapest enforcement that catches the most violations. Measure: stage coverage % across sessions.",
    thought_number=5, total_thoughts=5, next_thought_needed=False,
    stage="Synthesis",
    tags=["leverage", "bottleneck", "measurement"],
    axioms_used=["The bottleneck determines throughput"]
)
```
