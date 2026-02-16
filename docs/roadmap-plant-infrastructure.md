# Plant Infrastructure Roadmap

> **Scope:** Fabrication plant — workflow system, orchestration, observability, and self-healing.
> **Not in scope:** Application code (`src/`), product features, artifact generation.
> **Last updated:** 2026-02-15

## How to Read This

Phases are sequential. Within each phase, tasks can be done in any order unless a dependency arrow (→) says otherwise. Each task lists its bead ID for tracking.

```
✓ = closed    ○ = open    ◐ = pivoted/updated
```

---

## Phase 0: Research Foundation (Mostly Complete)

Research that informs all subsequent phases. Most is done or pivoted.

| # | Bead | Title | Status | Notes |
|---|------|-------|--------|-------|
| 1 | `repomap-core-82w` | Receipt infrastructure design | ✓ Closed | Persistence format + thinking session introspection decided |
| 2 | `repomap-core-c6j` | Mode interaction patterns | ✓ Closed | Answered by nested new_task experiment; absorbed into `4f0.5` |
| 3 | `repomap-core-wt5` | Token budget analysis | ◐ Updated | Expanded to include nesting cost profiles |
| 4 | `repomap-core-3wo` | Composability patterns | ◐ Pivoted | Was "MCP workflow engine"; now handoff contracts + return parsing |

**Remaining work:** `wt5` (token measurements) and `3wo` (composability patterns) are independent and can be done in any order. Both inform Phase 2 design decisions but are not strict blockers.

---

## Phase 1: Plant Manager Foundation

Stand up the Plant Manager role with minimal viable capabilities.

| # | Bead | Title | Depends On | Notes |
|---|------|-------|------------|-------|
| 1 | `repomap-core-4f0.1` | Plant Manager mode definition | — | First task. Define the mode in `.kilocodemodes`. |
| 2 | `repomap-core-4f0.2` | Workflow-specific gates | — | Can parallel with `.1`. Gate script for mode/skill/contract validation. |
| 3 | `repomap-core-4f0.3` | Composability handoff contracts | `.1` | Needs mode to exist before testing handoff packets. |

**Exit criteria:** Plant Manager mode exists, can be invoked, and has workflow gates that produce pass/fail.

**Suggested order:** `.1` → `.3`, with `.2` in parallel.

```
          ┌─── 4f0.1 (mode def) ──→ 4f0.3 (handoff contracts)
Phase 1 ──┤
          └─── 4f0.2 (workflow gates) ─────────────────────────→ Phase 1 complete
```

---

## Phase 2: Observability Infrastructure

Receipt auditing and factory inspection. Feeds health data into Plant Manager.

| # | Bead | Title | Depends On | Notes |
|---|------|-------|------------|-------|
| 1 | `repomap-core-9hd` | Phase A: Receipt manifests + `receipt_audit.py` | `82w` ✓ | Build the audit tooling |
| 2 | `repomap-core-9o8` | Phase B: Factory Inspector mode | `9hd` | Dual-use: standalone + spawnable by plant-manager |
| 3 | `repomap-core-4f0.4` | Factory-inspector integration as subtask | `4f0.1`, `9o8` | Plant Manager spawns Inspector, receives report |

**Exit criteria:** Plant Manager can spawn Factory Inspector, get a structured health report, and act on it.

**Suggested order:** `9hd` → `9o8` → `4f0.4` (strictly sequential — each depends on the prior).

```
Phase 2 ── 9hd (receipts) ──→ 9o8 (inspector mode) ──→ 4f0.4 (integration) ──→ Phase 2 complete
```

---

## Phase 3: Self-Healing & Feedback Loops

Plant Manager dispatches Fitter for workflow repairs. Inspector recommendations propagate.

