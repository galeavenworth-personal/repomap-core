# Plant Infrastructure Roadmap

> **Scope:** Fabrication plant — workflow system, orchestration, observability, durable memory, and punch card verification.
> **Not in scope:** Application code (`src/`), product features, artifact generation.
> **Last updated:** 2026-02-23
> **Revision:** v3.3 — Monorepo consolidation (daemon absorbed into `daemon/`)

## How to Read This

Phases are sequential. Within each phase, tasks can be done in any order unless a dependency arrow (→) says otherwise. Each task lists its bead ID for tracking.

```
✓ = closed    ○ = open    ◐ = pivoted/updated    ✗ = cut (absorbed or unnecessary)
```

---

## The Evolution: What Changed (v2.1 → v3.0 → v3.1 → v3.2 → v3.3)

### The Verification Paradox

- Verifying only at the end is too heavy (wasted work on failure).
- Verifying every step doubles execution cost and suffocates flow.

### The Solution: Punch Card Semantics

> Execution proceeds freely.
> Punches accumulate automatically.
> Verification occurs only at task exit.
> Tasks cannot complete without a valid punch card.
> Parents cannot complete without valid child punch cards.

### Design Document

Full design rationale, execution model, delegation stack, and Temporal evaluation:
[`docs/research/punch-card-integration-2026-02-18.md`](../docs/research/punch-card-integration-2026-02-18.md)

### Schema

Dolt DDL for punch card tables:
[`plans/punch-card-schema.sql`](punch-card-schema.sql)

### v2 → v3 Changes

| v2.1 | v3.0 |
|------|------|
| Session data as informal receipts | Session data → structured punches in Dolt |
| No formal exit gating | Punch card validation required at task exit |
| Parent-child linked by timing heuristic | Parent-child linked by delegation proof + commit hash |
| Cost data scattered in JSON | Cost data in SQL with recursive rollup |
| Beads ~8 work items | Beads ~10 work items (+2 new) |
| 3 phases (+ stretch) | 3 phases (+ stretch), same structure |

### v3.0 → v3.1 Changes

| v3.0 | v3.1 |
|------|------|
| Daemon under `.kilocode/daemon/` in repomap-core | Daemon in own repo (`repomap-plant-daemon`) |
| `4f0.14` bundles schema + daemon | Split: `4f0.14a` (schema, repomap-core) + `daemon-001` (repomap-plant-daemon) |
| Single-repo bead tracking | Multi-repo Beads with cross-repo deps (prefixes: `core`, `daemon`) |
| 4 phases | 5 phases (Phase 5: Parallel Line Operations placeholder) |
| No multi-repo guidance | Multi-repo setup in "For Future Agents" section |

**Design rationale:** [`docs/research/multi-repo-plant-architecture-2026-02-18.md`](../docs/research/multi-repo-plant-architecture-2026-02-18.md)
**Beads multi-repo research:** [`docs/research/beads-dolt-and-multi-repo.md`](../docs/research/beads-dolt-and-multi-repo.md)

> **Note (v3.3):** v3.1's multi-repo split was reversed in v3.3. The daemon now lives at `daemon/` within repomap-core. The research docs above remain valid for understanding the design evolution.

### v3.1 → v3.2 Changes

| v3.1 | v3.2 |
|------|------|
| Daemon data source unspecified (filesystem watching / JSON parsing assumed) | Daemon uses `kilo serve` SSE event stream via `@opencode-ai/sdk` |
| Parent-child correlation via timing heuristic or `child_relationships` table | Parent-child correlation via first-class `GET /session/:id/children` API endpoint |
| Custom HTTP calls or JSON parsing for session data | Type-safe SDK client (`createOpencodeClient`) with OpenAPI-generated types |
| Daemon health check unspecified | Daemon health via `GET /global/health` built into `kilo serve` |
| Phase 5: one daemon per worktree (or shared) | Phase 5: single daemon per `kilo serve` instance observes all parallel sessions |
| No daemon dependency specification | Daemon deps: `@opencode-ai/sdk` + `mysql2` (two packages) |

