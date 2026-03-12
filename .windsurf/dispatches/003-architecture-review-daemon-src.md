# Architecture Review Ledger — `daemon/src/` — 2026-03-11

Produced by: `/architecture-review` workflow (proof-of-concept run)

## Summary

| Lens | Findings | Critical | High | Medium |
|------|----------|----------|------|--------|
| Parallel Paths | 10 | 2 | 5 | 3 |
| Build-or-Buy | 2 | 0 | 1 | 1 |
| Interface Discipline | 0 | — | — | — |
| SOLID | 3 | 1 | 2 | 0 |
| SDK-over-CLI | 6 | 0 | 2 | 4 |
| **Total** | **21** | **3** | **10** | **8** |

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

## Lens 5 — SDK-over-CLI

Inventory: 35 subprocess calls across `daemon/src/` targeting 9 unique binaries.

### SC-1: PM2 — 6 CLI calls → `pm2` programmatic API (High)

| File | Line | CLI Call | SDK Replacement |
|------|------|---------|-----------------|
| `stack-manager.ts` | 479 | `execFileSync(pm2Bin, ["start", eco])` | `pm2.start({script, name})` |
| `stack-manager.ts` | 621 | `execFileSync(pm2Bin, ["jlist"])` | `pm2.list()` |
| `stack-manager.ts` | 628 | `execFileSync(pm2Bin, ["stop", "all"])` | `pm2.stop("all")` |
| `stack-manager.ts` | 629 | `execFileSync(pm2Bin, ["delete", "all"])` | `pm2.delete("all")` |
| `factory-dispatch.ts` | 226 | `execFileSync(pm2Bin, ["jlist"])` | `pm2.list()` |

PM2 provides a full programmatic API: `pm2.connect()`, `pm2.start()`,
`pm2.stop()`, `pm2.delete()`, `pm2.list()`, `pm2.disconnect()`. All callback-
based but easily promisified. Eliminates PATH trust, stdout JSON parsing, and
the `resolveBin` logic for pm2.

**Gotcha**: PM2 API is async (callback-based). Current call sites are synchronous
(`execFileSync`). Migration requires converting `isPm2AppOnline` and related
functions to async. `checkOcDaemon`/`checkTemporalWorker` already feed into
`Promise.all` in `checkStack`, so async is natural.

**Recommendation**: Migrate. Removes 6 subprocess calls and the `pm2Bin` config
field entirely.

### SC-2: GitHub CLI (`gh`) — 2 call sites → `@octokit/rest` (High)

| File | Line | CLI Call | SDK Replacement |
|------|------|---------|-----------------|
| `pr-threads.ts` | 117 | `execFileSync("gh", args)` | `octokit.rest.pulls.*` / `octokit.rest.issues.*` |
| `pr-reconcile.ts` | 64 | `execFileSync("gh", args)` | `octokit.rest.pulls.*` |

`@octokit/rest` is GitHub's official Node.js SDK. Fully typed, well-maintained,
covers every `gh` CLI operation we use (PR comments, reviews, issue management).
Eliminates `gh` binary dependency and auth token passing via environment.

**Recommendation**: Migrate. The `gh` CLI requires a separate auth flow;
Octokit uses `GITHUB_TOKEN` directly with structured, typed responses.

### SC-3: Git — 4 calls → `simple-git` or `isomorphic-git` (Medium)

| File | Line | CLI Call |
|------|------|---------|
| `factory-dispatch.ts` | 86 | `git rev-parse --show-toplevel` |
| `stack-manager.ts` | 67 | `git rev-parse --show-toplevel` |
| `pr-reconcile.ts` | 243 | `git rev-parse --show-toplevel` |
| `pr-threads.ts` | 138 | `git branch --show-current` |

`simple-git` and `isomorphic-git` exist. However, for trivial operations
(rev-parse, branch name), the CLI is the established happy path. Adding a git
SDK dependency for 4 one-liner calls is overkill.

**Recommendation**: Keep CLI. These are all trivial read-only operations. Once
the parallel path duplicates are extracted to `utils.ts` (PP-1), there will be
only 2 call sites anyway. Mitigate by using absolute path `/usr/bin/git` if
PATH trust is a concern.

### SC-4: npm — 1 call (Medium)

| File | Line | CLI Call |
|------|------|---------|
| `stack-manager.ts` | 410 | `npm install --silent` |

`@npmcli/arborist` exists for programmatic installs, but `npm install` via CLI
is npm's own documented happy path. No practical SDK advantage.

**Recommendation**: Keep CLI. Mitigate with absolute path if needed.

### SC-5: Dolt — 1 spawn (Medium)

| File | Line | CLI Call |
|------|------|---------|
| `dolt-lifecycle.ts` | 303 | `spawn(doltBin, ["sql-server", ...])` |

Dolt server management has no SDK. The MySQL wire protocol is already used for
queries (via `mysql2`). Server lifecycle is inherently a process management task.

**Recommendation**: Keep CLI. This is the only path.

### SC-6: OS utilities + own tools — 12 calls (Low)

| Binary | Call Sites | Notes |
|--------|-----------|-------|
| `pkill` | 1 | Could track PID and use `process.kill()` instead |
| `pgrep` | 3 | Process existence checks |
| `which` | 1 | Could use `which` npm package |
| `bash` | 2 | Shell script execution, no alternative |
| `python` | 1 | Runtime invocation, no alternative |
| `bd` | 3 | Our own tool, CLI is only path |
| `temporal` | 2 (spawn) | Dev server management, no SDK |

**Recommendation**: Keep CLI for all. For `pkill`, consider tracking spawned
child PIDs and using `process.kill(pid)` — this is more reliable anyway.

---

## Recommended Actions (Priority Order)

1. **Create `daemon/src/infra/utils.ts`** — extract `sleep`, `timestamp`,
   `findRepoRoot`, `sortKeysDeep`, `timed` (PP-1, PP-2, PP-3, PP-7, PP-9)
2. **Migrate PM2 to programmatic API** — eliminate 6 subprocess calls, remove
   `pm2Bin` config field, convert to async (SC-1)
3. **Migrate `gh` CLI to `@octokit/rest`** — eliminate `gh` binary dependency,
   get typed responses (SC-2)
4. **Unify `closeBead`** — single canonical implementation (PP-4)
5. **Extract kilo client** — `createSession` and prompt dispatch to shared module (PP-5, S-1)
6. **Unify `loadModeCardMap`** — single Dolt-based loader (PP-6)
7. **Evaluate Temporal SDK coverage** for factory-dispatch session lifecycle (BB-1)
8. **Split factory-dispatch.ts** along concern boundaries (S-1)
9. **Extract shared CLI formatting** — `formatDuration` at minimum (PP-10)
