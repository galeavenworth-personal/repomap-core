# Token Budget Analysis — Specialized Orchestrator Modes vs Legacy Workflow `.md` Loading

**Date:** 2026-02-16  
**Bead:** `repomap-core-wt5`  
**Branch:** `repomap-core-wt5`  

## 1. Header: Scope + References

This document estimates the **token and cost overhead** of two orchestration approaches:

- **Approach A:** A *generic orchestrator* that loads one of the legacy workflow `.md` files at runtime (per task).
- **Approach B:** *Specialized orchestrator modes* with their definitions baked into `.kilocodemodes`.

Primary supporting evidence includes:

- `docs/research/nested-new-task-experiment-2026-02-15.md`
- `docs/research/orchestrator-composability-analysis-2026-02-15.md`

## 2. Original Questions (from bead intent)

1. How does **token overhead** compare between:
   - loading a legacy workflow `.md` at runtime (Approach A), vs
   - using a specialized orchestrator mode definition (Approach B)?
2. What is the **per-level context baseline** for a spawned subtask (system prompt + rules + environment details)?
3. What is the **nesting cost profile** for 1-level, 2-level, and 3-level nesting?
4. Is the total overhead **manageable for typical task sizes**, and does it justify the benefits of context isolation and task decomposition?

## 3. Methodology

### Token estimation

All token counts below are computed using the provided approximation:

> **Estimated tokens ≈ characters / 4**

This is a coarse heuristic (real tokenization varies), but it is consistent across all compared artifacts, so relative comparisons remain meaningful.

### What is being measured

This analysis focuses on **prompt-overhead tokens** (mode definitions, workflow files, shared baseline context), not the variable cost of:

- the user’s task payload,
- tool outputs,
- code diffs,
- model reasoning.

## 4. Table 1 — Approach A vs Approach B Token Comparison

**Assumption:** Approach A loads *one* workflow `.md` file per task, plus a generic orchestrator definition (~125 tokens). Approach B embeds the orchestrator behavior in a specialized mode definition (~964–971 tokens).

| Task / Workflow | Approach A workflow tokens | + Generic orchestrator tokens | **Approach A total** | Approach B mode | Approach B tokens | **Token savings (A − B)** | **Savings %** |
|---|---:|---:|---:|---|---:|---:|---:|
| start-task (`orchestrate-start-task.md`) | 4,059 | 125 | 4,184 | `process-orchestrator` | 971 | 3,213 | 76.8% |
| execute-task (`orchestrate-execute-task.md`) | 6,865 | 125 | 6,990 | `process-orchestrator` | 971 | 6,019 | 86.1% |
| refactor (`orchestrate-refactor.md`) | 4,871 | 125 | 4,996 | `process-orchestrator` | 971 | 4,025 | 80.6% |
| pressure-test (`orchestrate-pressure-test.md`) | 4,798 | 125 | 4,923 | `audit-orchestrator` | 964 | 3,959 | 80.4% |
| respond-to-pr-review (`orchestrate-respond-to-pr-review.md`) | 1,818 | 125 | 1,943 | (nearest: `process-orchestrator`) | 971 | 972 | 50.0% |

**Interpretation:** For the highest-frequency orchestration paths (start/execute/refactor/pressure-test), specialized modes eliminate roughly **77–86%** of workflow-instruction tokens compared to runtime-loading legacy workflow `.md` files.

The PR-review workflow is an outlier: it is already short, so the relative savings from switching to a specialized mode definition are only ~50%. This does not materially change the overall conclusion because the development lifecycle workflows dominate typical usage.

## 5. Table 2 — Per-Level Context Budget Breakdown (Baseline)

Each nested task level receives a baseline context injection from scratch (platform/system prompt + rules + environment details). The values below are the provided measurements/estimates.

| Baseline component (per nesting level) | Chars | Est. tokens | Notes |
|---|---:|---:|---|
| Platform chrome (tool descriptions, etc.) | ~40,000–48,000 | ~10,000–12,000 | Largely fixed; determined by platform/tooling surface |
| Rules files (`.kilocode/rules/`) | 29,557 | ~7,389 | Dominant deterministic payload; policy + workflow constraints |
| `AGENTS.md` | 2,213 | ~553 | Repo-level policy and Beads workflow |
| Mode definition (specialized) | 3,855–3,882 | ~964–971 | `process-orchestrator`, `audit-orchestrator` |
| Environment details (file tree, git, open tabs) | 3,000–8,000 | ~750–2,000 | Variable; depends on workspace state |
| **Total per-level baseline** |  | **~19,663–22,913** | Range is driven primarily by platform chrome + env details |