**Research:** [`docs/research/kilo-cli-server-daemon-integration-2026-02-19.md`](../docs/research/kilo-cli-server-daemon-integration-2026-02-19.md)

### v3.2 → v3.3 Changes

| v3.2 | v3.3 |
|------|------|
| Daemon in separate repo (`repomap-plant-daemon` / `oc-daemon`) | Daemon absorbed into `repomap-core/daemon/` subdirectory |
| Multi-repo Beads with cross-repo routing (`../oc-daemon`) | Single-repo Beads with local routing (`./daemon`) |
| `daemon-001` bead tracked in separate repo | `daemon-001` bead tracked locally in repomap-core |
| Cross-repo `bd config set repos.additional` required | No cross-repo config needed — daemon is local |
| Phase 5 references "single daemon per `kilo serve`" in separate repo | Phase 5 references `daemon/` subdirectory within monorepo |
| Two repos to clone and maintain | Single repo; daemon is a TypeScript subdirectory |

**Rationale:** Multi-repo overhead (cross-repo beads routing, separate CI, dual clone requirement) exceeded the benefit of repository isolation for a tightly-coupled sidecar daemon. The daemon's only consumers are plant infrastructure tools in repomap-core.

---

## Phase 0: Research Foundation (Complete)

Research that informed all subsequent phases. All items are closed or absorbed.

| # | Bead | Title | Status | Notes |
|---|------|-------|--------|-------|
| 1 | `repomap-core-82w` | Receipt infrastructure design | ✓ Closed | Persistence format decided; **superseded by session data discovery** |
| 2 | `repomap-core-c6j` | Mode interaction patterns | ✓ Closed | Answered by nested `new_task` experiment |
| 3 | `repomap-core-wt5` | Token budget analysis | ✓ Closed | Nesting cost profiles measured; session monitor provides live cost |
| 4 | `repomap-core-3wo` | Composability patterns | ✓ Closed | Was "MCP workflow engine" → pivoted to command dialect + routing matrix |

---

## Phase 1: Plant Manager Foundation (Complete)

The Plant Manager role with minimal viable capabilities.

| # | Bead | Title | Status | Notes |
|---|------|-------|--------|-------|
| 1 | `repomap-core-4f0.1` | Plant Manager mode definition | ✓ Closed | Mode exists in `.kilocodemodes` |
| 2 | `repomap-core-4f0.2` | Workflow-specific gates | ✓ Closed | [`workflow_gate.py`](../.kilocode/tools/workflow_gate.py) validates modes/skills/contracts |
| 3 | `repomap-core-4f0.3` | Composability handoff contracts | ✓ Closed | Contracts exist under [`.kilocode/contracts/`](../.kilocode/contracts/) |

---

## Phase 2: Command Infrastructure + Durable Memory

Build the command dialect as the plant's instruction language. Establish Dolt as the durable memory substrate. Ground it in actual infrastructure.

| # | Bead | Repo | Title | Depends On | Status | Notes |
|---|------|------|-------|------------|--------|-------|
| 1 | `core-4f0.6` | repomap-core | Ground routing matrix in actual infrastructure | — | ✓ Closed | [routing-matrix-inventory](../docs/research/routing-matrix-inventory-2026-02-18.md) |
| 2 | `core-4f0.7` | repomap-core | Build `commands.toml` configuration | `4f0.6` | ✓ Closed | The routing matrix: verb+noun → skill binding + tool template |
| 3 | `core-4f0.8` | repomap-core | Compressed workflow proof | `4f0.7` | ✓ Closed | [compressed-workflow-proof](../docs/research/compressed-workflow-proof-2026-02-20.md) |
| 4 | `core-4f0.9` | repomap-core | Parent-child correlation + delegation proof | — | ◐ Expanded | **v3:** Now includes delegation proof via `child_relationships` table + punch-based verification |
| 5 | `core-4f0.14a` | repomap-core | Dolt schema initialization | — | ○ New | **v3.1:** Split from `4f0.14`. DDL from [`punch-card-schema.sql`](punch-card-schema.sql), Dolt init |
| 6 | `daemon-001` | repomap-core (`daemon/`) | Replication daemon MVP | `core-4f0.14a` | ○ New | **v3.3:** Absorbed into monorepo. `@opencode-ai/sdk` + SSE event stream → classify → mint punches → Dolt. Sidecar to `kilo serve`. |

