# Cognitive Services Architecture

> **Created:** 2026-03-09
> **Author:** Cascade (factory operator) + galeavenworth
> **Type:** Architecture decision / north-star document
> **Bead:** `repomap-core-0mp.2` (decision, P2, open)
> **Depends on:** `repomap-core-7l4` (trustworthy factory substrate)
> **Related:** `repomap-core-0mp.1` (Foreman control contracts — internal model)

---

## 1. What This Document Is

This document captures the architectural vision for the factory's external
interface and its evolution toward a cognitive services model. It is a
north-star document — it describes a trajectory, not an implementation plan.
It should be referenced by future beads without prescribing premature
implementation.

It does NOT gate any current work. It informs HOW future work is shaped,
particularly the Foreman (0mp), the artifact phases (ywk, 35t, 3k9), and
the thinker suite.

---

## 2. Where We Are

### The System Today

The factory is a software fabrication plant. It has two halves:

- **Repomap (the jig):** Deterministic scanning → `.repomap/` artifacts
- **The Dark Factory (the line):** Tiered agents under punch card enforcement

The factory's operating surface is currently bespoke:
- `factory_dispatch.sh` → kilo serve HTTP API → session creation
- Temporal workflows for orchestration and durability
- SSE → oc-daemon → Dolt for telemetry
- Beads for work decomposition and tracking
- Punch cards for quality enforcement
- DSPy compilation for prompt evolution

This surface works. It is the right surface for the current phase. But it
is only accessible to operators who know the factory's internal conventions.
If the factory's primary users are agents — and they are — then the factory
needs a standard agent-facing protocol.

### What Lands With 7l4

The factory substrate hardening epic (`repomap-core-7l4`) makes the
control plane trustworthy:

- Deterministic child/session lineage (no heuristic auto-resolution)
- Punch-card semantic correctness
- Cost budget enforcement
- Post-workflow session audit
- Raw SSE ledger for full-fidelity replay

This is the prerequisite for everything downstream. You cannot expose an
external interface to a system whose internal semantics are not yet sound.

### The Dependency Graph (Critical Path)

```
7l4 (substrate hardening) [in_progress, 6/7 closed]
  └── 4f0.13 (plant health composite) [open, ready]

7l4 ──blocks──► 0mp (Foreman)
                  ├── 0mp.1 (internal control contracts)
                  └── 0mp.2 (THIS DOCUMENT — external interface)

0mp ──blocks──► ywk  (Phase 2 — XRef + Call-Graph artifacts) [P0]
             ├── 35t  (Phase 3 — Artifact Query API)
             ├── 3k9  (Phase 4 — Change Slice Foundation)
             ├── jxn  (Phase 5 — Polish & 1.0)
             └── w1a  (SDK Prompt API Pivot)
```

The funnel is narrow. Everything downstream flows through the Foreman.
This document sits beside the Foreman's internal architecture (0mp.1)
as its external face.

---

## 3. The Seven Axes

Most multi-agent systems separate agents by task: planner, coder, reviewer.
The value of multiple agents is not extra labor. It is controlled
non-alignment — a single model wants to converge; a good multi-agent system
knows when not to.

The factory should evolve along seven axes of genuine cognitive diversity.
Here is where we stand on each.

### Axis 1: Epistemic Stance Diversity

Agents disagree for principled reasons.

**What we have:**
- `thinker-epistemic` — demands evidence, challenges assumptions
- `thinker-concrete` — compresses to actionable next steps
- `product-skeptic` — adversarial testing of proposals
- `architect` — structural reasoning across system boundaries

**What's missing:**
- No pure "assumption hunter" (surfaces unstated premises)
- No "reconstruction agent" (reverse-engineers the problem from the solution
  to detect silently dropped constraints)
- The thinker suite is still somewhat task-flavored — they produce outputs,
  not *pressure*

### Axis 2: Representation Diversity

The same problem exists in several forms at once.

**What we have:**
- Repomap already produces `deps.edgelist`, `calls.jsonl`, file lists,
  summaries — the same codebase in multiple representations
- This IS the core product. Representation diversity is repomap's thesis.

