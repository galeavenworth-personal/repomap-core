---
name: sequential-thinking-default
description: Use structured sequential thinking for multi-step debugging, architecture decisions, or ambiguous problem framing.
---

# Structured Sequential Thinking

## When to use this skill

Use this skill when you need to:

- Debug failures where the root cause isn't obvious
- Compare multiple valid implementation approaches
- Plan multi-file changes without missing consumers
- Make architectural decisions with competing tradeoffs
- Explore solution spaces before committing to implementation

## Core Protocol

See [`.kilocode/rules/general-workflow.md`](../../rules/general-workflow.md) for the full protocol. Key rules:

1. **Granularity:** One `process_thought` call = one reasoning step, ≤4 sentences
2. **Stage purity:** `stage` field must match the thought's content
3. **Stage coverage:** ≥3 distinct stages before entering Conclusion
4. **Session hygiene:** `clear_history` → think → `generate_summary` → `export_session`
5. **Metadata required:** At least one of `tags`, `axioms_used`, or `assumptions_challenged` per thought

## Stage Progression

1. **Problem Definition** (≥1 thought) — What are we solving?
2. **Research** (≥1 thought) — What information do we need?
3. **Analysis** (≥2 thoughts) — Compare approaches, evaluate tradeoffs
4. **Synthesis** (≥1 thought) — How do pieces connect? Call `generate_summary` here.
5. **Conclusion** (≥1 thought) — Decision with rationale

Minimum: 6 thoughts across ≥3 stages for non-trivial tasks.

## Thinking Styles (Composable Contracts)

For specialized reasoning, use a thinking-style contract:

| Style | Contract | When to Use |
|-------|----------|-------------|
| Abstract | [`abstract_thinking.md`](../../contracts/thinking/abstract_thinking.md) | Generate competing problem frames |
| Adversarial | [`adversarial_thinking.md`](../../contracts/thinking/adversarial_thinking.md) | Falsify plans, enumerate failure modes |
| Systems | [`systems_thinking.md`](../../contracts/thinking/systems_thinking.md) | Find feedback loops, bottlenecks, leverage |
| Concrete | [`concrete_thinking.md`](../../contracts/thinking/concrete_thinking.md) | Collapse ambiguity into executable steps |
| Epistemic | [`epistemic_thinking.md`](../../contracts/thinking/epistemic_thinking.md) | Separate know/believe/guess, assign confidence |

Handoff format: [`thinking_handoff.md`](../../contracts/thinking/thinking_handoff.md)

## Thinking Plans (Delegation Recipes)

For multi-style reasoning, orchestrators use thinking plan templates:

| Plan | Sequence | When to Use |
|------|----------|-------------|
| [`design-subsystem.md`](../../contracts/thinking/plans/design-subsystem.md) | Abstract → Systems → Adversarial → Concrete | Design new components |
| [`debug-incident.md`](../../contracts/thinking/plans/debug-incident.md) | Concrete → Research → Adversarial → Concrete | Debug production issues |
| [`evaluate-dependency.md`](../../contracts/thinking/plans/evaluate-dependency.md) | Abstract → Systems → Adversarial → Concrete | Evaluate risky dependencies |
| [`strategic-decision.md`](../../contracts/thinking/plans/strategic-decision.md) | Abstract → Epistemic → Adversarial → Concrete | Sprint planning, strategic choices |

## Tools

- `process_thought` — Record stage-based thoughts with metadata
- `generate_summary` — Retrieve session overview (mandatory before Conclusion)
- `export_session` — Save session for future reference (mandatory at session end)
- `import_session` — Load previous session to resume work
- `clear_history` — Clear thought history (mandatory at new session start)

## Integration with other tools

- **Pair with codebase-retrieval:** Use Research stage to plan information gathering, then execute retrieval
- **Complement with Context7:** When assumptions involve library APIs, verify with up-to-date docs
- **Before major refactors:** Use Analysis/Synthesis stages to evaluate approaches

## Anti-Pattern: The Big Blob

Do NOT dump all reasoning into one massive thought. Each thought = one discrete step.
See [`general-workflow.md`](../../rules/general-workflow.md) for correct vs incorrect examples.