**Exit criteria:**
- `commands.toml` exists and maps all current quality gate + beads operations to actual skills/tools
- One workflow (quality gates) runs via command dialect and produces verifiable session data
- `kilo_session_monitor.py children` command shows subtask tree with cost rollup
- **Dolt database initialized with punch schema** (tables: `tasks`, `punches`, `punch_cards`, `checkpoints`, `child_relationships`)
- **Replication daemon runs and mints punches** from live session events (or batch-at-gate fallback works)

**Suggested order:** `4f0.6` ✓ → `4f0.7` ✓ → `4f0.8` ✓, with `4f0.9` and `4f0.14a` in parallel. `daemon-001` follows `4f0.14a`.

```
          ┌─── 4f0.6 (inventory) ✓ → 4f0.7 (TOML) ✓ → 4f0.8 (proof) ✓ ──┐
Phase 2 ──┤                                                                ├→ Phase 2 complete
          ├─── 4f0.9 (parent-child + delegation proof) ───────────────────┘
          └─── 4f0.14a (Dolt schema) → daemon-001 (daemon/, monorepo) ───┘
```

---

## Phase 3: Punch-Gated Deployment Loop

The closed loop: deploy bounded cognition, verify via punch card at exit, commit to Dolt.

| # | Bead | Title | Depends On | Status | Notes |
|---|------|-------|------------|--------|-------|
| 1 | `repomap-core-4f0.5` | Fitter dispatch via command dialect | `4f0.7` | ○ Open | "Dispatch to fitter" becomes a routable command |
| 2 | `repomap-core-4f0.10` | Cost budget enforcement | `4f0.9`, `4f0.14a` | ◐ Updated | Cost queries via Dolt `cost_aggregate` view |
| 3 | `repomap-core-4f0.11` | Punch-card-verified completion | `4f0.9`, `4f0.7`, `4f0.14a` | ◐ Expanded | **v3:** Task exit blocked unless punch card validates; parent verifies child punch cards |
| 4 | `repomap-core-4f0.15` | Punch engine implementation | `4f0.14a`, `4f0.9` | ○ New | **v3:** Minting rules, card evaluation, `DOLT_COMMIT` on gate pass |

**Exit criteria:**
- Plant Manager can dispatch Fitter via command dialect and verify restoration via session data
- Cost budget enforcement prevents subtask runaway spend
- **No task can complete without a valid punch card**
- **No parent can complete without valid child punch cards**
- **All verification queries durable Dolt-backed state**
- The full loop works: command → spawn → monitor → verify → **punch-validate** → **commit** → act

```
          ┌─── 4f0.5 (fitter via dialect) ──────────────────┐
Phase 3 ──┤── 4f0.10 (cost budget via Dolt) ────────────────├→ Phase 3 complete
          ├─── 4f0.11 (punch-card-verified completion) ─────┘
          └─── 4f0.15 (punch engine) ───────────────────────┘
```

---

## Phase 4: Self-Healing & Self-Audit (Stretch)

Automatic post-workflow audit. Plant Manager inspects its own work.

| # | Bead | Title | Depends On | Status | Notes |
|---|------|-------|------------|--------|-------|
| 1 | `repomap-core-4f0.12` | Post-workflow session audit | `4f0.9`, `4f0.14a` | ○ Open | Queries Dolt for anomalies (missing gates, high cost, stalls) |
| 2 | `repomap-core-4f0.13` | Plant health composite command | `4f0.7`, `4f0.9`, `4f0.14a` | ○ Open | Includes punch card validity in health report |

**Exit criteria:** Every workflow run automatically produces an audit summary. `Inspect plant-health` returns a structured health report including punch card status.

---