| # | Bead | Title | Depends On | Notes |
|---|------|-------|------------|-------|
| 1 | `repomap-core-4f0.5` | Fitter dispatch from plant-manager | `4f0.1` | Absorbed from `c6j`. Contract verification + workflow fault handling. |
| 2 | `repomap-core-1jj` | Phase C: `/factory-health-check` workflow | `9o8`, `9uq` | Health check workflow using Inspector |
| 3 | `repomap-core-msm` | Inspector→Fitter→Orchestrator feedback loop | `9o8` | Simplified under composability. Orchestrator coordination. |

**Exit criteria:** Plant Manager can detect a workflow fault, dispatch Fitter, validate restoration, and the Inspector→Fitter recommendation loop works.

**Suggested order:** `4f0.5` can start as soon as Phase 1 is done. `1jj` and `msm` need Phase 2 complete.

```
          ┌─── 4f0.5 (fitter dispatch) ──────────────────────┐
Phase 3 ──┤                                                   ├─→ Phase 3 complete
          └─── 1jj (health-check workflow) + msm (feedback) ─┘
```

---

## Phase 4: Post-Workflow Self-Audit (Stretch)

Automatic self-audit after every workflow run.

| # | Bead | Title | Depends On | Notes |
|---|------|-------|------------|-------|
| 1 | `repomap-core-l5w` | Phase D: Post-workflow self-audit integration | `9hd`, `1jj` | Automatic Inspector invocation after workflow completion |

**Exit criteria:** Every workflow run automatically produces an audit receipt and flags anomalies.

---

## Phase Dependency Graph

```
Phase 0 (research)
  │
  ├──→ Phase 1 (plant-manager foundation)
  │      │
  │      ├──→ Phase 2 (observability)
  │      │      │
  │      │      └──→ Phase 3 (self-healing)
  │      │             │
  │      │             └──→ Phase 4 (self-audit)
  │      │
  │      └──→ Phase 3 partial (fitter dispatch doesn't need Phase 2)
  │
  └──→ Phase 2 partial (receipt tooling doesn't need Phase 1)
```

## Quick Reference: All Plant Beads by Epic

### Epic `repomap-core-4f0` — Plant Manager
| Bead | Title | Phase |
|------|-------|-------|
| `4f0.1` | Mode definition | 1 |
| `4f0.2` | Workflow gates | 1 |
| `4f0.3` | Handoff contracts | 1 |
| `4f0.4` | Inspector integration | 2 |
| `4f0.5` | Fitter dispatch | 3 |

### Epic `repomap-core-3wn` — Factory Observability
| Bead | Title | Phase |
|------|-------|-------|
| `82w` | Receipt design | 0 ✓ |
| `9hd` | Receipt manifests + audit tool | 2 |
| `9o8` | Factory Inspector mode | 2 |
| `1jj` | Health-check workflow | 3 |
| `l5w` | Post-workflow self-audit | 4 |
| `msm` | Feedback loop research | 3 |

### Epic `repomap-core-1tg` — Orchestration Research
| Bead | Title | Phase |
|------|-------|-------|
| `c6j` | Mode interaction patterns | 0 ✓ |
| `wt5` | Token budget + nesting costs | 0 |
| `3wo` | Composability patterns | 0 |

---

## For Future Agents

When starting work on plant infrastructure:

1. Run `.kilocode/tools/bd sync --no-push` to get latest bead state
2. Check this roadmap for the current phase
3. Pick the next unblocked task in phase order
4. Claim it: `.kilocode/tools/bd update <id> --status in_progress`
5. Use `process-orchestrator` mode for implementation tasks
6. Use `architect` mode for design/specification tasks
7. Run workflow gates (once `4f0.2` is done) in addition to code gates
8. Close the bead when done: `.kilocode/tools/bd close <id>`
9. Sync: `.kilocode/tools/bd sync`

**Key insight:** The plant-manager mode (once built) should be used to orchestrate changes to the plant itself. Until then, use process-orchestrator with awareness that `.kilocode/` is the "codebase" for plant tasks.
