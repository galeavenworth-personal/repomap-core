# Thinking Plan: Design a New Subsystem

## Sequence

```
Abstract → Systems → Adversarial → Concrete
```

## Phase 1: Abstract (Frame the Problem)

**Mode:** `thinker-abstract`
**Contract:** [`abstract_thinking.md`](../abstract_thinking.md)
**Objective:** Generate 2–4 competing frames for what this subsystem IS.
**Gate:** `generate_summary` must show ≥3 Problem Definition thoughts.
**Output:** Recommended frame + discriminating evidence.

## Phase 2: Systems (Map the Dynamics)

**Mode:** `thinker-systems`
**Contract:** [`systems_thinking.md`](../systems_thinking.md)
**Objective:** Given the chosen frame, map feedback loops, bottlenecks, and leverage points.
**Input:** Phase 1 handoff packet (chosen frame + evidence).
**Gate:** `generate_summary` must show ≥2 Synthesis thoughts with `loop` or `leverage` tags.
**Output:** System map + leverage points + measurement plan.

## Phase 3: Adversarial (Break the Design)

**Mode:** `thinker-adversarial`
**Contract:** [`adversarial_thinking.md`](../adversarial_thinking.md)
**Objective:** Enumerate failure modes of the proposed design.
**Input:** Phase 1 frame + Phase 2 system map.
**Gate:** `generate_summary` must show ≥5 Analysis thoughts with `failure-mode` tags.
**Output:** Risk register + top mitigations.

## Phase 4: Concrete (Make It Real)

**Mode:** `thinker-concrete`
**Contract:** [`concrete_thinking.md`](../concrete_thinking.md)
**Objective:** Produce an execution checklist with verification after each step.
**Input:** Phase 1 frame + Phase 3 risk register + Phase 2 leverage points.
**Gate:** `generate_summary` must show ≥2 Conclusion thoughts with `check` or `acceptance` tags.
**Output:** Execution checklist + acceptance criteria.

## Orchestrator Instructions

1. Spawn `thinker-abstract` via `new_task` with the problem description.
2. Read Phase 1 handoff. Construct Phase 2 input (include chosen frame).
3. Spawn `thinker-systems` via `new_task` with Phase 1 handoff as context.
4. Read Phase 2 handoff. Construct Phase 3 input (include frame + system map).
5. Spawn `thinker-adversarial` via `new_task` with Phases 1-2 handoffs as context.
6. Read Phase 3 handoff. Construct Phase 4 input (include all prior handoffs).
7. Spawn `thinker-concrete` via `new_task` with all prior handoffs as context.
8. Compile final output from all four handoff packets.

## Gate Failure Protocol

If any phase's `generate_summary` fails the gate check:
- Do NOT proceed to the next phase.
- Report the failure to the orchestrator.
- Orchestrator may retry the phase (max 1 retry) or escalate.
