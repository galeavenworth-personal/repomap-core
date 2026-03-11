# Shell → TypeScript Migration Plan

**Bead:** `repomap-core-76q`  
**Status:** Planning  
**Date:** 2026-03-10  

## Problem

The factory's shell scripts have grown to **2,417 lines across 15 files**. They use inline Python heredocs for JSON parsing (7 blocks in `factory_dispatch.sh` alone), fragile process management (`pgrep`/`kill`/`sleep`), and shell-based SQL queries that hang on interactive password prompts. The `dolt_start.sh` migration proved the pattern works — `mysql2` protocol queries replaced brittle `dolt --password ""` hacks, `spawn()` replaced `nohup &`, and vitest replaced manual E2E testing.

## Architecture

```
Shell (thin bootstrap)          TypeScript (all logic)
─────────────────────           ──────────────────────
dolt_start.sh      ──exec──→   daemon/src/infra/dolt-lifecycle.cli.ts     ✓ DONE
start-stack.sh     ──exec──→   daemon/src/infra/stack-manager.cli.ts
factory_dispatch.sh ──exec──→  daemon/src/infra/factory-dispatch.cli.ts
```

Each shell script becomes a ~30-line bootstrap wrapper: find `tsx`, ensure `node_modules`, `exec` the TS CLI. All complex logic lives in typed, tested TypeScript modules.

## Inventory

### Tier 1: Core Factory Operations (migrate first — highest daily usage, most fragile)

| Script | Lines | Pain Points | TS Module |
|--------|-------|-------------|-----------|
| `factory_dispatch.sh` | 592 | 7 inline Python blocks, curl polling, session monitoring, child tracking | `factory-dispatch.ts` |
| `start-stack.sh` | 405 | 5 component health checks, pm2 management, temporal start, kilo start | `stack-manager.ts` |
| `check_punch_card.sh` | 236 | SQL via dolt CLI, csv parsing, requirement matching | `punch-card-check.cli.ts` (wraps existing `PunchCardValidator`) |
| `dolt_punch_init.sh` | 278 | 200+ lines of inline SQL, schema seeds | `dolt-schema.ts` |
| `audit_punch_cards.sh` | 137 | Calls check_punch_card.sh in loop | `punch-card-audit.ts` |
| `dolt_apply_punch_card_schema.sh` | 37 | dolt CLI for DDL + commit | Absorbed into `dolt-schema.ts` |

**Tier 1 total: 1,685 lines → ~6 TS modules**

### Tier 2: Beads/Git Integration (migrate second)

| Script | Lines | Pain Points | TS Module |
|--------|-------|-------------|-----------|
| `beads_land_plane.sh` | 196 | Calls bounded_gate.py, audit proof verification, bd close | `land-plane.ts` |
| `gh_pr_threads.sh` | 127 | 5 gh API calls + Python JSON assembly | `pr-threads.ts` |
| `bd_reconcile_merged_prs.sh` | 116 | gh + bd CLI interaction | `pr-reconcile.ts` |

**Tier 2 total: 439 lines → ~3 TS modules**

### Tier 3: Bootstrap (stays as shell forever)

| Script | Lines | Why it stays |
|--------|-------|-------------|
| `dolt_start.sh` | 78 | ✓ Already a thin wrapper |
| `dolt_init.sh` | 84 | One-time setup, runs before node_modules exist |
| `require_factory_root.sh` | 55 | Safety guard, must work without Node.js |
| `beads_git_setup.sh` | 27 | Git config, 5 commands |
| `beads_preflight.sh` | 25 | Binary existence check |
| `bd_doctor_safe.sh` | 24 | Optional, 4 lines of real logic |

**Tier 3 total: 293 lines — no migration needed**

## Priority Order

### Phase 1: `factory_dispatch.sh` → `factory-dispatch.ts`
**Why first:** 592 lines, daily usage, 7 inline Python heredocs, most fragile.

