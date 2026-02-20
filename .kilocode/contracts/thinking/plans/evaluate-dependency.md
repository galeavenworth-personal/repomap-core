# Thinking Plan: Evaluate a Risky Dependency or Tool

## Sequence

```
Abstract → Systems → Adversarial → Concrete
```

## When to Use

- Evaluating whether to adopt a new dependency
- Deciding whether to upgrade a breaking dependency
- Assessing a tool change (like Kilo CLI headless changes, or a DB swap)
- Any "should we use X?" decision where the cost of reversal is high

## Phase 1: Abstract — Frame the Decision

**Mode:** `thinker-abstract`
**Contract:** [`abstract_thinking.md`](../abstract_thinking.md)
**Objective:** Frame what kind of decision this is. What are we optimizing for?
**Gate:** ≥3 Problem Definition thoughts with different decision frames.
**Output:** Frames (e.g., "this is a speed-vs-safety tradeoff" vs "this is a lock-in decision" vs "this is a compatibility bet").

## Phase 2: Systems — Map Constraints and Dynamics

**Mode:** `thinker-systems`
**Contract:** [`systems_thinking.md`](../systems_thinking.md)
**Objective:** Map how the dependency fits into the existing system. What feedback loops does it create?
**Input:** Phase 1 chosen frame.
**Gate:** ≥2 Synthesis thoughts with `loop` or `constraint` tags.
**Output:** System map showing integration points, coupling surfaces, and feedback loops.

## Phase 3: Adversarial — Risk Register

**Mode:** `thinker-adversarial`
**Contract:** [`adversarial_thinking.md`](../adversarial_thinking.md)
**Objective:** What fails? What's the worst case? What's the switching cost if we need to reverse?
**Input:** Phases 1-2 handoffs.
**Gate:** ≥5 Analysis thoughts covering technical, timeline, and operational failure modes.
**Output:** Risk register + kill criteria (what conditions should trigger reversal).

## Phase 4: Concrete — Decision + Kill Criteria

**Mode:** `thinker-concrete`
**Contract:** [`concrete_thinking.md`](../concrete_thinking.md)
**Objective:** Make the binary decision (adopt/reject/defer) + define kill criteria + plan first integration step.
**Input:** All prior phase handoffs.
**Gate:** ≥2 Conclusion thoughts with `acceptance` and `check` tags.
**Output:** Decision with rationale, kill criteria, integration checklist.

## Orchestrator Instructions

1. Spawn `thinker-abstract` with the dependency evaluation question.
2. Spawn `thinker-systems` with Phase 1's chosen frame.
3. Spawn `thinker-adversarial` with Phases 1-2 context.
4. Spawn `thinker-concrete` with all prior handoffs.
5. Compile: decision document with frame, system map, risk register, and execution plan.

## Kill Criteria Template

Every dependency evaluation MUST produce kill criteria:
- **Performance threshold**: "If latency exceeds X ms, revert."
- **Maintenance burden**: "If we spend >Y hours/month on compatibility, switch."
- **Community signal**: "If no release in Z months, plan migration."
- **Integration surface**: "If coupling surface exceeds N files, isolate behind adapter."