**What's missing:**
- Agents don't systematically compare representations to surface
  inconsistencies (e.g., "the dependency graph says simple but the call
  graph says complex — investigate")
- No agent turns a requirement into a state machine while another turns it
  into a failure-mode tree, then a third compares the forms

**Change slices (Phase 4) close this gap.** A change slice is a
graph-derived contract: "here is the structural boundary and blast radius
of this change." It's a representation that makes inconsistency between
the dependency view and the call-graph view *actionable*.

### Axis 3: Selective Ignorance

Partial views preserve real difference.

**What we have:**
- Nothing principled. All agents get full repo context via kilo serve.
- Omniscience causes correlation. Correlated agents are fake diversity.

**What's missing:**
- Information partitioning — some agents should see only requirements,
  some only logs, some only prior attempts, some only constraints
- This is a fundamental architectural gap

### Axis 4: Memory Ecology

Agents remember different kinds of history.

**What we have:**
- Dolt (telemetry: punches, sessions, messages, tool calls)
- Beads (issue lifecycle and dependency graphs)
- Git (code history)
- DSPy training data (what worked, extracted from Dolt)
- `.kilocode/thinking/` traces (structured reasoning examples)

These ARE different memory substrates. But agents don't differentially
access them.

**What's missing:**
- No "memory of near-misses" (sessions that almost worked)
- No "memory of analogies" (cross-domain pattern matches)
- No differential memory access per agent role

**Buildable on existing infrastructure:** Dolt tables could be partitioned
for different memory types. Different agents could query different views.
No new infrastructure needed.

### Axis 5: Time Horizon Diversity

Some think in moves, some in campaigns, some in infrastructure.

**What we have:**
- `code` agent — immediate execution (next action)
- `architect` — project arc (structural decisions)
- `plant-manager` — orchestration (work decomposition and sequencing)
- DSPy compiled prompts — strategic accumulation (artifacts that
  permanently make future work cheaper)

**What's missing:**
- No explicit "episode-level" thinker (what must be true over the next
  15 minutes of work?)
- No agent that explicitly optimizes for "what artifact, once created,
  permanently reduces future cost?"

**DSPy is already operating on the longest time horizon.** Compiled prompts
are strategic accumulation — they permanently improve future dispatches.
The self-learning loop is the factory's time-horizon-five agent.

### Axis 6: Arbitration Mechanisms

Not voting — calibration, markets, and evidence thresholds.

**What we have:**
- Punch cards = evidence thresholds. Required punches must be present.
  Forbidden punches must be absent. This is proof, not consensus.
- Checkpoints = pass/fail gates. Deterministic, not negotiated.
- Bounded gates = quality checks with fault contracts on failure.

**What's missing:**
- No confidence-weighted betting (agents wager on outcomes)
- No calibration scoring (agents lose influence when predictions fail)

**Buildable on existing telemetry:** Dolt already stores checkpoint pass/fail
rates per agent mode. Historical calibration could weight future dispatch
confidence. The data exists; the mechanism doesn't.

### Axis 7: Adaptive Reconfiguration

The system invents new cognitive roles when needed.

**What we have:**
- DSPy compilation — the system rewrites its own prompts from data
- `.kilocodemodes` — agent definitions are configuration, not code
- Prompt injection chain — compiled prompts are read at dispatch time

**What's missing:**
- No agent can spawn new agent types
- No detection of "we keep failing on X → create a specialist"
- This is the Foreman's future — the self-driving loop could detect
  repeated failures and request new cognitive roles

---

## 4. A2A: The Factory's External Interface

### The Protocol

Agent2Agent (A2A) is an open protocol (RC v1.0) for communication between
opaque agentic applications. Key primitives:

- **Agent Card** — JSON manifest of identity, capabilities, skills,
  endpoints, and auth requirements
- **Task** — stateful unit of work with lifecycle
  (submitted → working → completed/failed/canceled)
- **Message** — communication turn with Parts (text, files, structured data)
- **Artifact** — task output (documents, code, structured data)
- **Context** — groups related tasks and messages
- **Streaming** — SSE for real-time updates
- **Push Notifications** — webhooks for long-running tasks

### Three Surfaces

**Surface 1: Internal orchestration (Temporal + Beads + Punch Cards)**

A2A does NOT replace this. Temporal provides retries, timeouts,
continue-as-new, signals, queries, child workflows. A2A's HTTP-based task
model is weaker for intra-factory orchestration. Keep Temporal here.

**Surface 2: Factory-as-a-service (external agents → factory)**

This is the primary A2A use case. The factory publishes an Agent Card.
External clients — other agents, other factories, product managers,
customers — discover and use the factory via standard protocol.

The mapping:
- Agent Card skills → factory capabilities (code gen, review, analysis)
- A2A `SendMessage` → Temporal dispatch (factory line)
- A2A Task states → Temporal workflow states
- A2A Artifacts → git commits, PRs, analysis documents
- A2A Context → Beads issue threads
- A2A Push Notifications → existing SSE telemetry bridge

**Surface 3: Factory-to-world (factory → external A2A services)**

The factory becomes an A2A client, consuming external cognitive services:
constraint solvers, formal methods tools, failure-mode databases,
cost model services. These don't need to be LLMs. A2A doesn't care
what's behind the endpoint.

### The Thinker Suite as A2A Skills

Each thinker agent maps to an Agent Card skill:

| Skill ID | Name | Maps To |
|---|---|---|
| `code-generation` | Code Generation | code agent (full factory line) |
| `code-review` | Code Review | pr-review agent |
| `architecture-analysis` | Architecture Analysis | architect + thinker-concrete |
| `epistemic-grounding` | Epistemic Grounding | thinker-epistemic |
| `codebase-mapping` | Codebase Mapping | repomap pipeline |
| `change-slice` | Change Slice Analysis | Phase 4 artifact pipeline |
| `factory-dispatch` | Factory Dispatch | plant-manager (full factory line) |

These are not task-completion agents exposed as services. The thinker
agents emit *pressure* — grounding pressure, complexity pressure,
assumption pressure — that any A2A client can consume.

### A2A and MCP: Complementary, Not Competing

The A2A spec (Appendix B) explicitly states:

> *"An A2A Server agent might use MCP to interact with tools and data
> sources to fulfill the A2A task."*

- **MCP** = how an agent uses a tool (grep, file editing, Dolt queries)
- **A2A** = how agents collaborate as peers

The factory's agents use MCP internally. The factory exposes itself
via A2A externally.

### What A2A Enables That the Current Surface Cannot

1. **Opaque agents = enforced information partitioning.** A2A agents cannot
   leak internal state. This is selective ignorance by protocol, not
   discipline. (Axis 3.)

2. **Heterogeneous agents = real cognitive diversity.** An A2A service
   backed by a symbolic reasoner, a formal verifier, or a simulation engine
   speaks the same protocol as an LLM-backed service. Not "five bass
   players with different tuning." Actually different instruments. (Axis 2.)

3. **External pressure agents.** A2A skills whose output is not a solution
   but a gravitational distortion — complexity pressure, risk pressure,
   evidence pressure — consumable by any system. (Axis 1.)

4. **Memory ecology via different backends.** Different A2A services backed
   by different memory substrates — verified facts, near-misses, analogies,
   compressed abstractions — all composable. (Axis 4.)

---

## 5. The Closing Loop: Artifacts → Factory → Artifacts

The user's insight: once change slices exist (Phase 4), they feed back into
factory workflows and punch card enforcement.

```
Repomap artifacts (.repomap/)
    ↓ query surface (Phase 3: Artifact Query API)
Factory agents (plant-manager → specialists)
    ↓ change slice (Phase 4) defines blast radius
    ↓ agents work within the slice boundary
    ↓ punch cards enforce slice-scoped changes
    ↓ quality gates verify within slice
Repomap artifacts (.repomap/) ← regenerated, verified deterministic
    ↓
Punches + gate receipts → DSPy compilation → improved future runs
```

Change slices make the loop precise. Instead of "understand the whole
codebase," it becomes "understand exactly this blast radius." This is
where repomap artifacts stop being passive indexes and become active
contracts that bound agent behavior.

With A2A, an external agent can request: "Give me the change slice for
adding a rate limiter to this API endpoint." The factory returns the
slice as an Artifact — a graph-derived contract showing exactly which
files, functions, and dependencies are in scope. The agent (or another
factory) can then work within that contract.

---

## 6. What This Does NOT Change

- **`.kilocodemodes` stays** for kilo serve internal routing. Agent Cards
  are the external manifest; `.kilocodemodes` is internal config.
- **Temporal stays** as the orchestration engine. A2A is the facade, not
  the engine.
- **Punch cards stay** as internal quality enforcement, transparent to
  A2A clients.
- **DSPy compilation stays** internal. The self-improvement loop is not
  an API surface.
- **Beads stays** as work decomposition. A2A Context IDs map to beads
  threads, but beads is richer.
- **The critical path is unchanged.** 7l4 → 0mp → ywk → 35t → 3k9 → jxn.
  This document does not insert new gates.

---

## 7. Implementation Sequence (When the Time Comes)

This section is deliberately vague. Implementation should not begin until
the Foreman (0mp) has a working internal control model and at least Phase 2
artifacts (ywk) exist. Premature A2A implementation is worse than no A2A.

Likely sequence:
1. **Agent Card definition** — JSON manifest served from daemon HTTP surface.
   Forces formal declaration of factory capabilities.
2. **A2A JSON-RPC endpoints** on daemon — thin layer over Temporal dispatch
3. **SendMessage → Temporal dispatch mapping**
4. **Task state → workflow state mapping**
5. **Artifact production** — git commits, PR links, structured output as
   A2A Artifacts
6. **Push notifications** — bridge existing SSE telemetry

Each step is a bead, created when the prerequisites are met, not before.

---

## 8. Why This Document Lives Where It Does

This document is a child of the Foreman epic (`repomap-core-0mp`) and a
sibling of the Foreman control contracts (`repomap-core-0mp.1`).

**Why under 0mp:**
- The Foreman epic says "build the first true agent-first operator."
  A2A defines how external agents interact with that operator. Same
  concern, external face.
- The Foreman's self-driving loop IS the factory's operating surface.
  Its internal model (0mp.1) and external interface (this doc) are two
  faces of the same architecture.

**Why NOT top-level:**
- The factory's external interface is part of the factory's operating
  model, not a separate system.

**Why NOT under artifacts (ywk, 35t, 3k9):**
- A2A is about the factory's interface, not about any single artifact
  phase. Artifacts are produced BY the factory; A2A is HOW external
  agents consume the factory.

**Why NOT blocking anything:**
- This is a design document. It shapes how things are built, not what
  gets built next. The critical path remains 7l4 → 0mp → ywk → 35t →
  3k9 → jxn.
