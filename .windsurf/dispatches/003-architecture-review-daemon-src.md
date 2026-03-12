# Architecture Review Ledger — `daemon/src/` — 2026-03-11

Produced by: `/architecture-review` workflow (proof-of-concept run)

## Summary

| Lens | Findings | Critical | High | Medium |
|------|----------|----------|------|--------|
| Parallel Paths | 10 | 2 | 5 | 3 |
| Build-or-Buy | 2 | 0 | 1 | 1 |
| Interface Discipline | 0 | — | — | — |
| SOLID | 3 | 1 | 2 | 0 |
| **Total** | **15** | **3** | **8** | **4** |

---

## Lens 1 — Parallel Paths

### PP-1: `findRepoRoot()` — 2 copies (Critical)

| File | Line |
|------|------|
| `daemon/src/infra/factory-dispatch.ts` | 84 |
| `daemon/src/infra/stack-manager.ts` | 65 |

Both are identical: `execFileSync("git", ["rev-parse", "--show-toplevel"])` with
a `process.cwd()` fallback. Should be extracted once.

**Action**: Extract to `daemon/src/infra/utils.ts`, import in both.

### PP-2: `sleep()` — 3 copies (Critical)

| File | Line |
|------|------|
| `daemon/src/infra/factory-dispatch.ts` | 183 |
| `daemon/src/infra/stack-manager.ts` | 134 |
| `daemon/src/infra/dolt-lifecycle.ts` | 422 |

All identical: `new Promise(resolve => setTimeout(resolve, ms))`.

**Action**: Extract to `daemon/src/infra/utils.ts`.

### PP-3: `timestamp()` — 2 copies (High)

| File | Line |
|------|------|
| `daemon/src/infra/factory-dispatch.ts` | 178 |
| `daemon/src/infra/stack-manager.ts` | 138 |

**Action**: Extract to `daemon/src/infra/utils.ts`.

### PP-4: `closeBead()` — 3 copies (High)

| File | Line | Signature |
|------|------|-----------|
| `daemon/src/infra/land-plane.ts` | 278 | `(beadId, config, log) → boolean` via `spawnSync(bdBin, ["close", beadId])` |
| `daemon/src/infra/pr-reconcile.ts` | 119 | `(taskId, runBd) → void` via `runBd(["close", taskId])` |
| `daemon/src/temporal/foreman.activities.ts` | 703 | `(input) → Promise<CloseBeadOutput>` via `execBd(["close", beadId])` |

Three implementations of "call `bd close <id>`" with different wrappers.

**Action**: Define one canonical `closeBead(beadId, bdBin, opts?)` in a shared
module. The Temporal activity wraps it; land-plane and pr-reconcile import it.

### PP-5: `createSession()` — 2 copies (High)

| File | Line | Signature |
|------|------|-----------|
| `daemon/src/infra/factory-dispatch.ts` | 395 | `(baseUrl, title, fetchFn) → Promise<SessionInfo>` |
| `daemon/src/temporal/activities.ts` | 97 | `(config, title?) → Promise<SessionInfo>` |

Both call the kilo API to create a session. Different wrappers, same HTTP call.

**Action**: Extract the HTTP call to a shared kilo client module.

### PP-6: `loadModeCardMap()` — 3 copies (High)

| File | Line | Signature |
|------|------|-----------|
| `daemon/src/lifecycle/daemon.ts` | 190 | `async` — reads from Dolt |
| `daemon/src/temporal/dispatch.ts` | 83 | `sync` — reads JSON from file |
| `daemon/src/optimization/prompt-injection.ts` | 13 | `async` — reads from Dolt |

Three implementations of "get the mode→card mapping." Two read Dolt, one reads
a file. The Dolt-based ones should share an implementation.

**Action**: Extract Dolt-based loader to a shared module. File-based loader may
stay separate if needed for sync contexts.

### PP-7: `timed<T>()` — 2 copies (High)

| File | Line |
|------|------|
| `daemon/src/temporal/foreman.activities.ts` | 328 |
| `daemon/src/temporal/plant-health.ts` | 286 |

Identical async timing utility.

**Action**: Extract to shared utils.

### PP-8: `buildSubsystemHealth()` — 2 copies (Medium)

| File | Line |
|------|------|
| `daemon/src/temporal/foreman.activities.ts` | 338 |
| `daemon/src/temporal/plant-health.ts` | 293 |

**Action**: Extract to shared module or have foreman import from plant-health.

### PP-9: `sortKeysDeep()` — 2 copies (Medium)

| File | Line |
|------|------|
| `daemon/src/classifier/index.ts` | 42 |
| `daemon/src/lifecycle/daemon.ts` | 99 |

**Action**: Extract to shared utils.

### PP-10: `formatDuration()` / `formatStatus()` — 2 copies each (Medium)

| File | Line | Function |
|------|------|----------|
| `daemon/src/temporal/monitor.cli.ts` | 62, 72 | `formatDuration`, `formatStatus` |
| `daemon/src/temporal/foreman.cli.ts` | 215, 256 | `formatDuration`, `formatStatus` |