What it does:
1. Pre-flight: check all 5 stack components (curl + ss + pm2 jlist)
2. Build prompt payload (read JSON file or wrap string — Python)
3. Inject SESSION_ID into prompt text (Python)
4. Create kilo session (curl POST → Python JSON parse)
5. Dispatch prompt async (curl POST)
6. Monitor: poll session messages for terminal step-finish + idle confirmation (curl + Python)
7. Monitor children: check child session completion (curl + Python)
8. Extract result: find last assistant text (Python)
9. Output: JSON or text (Python)

What TypeScript gives us:
- `fetch()` replaces curl — proper error handling, typed responses
- Native JSON — replaces all 7 Python heredocs
- `async/await` polling — replaces sleep + while loop
- Typed session/message models — catch shape changes at compile time
- Testable with vitest — mock fetch responses

### Phase 2: `start-stack.sh` → `stack-manager.ts`
**Why second:** 405 lines, daily usage, Dolt part already migrated.

What it does:
1. Health checks for 5 components (kilo, Dolt, oc-daemon, Temporal, worker)
2. Start kilo serve (nohup + poll)
3. Start Dolt (already delegated to dolt-lifecycle.ts ✓)
4. Apply punch card schema migration
5. Start Temporal dev server (nohup + poll)
6. Start pm2 ecosystem (oc-daemon + temporal-worker)
7. Stop all managed components

What TypeScript gives us:
- `pm2` programmatic API (already a dependency) — replaces `pm2 jlist | grep`
- `mysql2` for Dolt health — replaces ss + dolt CLI
- `net.createConnection()` for port checks — replaces `ss -tlnp | grep`
- Structured health report (JSON) — replaces emoji log lines

### Phase 3: `check_punch_card.sh` + `audit_punch_cards.sh` → CLI wrappers
**Why third:** `PunchCardValidator` already exists in `daemon/src/governor/`. The shell scripts are just CLI wrappers around SQL queries that the daemon already knows how to do.

### Phase 4: `dolt_punch_init.sh` + `dolt_apply_punch_card_schema.sh` → `dolt-schema.ts`
**Why fourth:** Schema management via mysql2 protocol. Read `.sql` files, apply via connection, handle idempotent Dolt commit.

### Phase 5: Tier 2 scripts
`beads_land_plane.sh`, `gh_pr_threads.sh`, `bd_reconcile_merged_prs.sh` — these have lower daily usage but still benefit from typed JSON handling and proper error management.

## Libraries

| Library | Status | Replaces |
|---------|--------|----------|
| `mysql2/promise` | ✓ In daemon | dolt CLI, mysql CLI |
| `pm2` | ✓ In daemon (devDep) | `pm2 jlist \| grep` |
| `tsx` | ✓ In daemon (devDep) | N/A (runner) |
| `node:child_process` | Built-in | pgrep, kill, nohup |
| `node:net` | Built-in | ss -tlnp |
| `zod` | To add | Inline Python JSON parsing |

No new heavy dependencies needed. The daemon already has everything except `zod` for runtime payload validation.

## What This Unlocks

1. **Type safety across the factory** — session payloads, punch card queries, stack config are all typed
2. **Testable infrastructure** — vitest mocks for every component check, dispatch step, SQL query  
3. **Single language** — no more shell→Python→shell→curl→Python chains
4. **Structured errors** — typed error codes instead of `echo "ERROR:" >&2; exit N`
5. **Composability** — `factory-dispatch.ts` can import `stack-manager.ts` for pre-flight, import `dolt-lifecycle.ts` for DB checks
6. **Future: A2A integration** — these modules become the implementation behind A2A Agent Card endpoints
7. **DSPy integration** — compiled prompt injection at dispatch time via direct Dolt query, not shell→dolt CLI→parse CSV

## Migration Pattern (established by dolt_start.sh)

For each script:
1. Create `daemon/src/infra/<name>.ts` — all logic, exported functions
2. Create `daemon/src/infra/<name>.cli.ts` — CLI entry point using the module
3. Create `daemon/tests/<name>.test.ts` — unit tests + conditional live tests
4. Update `.kilocode/tools/<script>.sh` — thin wrapper: find tsx, ensure deps, exec
5. Verify: run the shell wrapper, confirm identical behavior
6. Commit with detailed message