### Observed dominance

- Rules are ~7,389 tokens vs ~971 for a specialized mode definition.
- Ratio: **~7.6× larger** rules payload than the mode definition.

This implies that, while specialized modes yield real savings vs workflow `.md` loading, the **largest lever for reducing per-level overhead is rules loading strategy**, not mode definition size.

## 6. Table 3 — Nesting Cost Profile (1 / 2 / 3 Levels)

Two representations are useful:

1. **Token budget** (baseline prompt size scaling with depth)
2. **Observed cost** (from the nesting experiment)

### 6.1 Token scaling with depth (baseline only)

| Nesting depth | Baseline tokens per level | **Total baseline tokens** |
|---:|---:|---:|
| 1 level | ~19,663–22,913 | ~19,663–22,913 |
| 2 levels | ~19,663–22,913 | ~39,326–45,826 |
| 3 levels | ~19,663–22,913 | ~58,989–68,739 |

### 6.2 Dollar cost profile (empirical)

From `nested-new-task-experiment-2026-02-15.md`:

- 3-level nesting test total cost: **~$0.25**
- estimated per-level system prompt overhead: **~$0.08 / level**

| Nesting depth | Approx. overhead / level | **Approx. total overhead** | Evidence |
|---:|---:|---:|---|
| 1 level | ~$0.08 | ~$0.08 | derived from 3-level experiment |
| 2 levels | ~$0.08 | ~$0.16 | linear estimate |
| 3 levels | ~$0.08 | ~$0.25 | observed (~$0.25 total) |

## 7. Break-Even Analysis

### Inputs

- Nesting overhead: **~$0.08 / level**
- Context-bloat retry cost: **$0.50–$2.00** per prevented retry (estimated typical)

### Break-even framing

If deeper nesting prevents even a small number of retries due to:

- tighter context isolation,
- clearer handoff packets,
- smaller, bounded deliverables,

then the overhead can be repaid quickly.

Given the stated break-even heuristic:

> Break-even: **less than 1 prevented retry per 10 nested tasks**

We can sanity-check:

- 10 nested tasks at +$0.08 each = **$0.80 overhead**
- Preventing a single retry valued at $0.50–$2.00 yields:
  - worst case: $0.50 return (slightly under)
  - typical: $1.00+ return (positive)
  - upper range: $2.00 return (strongly positive)

Because many “retry” loops cost more than one extra call (additional tool runs, extra analysis turns), the ROI is generally expected to be positive.

## 8. Key Findings

1. For start/execute/refactor/pressure-test, specialized orchestrator modes are **~77–86% more token-efficient** than runtime-loading legacy workflow `.md` instructions.
2. The **rules payload (~7,400 tokens)** dominates per-level baseline context; it is **~7.6× larger** than a specialized orchestrator mode definition (~970 tokens).
3. Nesting overhead is small: **~$0.08 / level** in the empirical test, which is negligible compared to typical task costs (**$0.50–$3.00**) and especially negligible compared to the cost of retries.
4. Context isolation has strong expected ROI: the break-even threshold (prevent < 1 retry per 10 nested tasks) is easy to meet in practice when tasks are decomposed into bounded subtasks with explicit handoff packets.

## 9. Decision

**Proceed with the specialized orchestrator architecture.**

Rationale:

- The per-task instruction overhead is materially reduced vs legacy workflow `.md` runtime loading.
- The per-level overhead of nesting is operationally acceptable.
- The benefits of context discipline (reduced bloat and fewer retries) plausibly dominate the added baseline cost of nesting.

## 10. Optimization Recommendations

1. **Rules compression / selective rules loading**
   - Biggest lever: rules dominate baseline tokens.
   - If mode-specific rules can be loaded instead of always loading the full ruleset, per-level baseline would drop substantially.
2. **Environment details pruning**
   - Reduce injected environment detail size where possible (e.g., refine `.kilocodeignore`, prune irrelevant workspace listings).
3. **Limit nesting depth to 2 levels (recommended)**
   - Parent → child → grandchild is enough for most decompositions.
   - 3+ levels are possible but should be reserved for exceptional cases.

## 11. References

- `docs/research/nested-new-task-experiment-2026-02-15.md`
- `docs/research/orchestrator-composability-analysis-2026-02-15.md`
- `docs/research/repomap-core-4g0-custom-mode-new-task-findings.md`
- `docs/research/repomap-core-4g0-decision.md`
