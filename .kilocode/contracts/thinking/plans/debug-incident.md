# Thinking Plan: Debug a Production Incident

## Sequence

```
Concrete (scope) → Research (evidence) → Adversarial (alternatives) → Concrete (fix)
```

## Phase 1: Concrete — Scope the Problem

**Mode:** `thinker-concrete`
**Contract:** [`concrete_thinking.md`](../concrete_thinking.md)
**Objective:** Define the incident boundary. What broke? What's the blast radius? What's the reproduction path?
**Gate:** `generate_summary` must show ≥1 Problem Definition thought + ≥1 Conclusion thought.
**Output:** Incident scope + reproduction steps + blast radius assessment.

## Phase 2: Research — Gather Evidence

**Mode:** Not a thinker mode — use `architect` or `code` mode to:
- Read logs, stack traces, recent changes
- Use `codebase-retrieval` to find relevant code
- Check `git log` for recent commits
- Review monitoring/metrics

**Gate:** Evidence must be gathered before proceeding.
**Output:** Evidence inventory (file paths, log excerpts, recent changes).

## Phase 3: Adversarial — Alternative Explanations

**Mode:** `thinker-adversarial`
**Contract:** [`adversarial_thinking.md`](../adversarial_thinking.md)
**Objective:** What ELSE could explain the symptoms? Don't anchor on the first plausible cause.
**Input:** Phase 1 scope + Phase 2 evidence.
**Gate:** `generate_summary` must show ≥3 Analysis thoughts with different root cause hypotheses.
**Output:** Ranked list of potential causes with evidence for/against each.

## Phase 4: Concrete — Fix + Prevention

**Mode:** `thinker-concrete`
**Contract:** [`concrete_thinking.md`](../concrete_thinking.md)
**Objective:** Produce the fix plan AND the prevention plan.
**Input:** Phase 3 most-likely cause + Phase 2 evidence.
**Gate:** `generate_summary` must show ≥2 Conclusion thoughts with `check` tags.
**Output:** Fix checklist + regression test plan + postmortem actions.

## Orchestrator Instructions

1. Spawn `thinker-concrete` with incident description for scoping.
2. Read Phase 1 handoff. Conduct evidence gathering (Phase 2) directly or via code mode subtask.
3. Spawn `thinker-adversarial` with scope + evidence for alternative explanations.
4. Read Phase 3 handoff. Spawn `thinker-concrete` with most-likely cause for fix planning.
5. Compile: fix checklist + regression test + postmortem.

## Key Principle

**Don't anchor on the first explanation.** Phase 3 (adversarial) exists specifically to counter confirmation bias. The most common debugging failure mode is fixing the wrong thing because the first plausible cause "felt right."