## Phase 5: Parallel Line Operations (Not Yet Scoped)

> Added in v3.1. Execution substrate already exists via Kilo CLI parallel agents.
> Updated in v3.2: `kilo run --attach` pattern validates single-daemon-per-server model.

**Execution substrate:** Kilo CLI parallel agents + git worktrees (already exists).
**Orchestration:** Temporal wrapping N concurrent `kilo run --attach http://localhost:4096` invocations.
**Observability:** Per-worktree Dolt branches, cross-line aggregation.
**Daemon:** Single `daemon/` instance per `kilo serve` server observes all parallel sessions via SSE event stream. Per-worktree daemons remain an option for isolation but are not required.
**Prerequisites:** Phases 2-3 complete (one provable line running end-to-end).
**Scoping begins** after Phase 3 exit criteria are met.

See: [Kilo CLI parallel agents](https://kilo.ai/features/parallel-agents-cli), [Strategic decisions — Decision 3](../docs/research/roadmap-v3-strategic-decisions-2026-02-18.md), [Kilo CLI server integration](../docs/research/kilo-cli-server-daemon-integration-2026-02-19.md)

---

## Phase Dependency Graph

```
Phase 0 (research) ✓
  │
  └──→ Phase 1 (plant-manager foundation) ✓
         │
         └──→ Phase 2 (command infrastructure + durable memory)
                │
                └──→ Phase 3 (punch-gated deployment)
                       │
                       ├──→ Phase 4 (self-healing, stretch)
                       │
                       └──→ Phase 5 (parallel line operations, not yet scoped)
```

---

## Bead Disposition: What Changed

### CUT (Absorbed by Session Data Discovery) — All Closed in DB

| Old Bead | Old Title | Disposition |
|----------|-----------|-------------|
| `repomap-core-9hd` | Receipt manifests + `receipt_audit.py` | ✓ **ABSORBED.** [`kilo_session_monitor.py`](../.kilocode/tools/kilo_session_monitor.py) IS the receipt query tool. |
| `repomap-core-9o8` | Factory Inspector mode | ✓ **CUT.** Plant Manager reads session data directly. No separate mode needed. |
| `repomap-core-4f0.4` | Factory-inspector integration | ✓ **CUT.** No Inspector mode to integrate. |
| `repomap-core-msm` | Inspector→Fitter→Orchestrator feedback loop | ✓ **ABSORBED.** Loop is now: command → spawn → monitor → verify. |

### SIMPLIFIED — Old Beads Closed, New Beads Created

| Old Bead | Old Title | New Bead | New Form |
|----------|-----------|----------|----------|
| `repomap-core-1jj` | `/factory-health-check` workflow | `repomap-core-4f0.13` | Single composite command reading session data |
| `repomap-core-l5w` | Post-workflow self-audit | `repomap-core-4f0.12` | Session-based audit, not separate infrastructure |
| `repomap-core-4f0.5` | Fitter dispatch | `repomap-core-4f0.5` | Same bead, refined: dispatch via command dialect, verify via session data |

### EXPANDED (v3.0)

| Bead | Old Title | New Title | What Changed |
|------|-----------|-----------|-------------|
| `repomap-core-4f0.9` | Parent-child task correlation | Parent-child correlation + delegation proof | Now includes `child_relationships` table, punch-based delegation |
| `repomap-core-4f0.11` | Command-triggered subtask verification | Punch-card-verified completion | Exit requires punch card validation |
| `repomap-core-4f0.10` | Cost budget enforcement | Cost budget enforcement (via Dolt) | Queries `cost_aggregate` view instead of parsing files |

### NEW (v3.0) / SPLIT (v3.1)

| Bead | Repo | Title | Phase | Priority | Notes |
|------|------|-------|-------|----------|-------|
| `core-4f0.14a` | repomap-core | Dolt schema initialization | 2 | P1 | **v3.1:** Split from `4f0.14` — schema only |
| `daemon-001` | repomap-core (`daemon/`) | Replication daemon MVP | 2 | P1 | **v3.3:** Absorbed into monorepo at `daemon/` |
| `repomap-core-4f0.15` | repomap-core | Punch engine implementation | 3 | P2 | Unchanged |

### Closed Epics

| Epic | Disposition |
|------|-------------|
| `repomap-core-1tg` | ✓ **COMPLETE.** All children closed (c6j, wt5, 3wo). Orchestration research concluded. |
| `repomap-core-3wn` | ✓ **COMPLETE.** All children closed/absorbed by roadmap v2 pivot. |

### Bead ID Mapping (All Versions)

| Planned ID | Actual Bead | Repo | Title | Phase |
|------------|-------------|------|-------|-------|
| `3wo.1` | `core-4f0.6` | repomap-core | Ground routing matrix | 2 |
| `3wo.2` | `core-4f0.7` | repomap-core | Build `commands.toml` | 2 |
| `3wo.3` | `core-4f0.8` | repomap-core | Compressed workflow proof | 2 |
| `mon.1` | `core-4f0.9` | repomap-core | Parent-child correlation + delegation proof | 2 |
| `4f0.5` | `core-4f0.5` | repomap-core | Fitter dispatch via dialect | 3 |
| `mon.2` | `core-4f0.10` | repomap-core | Cost budget enforcement (via Dolt) | 3 |
| `vfy.1` | `core-4f0.11` | repomap-core | Punch-card-verified completion | 3 |
| `aud.1` | `core-4f0.12` | repomap-core | Post-workflow session audit | 4 |
| `hlth.1` | `core-4f0.13` | repomap-core | Plant health composite | 4 |
| — | `core-4f0.14a` | repomap-core | Dolt schema initialization | 2 |
| — | `daemon-001` | repomap-core (`daemon/`) | Replication daemon MVP | 2 |
| — | `core-4f0.15` | repomap-core | Punch engine implementation | 3 |

---

## Quick Reference: All Active Plant Beads

All plant beads are now in a single monorepo. Beads use prefix `core` for Python/plant-config work and `daemon` for the TypeScript daemon at `daemon/`.

### Phase 2: Command Infrastructure + Durable Memory
| Bead | Repo | Title | Priority | Status |
|------|------|-------|----------|--------|
| `core-4f0.6` | repomap-core | Ground routing matrix | P1 | ✓ Closed |
| `core-4f0.7` | repomap-core | Build `commands.toml` | P1 | ✓ Closed |
| `core-4f0.8` | repomap-core | Compressed workflow proof | P2 | ✓ Closed |
| `core-4f0.9` | repomap-core | Parent-child correlation + delegation proof | P1 | ◐ Expanded |
| `core-4f0.14a` | repomap-core | Dolt schema initialization | P1 | ○ New (split) |
| `daemon-001` | repomap-core (`daemon/`) | Replication daemon MVP | P1 | ○ New (monorepo) |

### Phase 3: Punch-Gated Deployment
| Bead | Repo | Title | Priority | Status |
|------|------|-------|----------|--------|
| `core-4f0.5` | repomap-core | Fitter dispatch via dialect | P2 | ○ Open |
| `core-4f0.10` | repomap-core | Cost budget enforcement (via Dolt) | P2 | ◐ Updated |
| `core-4f0.11` | repomap-core | Punch-card-verified completion | P2 | ◐ Expanded |
| `core-4f0.15` | repomap-core | Punch engine implementation | P2 | ○ New |

### Phase 4: Self-Healing (Stretch)
| Bead | Repo | Title | Priority | Status |
|------|------|-------|----------|--------|
| `core-4f0.12` | repomap-core | Post-workflow session audit | P3 | ○ Open |
| `core-4f0.13` | repomap-core | Plant health composite | P3 | ○ Open |

### Phase 5: Parallel Line Operations (Not Yet Scoped)
| Bead | Repo | Title | Priority | Status |
|------|------|-------|----------|--------|
| — | — | To be scoped after Phase 3 complete | — | ○ Not scoped |

---

## Already Built (Assets in Hand)

| Asset | Location | What It Does |
|-------|----------|--------------|
| Plant Manager mode | [`.kilocodemodes`](../.kilocodemodes) | Three-tier orchestration with handoff packets |
| Workflow gates | [`.kilocode/tools/workflow_gate.py`](../.kilocode/tools/workflow_gate.py) | Mode/skill/contract validation |
| Bounded gate runner | [`.kilocode/tools/bounded_gate.py`](../.kilocode/tools/bounded_gate.py) | Command wrapping with timeout/stall detection |
| Landing script | [`.kilocode/tools/beads_land_plane.sh`](../.kilocode/tools/beads_land_plane.sh) | Quality gate orchestration + bead closure |
| Session monitor | [`.kilocode/tools/kilo_session_monitor.py`](../.kilocode/tools/kilo_session_monitor.py) | Live self-monitoring: whoami, timeline, cost, tools, tail, receipts |
| Handoff contracts | [`.kilocode/contracts/`](../.kilocode/contracts/) | Line fault, restoration, handoff, error propagation, return format |
| Existing skills (7) | [`.kilocode/skills/`](../.kilocode/skills/) | beads, context7, github-cli, codebase-retrieval, sequential-thinking, sonarqube |
| Gate audit log | [`.kilocode/gate_runs.jsonl`](../.kilocode/gate_runs.jsonl) | Historical gate execution records |
| Command dialect design | [`docs/research/command-dialect-exploration.md`](../docs/research/command-dialect-exploration.md) | 12 verbs × 12 nouns, routing matrix draft |
| Dialect review | [`docs/research/command-dialect-exploration-review.md`](../docs/research/command-dialect-exploration-review.md) | Grounding gaps identified, migration path |
| Dolt exploration | [`docs/research/dolt-versioned-state-exploration-2026-02-17.md`](../docs/research/dolt-versioned-state-exploration-2026-02-17.md) | Fifth axis: versioned, queryable, branchable plant state |
| Routing matrix inventory | [`docs/research/routing-matrix-inventory-2026-02-18.md`](../docs/research/routing-matrix-inventory-2026-02-18.md) | Grounded inventory of all actual infrastructure |
| Punch card design | [`docs/research/punch-card-integration-2026-02-18.md`](../docs/research/punch-card-integration-2026-02-18.md) | Punch semantics, schema, execution model, delegation, Temporal eval |
| Punch card schema | [`plans/punch-card-schema.sql`](punch-card-schema.sql) | Dolt DDL for punch card tables |
| Beads multi-repo research | [`docs/research/beads-dolt-and-multi-repo.md`](../docs/research/beads-dolt-and-multi-repo.md) | Dolt backend + multi-repo task management capabilities |
| Multi-repo architecture | [`docs/research/multi-repo-plant-architecture-2026-02-18.md`](../docs/research/multi-repo-plant-architecture-2026-02-18.md) | Repo topology, Beads config, cross-repo deps, agent patterns |
| Strategic decisions | [`docs/research/roadmap-v3-strategic-decisions-2026-02-18.md`](../docs/research/roadmap-v3-strategic-decisions-2026-02-18.md) | Kilo CLI facts, daemon language, 4f0.14 split, Phase 5, multi-repo |
| Kilo CLI server integration | [`docs/research/kilo-cli-server-daemon-integration-2026-02-19.md`](../docs/research/kilo-cli-server-daemon-integration-2026-02-19.md) | `kilo serve` SSE + SDK as daemon data source; eliminates filesystem watching |
| Compressed workflow proof | [`docs/research/compressed-workflow-proof-2026-02-20.md`](../docs/research/compressed-workflow-proof-2026-02-20.md) | Command dialect 97–99% token reduction vs verbose scripts; breakeven at 3 invocations |

---

## The Six-Axis Plant Architecture

v3.0 introduces a sixth axis: **Verification**.

| # | Axis | What It Does | Primitive | Source |
|---|------|-------------|-----------|--------|
| 1 | **Control** | Execution topology — when/what to run | `new_task` tree | [dual-graph-architecture](../docs/research/dual-graph-architecture-2026-02-17.md) |
| 2 | **Capability** | Traversal policy — what's allowed | Modes → skills → tools | [dual-graph-architecture](../docs/research/dual-graph-architecture-2026-02-17.md) |
| 3 | **Instruction** | Compressed triggers — how to invoke | Verb+Noun → skill binding | [command-dialect-exploration](../docs/research/command-dialect-exploration.md) |
| 4 | **Observability** | Proof of execution — what happened | Session JSON, self-monitoring | [kilo-session-data-as-receipts](../docs/research/kilo-session-data-as-receipts.md) |
| 5 | **State** | Versioned memory — what the plant knows | Dolt SQL + git semantics | [dolt-versioned-state](../docs/research/dolt-versioned-state-exploration-2026-02-17.md) |
| 6 | **Verification** | Structural exit gating — what's proven | Punch cards + delegation proof | [punch-card-integration](../docs/research/punch-card-integration-2026-02-18.md) |

**The complete loop:**

```
Command → Spawn → Execute → Replicate → Mint Punches → Verify Card → Commit → Query
   (3)     (1)      (2)       (4)          (6)           (6)         (5)      (5)
```

---

## Key Insight: Why This Works

The old roadmap assumed we needed to **construct** observability from scratch. v2 revealed:

1. **Kilo Code already captures everything** — tool calls, commands, MCP invocations, costs, timestamps, diffs, completion results.
2. **Agents can read their own session data in real-time** — synchronous disk writes, millisecond precision.
3. **3-word commands exploit model pre-training** — "Format with ruff" triggers the full procedure.
4. **`new_task` nesting provides bounded cognition** — Context isolation prevents pollution.

v3 adds:

5. **Dolt provides durable, queryable state** — SQL + git semantics for plant memory.
6. **Punch cards provide structural verification** — Terminal gating without mid-step policing.
7. **Delegation proof makes the stack provable** — Children self-validate; parents verify at boundary.

v3.2 adds:

8. **`kilo serve` is the canonical data path** — The daemon taps the same server the TUI uses; no custom observability plumbing needed.
9. **`@opencode-ai/sdk` provides type-safe session access** — Parent-child correlation, messages, diffs, and health are first-class API endpoints.

---

## For Future Agents

When starting work on plant infrastructure:

1. Run `.kilocode/tools/bd sync --no-push` to get latest bead state
2. Check this roadmap for the current phase
3. Pick the next unblocked task in phase order
4. Claim it: `.kilocode/tools/bd update <id> --status in_progress`
5. Use `process-orchestrator` mode for implementation tasks
6. Use `architect` mode for design/specification tasks
7. Run `python3 .kilocode/tools/kilo_session_monitor.py whoami` to identify your task
8. Run workflow gates + `workflow_gate.py` before landing
9. Close the bead when done: `.kilocode/tools/bd close <id>`
10. Sync: `.kilocode/tools/bd sync`

**The plant-manager mode orchestrates changes to the plant itself.** Use it for mode/skill/contract/workflow modifications. Delegate `src/` work to `process-orchestrator`.

### Monorepo Layout (v3.3)

Plant infrastructure is consolidated in a single monorepo. The daemon lives at `daemon/` as a TypeScript subdirectory with its own `package.json`.

| Directory | Language | Prefix | What Lives Here |
|-----------|----------|--------|-----------------|
| `src/` | Python | `core` | Product code (repomap generation) |
| `.kilocode/` | Mixed | `core` | Plant config, Dolt schema, Python agent tools |
| `daemon/` | TypeScript | `daemon` | Replication daemon, session→Dolt ingest, Kilo CLI integration |

**Daemon development:**
```bash
cd daemon && npm install    # Install daemon dependencies
cd daemon && npm test        # Run daemon tests
cd daemon && npm run build   # Build daemon
```

**Beads routing:** `daemon-*` beads route to `./daemon` via `.beads/routes.jsonl`.

**End state invariant:**
> A task cannot complete unless its punch card is valid.
> A parent cannot complete unless all child punch cards are valid.
> All verification queries durable Dolt-backed state.
