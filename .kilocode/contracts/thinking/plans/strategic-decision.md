# Thinking Plan: Strategic Decision / Sprint Planning

## Sequence

```
Abstract → Epistemic → Adversarial → Concrete
```

## When to Use

- Sprint planning or roadmap decisions
- Choosing between strategic directions
- Prioritization decisions with uncertain payoffs
- Any "which way do we go?" question with long-term consequences

## Phase 1: Abstract — Frame the Decision Space

**Mode:** `thinker-abstract`
**Contract:** [`abstract_thinking.md`](../abstract_thinking.md)
**Objective:** Generate competing frames for what this decision is really about.
**Gate:** ≥3 Problem Definition thoughts with different frames.
**Output:** 2–4 frames + what evidence would discriminate between them.

## Phase 2: Epistemic — Map Uncertainty

**Mode:** `thinker-epistemic`
**Contract:** [`epistemic_thinking.md`](../epistemic_thinking.md)
**Objective:** For each frame, what do we know vs believe vs guess? Where is our confidence low?
**Input:** Phase 1 frames.
**Gate:** ≥2 Research thoughts with knowledge inventory, ≥1 Analysis thought with crux identification.
**Output:** Knowledge inventory + confidence bands + crux + measurement plan.

## Phase 3: Adversarial — Stress Test the Leading Option

**Mode:** `thinker-adversarial`
**Contract:** [`adversarial_thinking.md`](../adversarial_thinking.md)
**Objective:** Attack the most-likely decision. What fails? What's the cost of being wrong?
**Input:** Phase 1 recommended frame + Phase 2 crux + confidence data.
**Gate:** ≥5 Analysis thoughts with failure modes.
**Output:** Risk register + top mitigations + what would change the conclusion.

## Phase 4: Concrete — Decision + Execution Plan

**Mode:** `thinker-concrete`
**Contract:** [`concrete_thinking.md`](../concrete_thinking.md)
**Objective:** Make the decision. Produce an execution plan with kill criteria.
**Input:** All prior phase handoffs.
**Gate:** ≥2 Conclusion thoughts with acceptance criteria.
**Output:** Decision + execution checklist + kill criteria + stop conditions.

## Orchestrator Instructions

1. Spawn `thinker-abstract` with the strategic question.
2. Spawn `thinker-epistemic` with the abstract frames (focus on the recommended frame).
3. Spawn `thinker-adversarial` with the leading option + epistemic data.
4. Spawn `thinker-concrete` with all prior handoffs — produce the decision document.
5. Compile: strategic decision document with rationale trail from all four phases.

## Why This Order

- **Abstract first** prevents premature convergence on the first idea.
- **Epistemic second** prevents decisions based on unexamined beliefs.
- **Adversarial third** prevents the plan surviving only because nobody attacked it.
- **Concrete last** ensures the decision is specific, testable, and reversible.

This is the "full rigor" plan. Use it for high-stakes decisions where the cost of being wrong exceeds the cost of thinking carefully.
