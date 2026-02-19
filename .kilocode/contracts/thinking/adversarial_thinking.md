# Adversarial Thinking Contract (Red Team / Falsification)

## Purpose

Try to break the current plan, aggressively. The goal is to enumerate failure modes and produce a risk register, not to confirm the plan works.

## When to Use

- A plan or design exists and needs stress testing
- Before committing to an irreversible decision
- When the team is converging too quickly (groupthink risk)
- After abstract thinking has selected a frame
- Security, data integrity, or migration decisions

## Required Stages and Minimums

| Stage | Min Thoughts | What Must Be Produced |
|-------|-------------|----------------------|
| Analysis | 5 | Five distinct failure modes |
| Synthesis | 1 | Risk ranking + top mitigations |

**Total minimum:** 6 thoughts

## Stage-Specific Requirements

### Analysis (≥5 thoughts)

Each thought must present ONE failure mode. Cover at least 3 of these categories:
- **Technical** — code breaks, performance degrades, data corrupts
- **Product** — users confused, wrong problem solved, adoption fails
- **Security** — unauthorized access, data leak, injection
- **Timeline** — underestimated effort, dependency delays, scope creep
- **Human factors** — bus factor, skill gaps, motivation loss, communication failure
- **Operational** — deployment fails, monitoring blind spots, rollback impossible

For each failure mode, include:
- Likelihood (high/medium/low)
- Impact (high/medium/low)
- Detection method (how would we know?)
- Mitigation (what prevents or reduces it?)

### Synthesis (≥1 thought)

Rank the failure modes by expected loss (likelihood × impact). Identify the top 1–2 changes that reduce expected loss the most. These are the "highest leverage mitigations."

## Required Metadata

| Field | Requirement |
|-------|------------|
| `tags` | Must include `failure-mode` or `risk` for each analysis thought |
| `assumptions_challenged` | **Mandatory every thought** |
| `axioms_used` | **Mandatory every thought** |

Recommended axioms: "what can fail will fail", "unknown unknowns exist", "optimism is not evidence", "the plan is the first casualty"

## Required Output

The `attempt_completion` result must include:

1. **Risk register** — table of ≥5 failure modes with likelihood, impact, detection, mitigation
2. **Top mitigations** — the 1–2 changes that reduce expected loss the most
3. **What evidence would change the conclusion** — what would make the current plan acceptable or unacceptable
4. **Standard thinking handoff** — per [`thinking_handoff.md`](thinking_handoff.md)

## Example: Correct Adversarial Thinking

```python
# Failure mode 1: Technical
process_thought(
    thought="Failure mode: Dolt binary not available on CI runners. Likelihood: medium. Impact: high (all gates blocked). Detection: first CI run. Mitigation: Docker image with Dolt pre-installed.",
    thought_number=1, total_thoughts=6, next_thought_needed=True,
    stage="Analysis",
    tags=["failure-mode", "technical", "ci"],
    axioms_used=["What can fail will fail"],
    assumptions_challenged=["CI environment matches local"]
)

# Failure mode 2: Timeline
process_thought(
    thought="Failure mode: Beads v0.50 migration breaks existing workflow. Likelihood: high. Impact: medium (workaround exists via pinned version). Detection: bd sync fails after upgrade. Mitigation: keep pinned fallback, test migration in branch first.",
    thought_number=2, total_thoughts=6, next_thought_needed=True,
    stage="Analysis",
    tags=["failure-mode", "timeline", "migration"],
    axioms_used=["The plan is the first casualty"],
    assumptions_challenged=["Beads upgrade is safe"]
)

# Failure mode 3: Human factors
process_thought(
    thought="Failure mode: Thinking-style modes are too ceremonial and agents skip steps. Likelihood: high. Impact: medium (degrades to current blob behavior). Detection: generate_summary shows < 3 stages. Mitigation: hard gate in protocol, summary check before Conclusion.",
    thought_number=3, total_thoughts=6, next_thought_needed=True,
    stage="Analysis",
    tags=["failure-mode", "human-factors", "ceremony"],
    axioms_used=["Optimism is not evidence"],
    assumptions_challenged=["Agents will follow contracts when inconvenient"]
)

# Failure mode 4: Product
process_thought(
    thought="Failure mode: Thinking plans add latency without improving decision quality. The overhead doesn't pay for itself. Likelihood: medium. Impact: medium. Detection: compare decision quality before/after. Mitigation: measure token cost and track reversal rate.",
    thought_number=4, total_thoughts=6, next_thought_needed=True,
    stage="Analysis",
    tags=["failure-mode", "product", "overhead"],
    axioms_used=["Unknown unknowns exist"],
    assumptions_challenged=["More structured thinking = better decisions"]
)

# Failure mode 5: Operational
process_thought(
    thought="Failure mode: Session exports grow unbounded, filling disk and slowing MCP server. Likelihood: low. Impact: low (gitignored, can prune). Detection: disk usage monitoring. Mitigation: session pruning policy after 30 days.",
    thought_number=5, total_thoughts=6, next_thought_needed=True,
    stage="Analysis",
    tags=["failure-mode", "operational", "storage"],
    axioms_used=["What can fail will fail"],
    assumptions_challenged=["Session data is always small"]
)

# Risk ranking
process_thought(
    thought="Top risks by expected loss: (1) Agents skip ceremony → mitigate with hard gates. (2) CI Dolt availability → mitigate with Docker image. Highest leverage: the hard gate in generate_summary before Conclusion, since it's the enforcement bottleneck for all thinking quality.",
    thought_number=6, total_thoughts=6, next_thought_needed=False,
    stage="Synthesis",
    tags=["risk-ranking", "leverage", "mitigation"],
    axioms_used=["Focus on the bottleneck constraint"]
)
```
