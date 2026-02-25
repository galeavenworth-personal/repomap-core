# Project Intent

## Thesis

What started as **repomap** — a deterministic jig that turns a codebase into stable,
machine-readable artifacts — became an entire **dark factory** because we refused to
build repomap itself on vibes.

The jig needed a fabrication line. The fabrication line needed orchestration. The
orchestration needed enforcement. Now the jig and the factory are one system: a
self-improving codebase that manufactures its own tooling with the same rigor it
applies to the product.

This is a new species of system. Not a tool with some automation bolted on. Not an
"AI-assisted" repo. A software fabrication plant where agents operate under contracts,
punch cards enforce delegation discipline, and every session is bounded, auditable,
and composable.

LLMs made producing code cheap. The factory exists to make producing *correct* code cheap.

---

## Glossary of Primitives

- **Bead** — work unit (issue) with sync-branch lifecycle
- **Punch** — a recorded tool/action event (tool_call, child_spawn, gate_pass, etc.)
- **Punch card** — per-session ledger defining required and forbidden punches, verified at checkpoint
- **Gate** — deterministic check step (ruff, mypy, pytest) with pass/fail semantics and fault contracts on failure
- **Contract** — structured IO packet between roles (handoff, error propagation, restoration)
- **Fault contract** — payload emitted when a gate cannot complete (timeout, stall, env_missing)
- **Dolt** — versioned SQL database backing punches, punch cards, and checkpoints

---

## The Two Halves

### Repomap (the jig)

Deterministic repo scanning and artifact generation for agent-grade code understanding.

- Parses a codebase into symbols, dependency edges, and summaries
- Produces `.repomap/` — a small, stable, diffable artifact directory
- Same inputs → byte-identical outputs (cacheable, trustworthy)
- The query surface that agents use to understand code without re-parsing

Repomap is the jig that holds the workpiece steady while the factory operates on it.

### The Dark Factory (the fabrication line)

Multi-tier agent orchestration that builds, verifies, and maintains the codebase.

- **Tier 1 — Plant Manager**: strategic orchestrator, dispatches per-bead work
- **Tier 2 — Process Orchestrator**: tactical orchestrator, runs prep phases then
  dispatches sequential execution children
- **Tier 3 — Specialists**: architect (discover, explore, prepare), code (execute
  subtasks), fitter (restore faulted gates)

The factory runs on:
- **Punch cards** — ledger-based enforcement of tool usage, delegation patterns,
  and anti-delegation detection per session
- **Beads** — issue tracking with sync-branch model
- **Bounded gates** — quality checks (ruff, mypy, pytest) wrapped in timeout/stall
  detection with fault contracts
- **Composability contracts** — handoff packets, error propagation, nesting depth
  policy, mode interaction heuristic
- **Dolt** — versioned SQL database backing punch cards, punches, and checkpoints

---

## Architecture Invariants

These must remain true. Violating any of these is a defect, not a tradeoff.

1. **Orchestrators never implement.** Tier 1 and Tier 2 agents delegate via `new_task`.
   Punch cards enforce this — forbidden punches fail the checkpoint if an orchestrator
   calls `edit_file`, `apply_diff`, `write_to_file`, or `codebase_retrieval` directly.

2. **Every session is bounded.** Cost, tokens, and tool usage are capped per session.
   No single session should exceed ~$1. If a session would exceed its budget, it is
   killed, a checkpoint is written, and work resumes in a new session from that checkpoint.
   The factory scales horizontally (more sessions), not vertically (bigger sessions).

3. **Same inputs → same outputs.** Repomap artifacts are deterministic. If the source
   files haven't changed, the artifacts must be byte-identical.

4. **Delegation is the only scaling pattern.** Work is decomposed into children, never
   accumulated into monoliths. One objective per child. Within an objective, steps are
   sequential and receipt-driven. Concurrency only across independent objectives (e.g.,
   independent beads). Independent punch card enforcement per child.

5. **Quality gates are hard gates.** A failing gate blocks progression. It does not
   warn, suggest, or log-and-continue. Faulted gates produce fault contracts and
   dispatch fitters.

6. **Virtual environment mandate.** All Python execution uses `.venv/bin/python -m ...`.
   No global installs. No exceptions.

---

## Non-Goals

- **Narrative documentation.** Repomap produces indexes, not prose. Agents query
  structured artifacts, not generated summaries.
- **General-purpose AI framework.** This is not a library for building agent systems.
  It is one specific factory for one specific product.
- **Vibes-based development.** No "just let the AI figure it out." Every agent
  operates under explicit contracts, bounded budgets, and verifiable punch cards.
- **Monolithic sessions.** No single agent should do discovery + exploration +
  preparation + execution. That's four children, not one marathon.

---

## How The Two Halves Integrate

```
Repomap artifacts (.repomap/)
    ↓ query surface
Factory agents (plant-manager → process-orchestrator → specialists)
    ↓ use artifacts to understand codebase
    ↓ implement changes under punch card enforcement
    ↓ quality gates verify changes
Repomap artifacts (.repomap/) ← regenerated, verified deterministic
    ↓
Punches + gate receipts → contract/policy refinement → improved future runs
```

The factory uses repomap to understand the code it's changing.
Repomap is maintained by the factory.
Punch data and gate receipts feed back into contract and policy updates.
The loop closes.

---

## Origin

Repomap-core was built to give agents a reliable, deterministic view of a codebase.
But building it required the same rigor it was trying to provide — and the available
tools (vibe-coded AI workflows) didn't meet that bar. So the fabrication infrastructure
grew alongside the product: first beads for tracking, then punch cards for enforcement,
then tiered delegation for bounded cost, then bounded gates for deterministic quality
checks, then a governor for runaway detection, then Dolt for versioned audit trails.

The jig became the factory. The factory maintains the jig. Neither can exist without
the other, and that's the point.