CLI formatting utilities duplicated across CLIs. (Note: `formatStatus` takes
different types in each — may not be directly dedupable.)

**Action**: Extract `formatDuration` to shared CLI utils. Evaluate `formatStatus`
— if the types can be unified via a common interface, do so.

---

## Lens 2 — Build-or-Buy

### BB-1: `factory-dispatch.ts` session lifecycle management (High)

| Metric | Value |
|--------|-------|
| Churn | 6 commits |
| LOC | 895 |
| Exports | 30 |
| SonarQube | 4 cognitive complexity warnings |
| Problem domain | Dispatch prompt → create session → poll for completion → extract result |

This module hand-rolls session lifecycle management, idle detection, child session
monitoring, and result extraction. The Temporal SDK already provides:
- Child workflow monitoring with `executeChild` / `startChild`
- Timeout and cancellation semantics
- Durable state via workflow history

**Research candidates**:
- Temporal SDK `proxyActivities` + child workflow patterns (already partially used
  in `dispatch.ts` / `workflows.ts`)
- The dispatch module may be partially redundant with the Temporal activity layer

**Recommendation**: Evaluate how much of factory-dispatch.ts can be replaced by
native Temporal workflow patterns. The session polling loop, idle detection, and
child monitoring are all patterns Temporal handles natively.

### BB-2: `plant-health.ts` composite health reporting (Medium)

| Metric | Value |
|--------|-------|
| LOC | 1033 |
| Exports | 19 |
| Problem domain | Multi-section health report with independent failure isolation |

Hand-rolls a 6-section health report with independent success/failure per section.
This is a monitoring/observability pattern.

**Research candidates**:
- `@nestjs/terminus` health check framework
- Custom Temporal query handlers (already have query support)
- Prometheus / OpenTelemetry health check conventions

**Recommendation**: Defer. The module is stable and domain-specific enough that a
library may not fit cleanly. Revisit if churn increases.

---

## Lens 3 — Interface Discipline

`tsc --noEmit` passes clean. No env var / config key / database column violations
detected in this run. This lens is healthy.

(Note: Interface discipline is primarily a **planning-phase** check — verifying
identifiers are cited before use. The ad-hoc check confirms no runtime violations.)

---

## Lens 4 — SOLID Principles

### S-1: `factory-dispatch.ts` — Single Responsibility Violation (Critical)

| Metric | Value |
|--------|-------|
| LOC | 895 |
| Exports | 30 |
| Concerns | Config, port checking, pm2 status, session creation, prompt dispatch, idle monitoring, child session monitoring, result extraction, punch card audit, JSON output |

This file is a monolith. It mixes:
1. **Infrastructure utilities** (checkPort, isPm2AppOnline, findRepoRoot, sleep)
2. **Session lifecycle** (createSession, dispatchPrompt, waitForIdle)
3. **Child session management** (monitorChildSessions)
4. **Orchestration** (runDispatch — the main entry point)
5. **Audit** (runPostSessionAudit)

**Recommendation**: Split into at minimum:
- `infra/utils.ts` — shared utilities (sleep, timestamp, findRepoRoot, checkPort)
- `infra/kilo-client.ts` — session creation, prompt dispatch, SSE monitoring
- `infra/pm2.ts` — isPm2AppOnline and pm2 management
- `infra/factory-dispatch.ts` — orchestration only (runDispatch)
- `infra/punch-card-audit.ts` — runPostSessionAudit (or keep in governor/)

### S-2: `stack-manager.ts` — Single Responsibility Violation (High)

| Metric | Value |
|--------|-------|
| LOC | 657 |
| Exports | 23 |
| Concerns | Config, health checks, start sequence, stop sequence, schema migration, npm install, pm2 ecosystem management |

**Recommendation**: Consider splitting health checks from lifecycle management.
The health check functions (`checkKiloHealth`, `checkDoltComponent`, etc.) are
pure queries; the start/stop functions are side-effectful operations.

### S-3: `plant-health.ts` — Borderline SRP (High)

| Metric | Value |
|--------|-------|
| LOC | 1033 |
| Exports | 19 |
| Concerns | 6 independent health report sections + report composition + CLI |

Each section (punch card status, governor status, quality gates, cost summary,
subtask tree, daemon health) could be its own module. The composition layer is
clean but the file is very long.

**Recommendation**: Extract each section query into its own function/module if
any section needs independent reuse or testing.

---

## Recommended Actions (Priority Order)

1. **Create `daemon/src/infra/utils.ts`** — extract `sleep`, `timestamp`,
   `findRepoRoot`, `sortKeysDeep`, `timed` (PP-1, PP-2, PP-3, PP-7, PP-9)
2. **Unify `closeBead`** — single canonical implementation (PP-4)
3. **Extract kilo client** — `createSession` and prompt dispatch to shared module (PP-5, S-1)
4. **Unify `loadModeCardMap`** — single Dolt-based loader (PP-6)
5. **Evaluate Temporal SDK coverage** for factory-dispatch session lifecycle (BB-1)
6. **Split factory-dispatch.ts** along concern boundaries (S-1)
7. **Extract shared CLI formatting** — `formatDuration` at minimum (PP-10)
