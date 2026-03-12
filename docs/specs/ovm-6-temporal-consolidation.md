# OVM-6: Temporal SDK Consolidation Strategy

**Status**: Spec (research/analysis only)
**Issue**: `repomap-core-ovm.6`
**Finding**: BB-1 from `.windsurf/dispatches/003-architecture-review-daemon-src.md`
**Author**: ovm.6 research task
**Date**: 2026-03-12

---

## 1. Executive Summary

`factory-dispatch.ts` (868 LOC) hand-rolls session lifecycle management that the
Temporal SDK already handles natively through `agentTaskWorkflow` in `workflows.ts`
and `pollUntilDone` in `activities.ts`. The Temporal path is strictly more
capable (tree-walking idle detection, heartbeat liveness, durable state,
cancellation cleanup). This spec recommends a **partial migration**: deprecate
the duplicated monitoring logic in factory-dispatch and make `runDispatch` a thin
Temporal client, while extracting shared prompt-building and result-extraction
logic to a kilo-client module.

---

## 2. Current Session Lifecycle in factory-dispatch.ts

### 2.1 Phase Inventory

| Phase | Function(s) | Lines | Description |
|-------|------------|-------|-------------|
| Preflight | `preflight()` | 218-295 | TCP port checks + HTTP GET + PM2 process checks for 5 components |
| Prompt build | `buildPromptPayload()` | 302-325 | JSON file or plain text to `PromptPayload` |
| Session ID injection | `injectSessionId()` | 333-361 | Template replacement (`$SESSION_ID`, `{{SESSION_ID}}`) |
| Session creation | `createSession()` | 368-389 | `POST /session` via HTTP |
| Card exit prompt | (inline in `runDispatch`) | 682-702 | `resolveCardExitPrompt` + `injectCardExitPrompt` |
| Prompt dispatch | `dispatchPrompt()` | 395-411 | `POST /session/{id}/prompt_async` |
| Session monitoring | `monitorSession()` | 511-582 | Polling loop with idle detection + child monitoring |
| Idle detection | `isSessionDone()` | 420-444 | Terminal step-finish parsing from message stream |
| Child monitoring | `fetchChildren()`, `areAllChildrenDone()` | 449-500 | Flat child enumeration + running/pending tool scan |
| Result extraction | `extractResult()` | 590-614 | Scan backward for assistant text >100 chars |
| Post-session audit | `runPostSessionAudit()` | 816-858 | Punch card validation via `PunchCardValidator` |
| Orchestrator | `runDispatch()` | 624-804 | Sequences all phases, returns exit codes |

### 2.2 Session Monitoring Detail

The `monitorSession` function implements a polling loop with these characteristics:

- **Poll interval**: Configurable (`config.pollInterval`, default 10s)
- **Timeout**: Configurable (`config.maxWait`, default 600s)
- **Idle detection**: `isSessionDone()` checks for terminal `step-finish` (end_turn/stop) without running/pending tools
- **Idle confirmation**: Requires `config.idleConfirm` (default 3) consecutive idle polls
- **Child monitoring**: Flat enumeration via `fetchChildren()`, then sequential check of each child's messages for running/pending tools
- **No tree walking**: Only checks direct children, not grandchildren
- **No heartbeat**: No liveness detection beyond poll success/failure
- **No cost tracking**: No cost/token aggregation during monitoring

### 2.3 Known Limitations

1. **Shallow child monitoring**: Only checks direct children, not delegation trees
2. **No cancellation cleanup**: If the process dies, the kilo session keeps running
3. **No durable state**: Poll progress is lost on crash
4. **No cost visibility**: Cost/token stats unavailable until session completes
5. **No active-leaf tracking**: Cannot distinguish which agent in a tree is working
6. **Low idle threshold**: Default 3 confirmations (30s) vs Temporal's 6 (60s)

---

## 3. Temporal SDK Coverage Map

### 3.1 agentTaskWorkflow (workflows.ts:180-341)

The Temporal workflow already implements the full lifecycle:

| Phase | Implementation | Lines |
|-------|---------------|-------|
| Health check | `quickActivities.healthCheck()` | 249-250 |
| Session creation | `quickActivities.createSession()` | 255-257 |
| Prompt dispatch | `sendPrompt()` (with card exit prompt injection) | 262-263 |
| Monitoring | `pollUntilDone()` activity with heartbeats | 271-277 |
| Budget check | `quickActivities.checkCostBudget()` | 286-299 |
| Punch card validation | `quickActivities.validateTaskPunchCard()` | 302-315 |
| Session audit | `quickActivities.runSessionAudit()` | 318-319 |
| Abort signal | `abortSignal` + `abortSession()` in cancellation scope | 218-219, 322-336 |
| Status query | `statusQuery` — real-time phase/cost/token exposure | 242-245 |

### 3.2 pollUntilDone (activities.ts:353-446)

The Temporal monitoring activity is strictly more capable:

| Capability | factory-dispatch | Temporal (pollUntilDone) |
|-----------|-----------------|--------------------------|
| Tree walking | Flat children only | Recursive via `findActiveLeaf()` |
| Idle confirmations | 3 (configurable) | 6 (hardcoded) |
| Heartbeat/liveness | None | Temporal heartbeat with structured progress |
| Cost tracking | None during monitoring | Real-time via `getTreeStats()` |
| Active-leaf detection | None | `findActiveLeaf()` + `classifyLeafPhase()` |
| Thinking detection | None | `openSteps` counter (step-start/step-finish balance) |
| Cancellation cleanup | None | `abortSession()` in `CancellationScope.nonCancellable` |
| Crash recovery | Lost | Temporal replay from last checkpoint |
| Timeout behavior | Return `{ completed: false }` | Abort session + throw (workflow catches) |

### 3.3 Foreman Layer (foreman.workflows.ts)

The foreman adds another layer of Temporal-native patterns:

- **Child workflow orchestration**: `startChild(agentTaskWorkflow, ...)` (line 599)
- **Continue-as-new**: Prevents unbounded history growth (line 697)
- **Operator signals**: pause/resume/shutdown/force-dispatch (lines 77-83)
- **Retry ledger**: Durable retry tracking with backoff (lines 172-205)
- **Health gate**: Stack health check before dispatch (lines 537-562)

---

## 4. Code Areas Affected

### 4.1 Functions That Can Be Replaced by Temporal Equivalents

These functions in `factory-dispatch.ts` duplicate logic that already exists in
the Temporal activity layer and should be **deprecated**:

| Function | LOC | Temporal Equivalent | Notes |
|----------|-----|-------------------|-------|
| `monitorSession()` | 72 | `pollUntilDone()` in activities.ts | Temporal version is strictly superior |
| `isSessionDone()` | 25 | `isSessionDone()` in activities.ts:516-524 | Different implementation, same intent |
| `fetchChildren()` | 13 | `getChildSessionIds()` in activities.ts:120-129 | Near-identical |
| `areAllChildrenDone()` | 18 | `isSessionIdle()` in activities.ts:531-551 | Temporal walks tree recursively |
| `fetchMessages()` | 13 | `getProgressSnapshot()` in activities.ts:556-603 | Temporal extracts richer data |

**Total deprecatable LOC**: ~141 lines of monitoring logic

### 4.2 Functions That Should Be Extracted to Shared Modules

These functions contain domain logic that is NOT Temporal-specific and should be
shared between paths:

| Function | LOC | Target Module | Consumers |
|----------|-----|--------------|-----------|
| `buildPromptPayload()` | 24 | `infra/kilo-client.ts` | factory-dispatch, Temporal activities |
| `injectSessionId()` | 29 | `infra/kilo-client.ts` | factory-dispatch, `sendPrompt` activity |
| `extractResult()` | 25 | `infra/kilo-client.ts` | factory-dispatch (CLI output) |
| `createSession()` | 22 | `infra/kilo-client.ts` | factory-dispatch, Temporal activities |
| `dispatchPrompt()` | 17 | `infra/kilo-client.ts` | factory-dispatch, Temporal activities |
| `preflight()` | 77 | `infra/preflight.ts` | factory-dispatch, dispatch.ts |

**Total extractable LOC**: ~194 lines

### 4.3 Functions That Stay in factory-dispatch.ts

The orchestrator and CLI-facing logic stays, but becomes thinner:

| Function | LOC | Reason |
|----------|-----|--------|
| `runDispatch()` | 181 | Entry point; becomes thin Temporal client |
| `defaultConfig()` | 20 | CLI config; may partially map to `AgentTaskInput` |
| `writePromptFile()` | 3 | Shell wrapper utility |
| Exit code constants | 11 | CLI interface contract |
| Type definitions | ~70 | Interface contracts (may merge with Temporal types) |

### 4.4 Net Effect

| Category | Current LOC | After Migration |
|----------|------------|----------------|
| Monitoring logic (deprecated) | 141 | 0 (use Temporal) |
| Shared kilo-client extractions | 194 | 0 (moved to shared module) |
| Orchestrator + CLI | ~265 | ~120 (thin Temporal client) |
| Types + config | ~90 | ~60 (merge with Temporal types) |
| Infrastructure (checkPort, etc.) | ~60 | ~30 (already in utils.ts) |
| Audit | ~43 | 0 (already in Temporal) |
| **Total** | **868** | **~210** |

Estimated reduction: **~660 LOC** eliminated from factory-dispatch.ts.

---

## 5. Migration Strategy

### 5.1 Recommendation: Partial Migration with Deprecation Path

**Do not delete factory-dispatch.ts**. Instead:

1. **Extract shared code** (ovm.7): Move prompt building, session creation,
   and kilo HTTP helpers to `infra/kilo-client.ts`. Both factory-dispatch and
   Temporal activities import from the shared module.

2. **Deprecate monitoring functions**: Mark `monitorSession`, `isSessionDone`,
   `fetchChildren`, `areAllChildrenDone`, `fetchMessages` as `@deprecated`
   with migration guidance pointing to the Temporal path.

3. **Make runDispatch a Temporal client**: The new `runDispatch` starts an
   `agentTaskWorkflow` via the Temporal client SDK, queries status periodically
   for CLI output, and awaits the result. This preserves the exit-code interface
   for existing callers while gaining all Temporal benefits.

4. **Preserve non-Temporal fallback**: Keep the deprecated monitoring functions
   available for environments where Temporal is not running. The `noMonitor`
   flag already handles fire-and-forget; the monitoring fallback covers the
   "Temporal is down but we still want to dispatch" case.

### 5.2 Migration Phases

```
Phase 1 (ovm.7): Extract shared kilo-client module
  - Move createSession, dispatchPrompt, buildPromptPayload, injectSessionId,
    extractResult to infra/kilo-client.ts
  - Both factory-dispatch and Temporal activities import from shared module
  - PP-5 from architecture review

Phase 2 (new subtask): Convert runDispatch to Temporal client
  - runDispatch starts agentTaskWorkflow instead of direct HTTP polling
  - Periodic statusQuery for CLI output (replaces monitorSession)
  - Map AgentTaskResult.status to ExitCode values
  - Preserve JSON output format (DispatchResult interface)

Phase 3 (deferred): Deprecate non-Temporal monitoring path
  - Mark monitorSession, isSessionDone, etc. as @deprecated
  - Add migration warnings to stderr when used directly
  - Remove after one release cycle with no callers
```

### 5.3 Why Not Full Replacement Now?

1. **Temporal dependency**: factory-dispatch.ts can run without Temporal. The
   Temporal server may not always be available (dev environments, CI).
2. **Callers**: factory_dispatch.sh wrappers and automation scripts depend on
   the exit code contract. Changing the interface requires coordinated updates.
3. **Test surface**: factory-dispatch has comprehensive unit tests (mock fetchFn).
   The Temporal workflow has integration tests but they're harder to run.
4. **Risk**: The monitoring paths, while duplicated, are both stable. Removing
   one path while the other is actively relied upon adds risk without urgency.

---

## 6. Feasibility Assessment

### 6.1 Technical Feasibility: HIGH

The Temporal equivalents already exist and are battle-tested through the foreman
workflow. The `agentTaskWorkflow` is the exact same lifecycle as `runDispatch`
but with better monitoring, durability, and observability. No new Temporal
patterns need to be invented.

### 6.2 Effort Estimate

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| Phase 1: Extract kilo-client | S (1-2 sessions) | ovm.7 |
| Phase 2: Convert runDispatch | M (2-3 sessions) | Phase 1 |
| Phase 3: Deprecate old path | S (1 session) | Phase 2 stable |

### 6.3 Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Temporal not available in some environments | Medium | Keep deprecated fallback path |
| Exit code contract break | High | Map AgentTaskResult.status to ExitCode exhaustively |
| Test regression | Medium | Port factory-dispatch unit tests to test the Temporal client path |
| Idle detection behavior change (3 vs 6 confirmations) | Low | Make confirmations configurable in AgentTaskInput |
| dispatch.ts CLI divergence | Low | Merge dispatch.ts and factory-dispatch.ts CLIs in Phase 2 |

---

## 7. Sequencing with Other OVM Subtasks

```
ovm.2 (DONE): Extract shared utilities to infra/utils.ts
ovm.3 (DONE): Migrate PM2 to programmatic API
                    |
                    v
ovm.6 (THIS): Research/spec Temporal consolidation  <-- WE ARE HERE
                    |
                    v
ovm.7 (NEXT): Split factory-dispatch + isolate Kilo client
              - Phase 1 of this spec: extract kilo-client.ts
              - Should account for Temporal migration path
              - Do NOT move monitoring functions to a new module;
                they will be deprecated, not preserved
                    |
                    v
ovm.8: Split plant-health + extract health helpers
       (independent of this spec, can run in parallel)
                    |
                    v
(NEW subtask): Convert runDispatch to Temporal client (Phase 2)
               - Depends on ovm.7 completing the extraction
               - Estimated effort: M
                    |
                    v
(DEFERRED): Deprecate/remove non-Temporal monitoring path (Phase 3)
```

### 7.1 Impact on ovm.7

ovm.7's scope ("Split factory-dispatch and isolate Kilo client") should be
informed by this spec:

- **Extract to kilo-client.ts**: `createSession`, `dispatchPrompt`,
  `buildPromptPayload`, `injectSessionId`, `extractResult`
- **Do NOT extract to a new monitoring module**: `monitorSession`,
  `isSessionDone`, `fetchChildren`, `areAllChildrenDone`, `fetchMessages`
  should stay in factory-dispatch.ts (to be deprecated later), not be promoted
  to a new module
- **Extract to preflight.ts**: `preflight`, `checkPort` (shared with
  dispatch.ts)
- **Audit stays in governor/**: `runPostSessionAudit` already delegates to
  `PunchCardValidator`; keep it there or inline into the remaining orchestrator

---

## 8. Detailed Function Overlap Analysis

### 8.1 Session Creation

```
factory-dispatch.ts:createSession()     Temporal activities.ts:createSession()
  POST /session { title }                 POST /session { title? }
  Returns { id: string }                  Returns { sessionId, title }
  Takes (baseUrl, title, fetchFn)         Takes (config, title?)
```

**Verdict**: Identical HTTP call. Extract to shared kilo-client.

### 8.2 Prompt Dispatch

```
factory-dispatch.ts:dispatchPrompt()    Temporal activities.ts:sendPrompt()
  POST /session/{id}/prompt_async         POST /session/{id}/prompt_async
  Takes raw PromptPayload                 Builds payload internally
  No card exit prompt injection           Injects card exit prompt
  No SESSION_ID injection                 Injects SESSION_ID
```

**Verdict**: Temporal version is more complete. Shared module should provide the
HTTP call; callers handle payload construction.

### 8.3 Idle Detection

```
factory-dispatch.ts:isSessionDone()     Temporal activities.ts:isSessionDone()
  Scans for terminal step-finish          Checks: hasContent + noActiveTools +
  Checks for running/pending tools          isTerminal (step-finish | patch | text-after-tools)
  Resets on tool-calls step-finish        Uses accumulator pattern with openSteps
```

**Verdict**: Different implementations, overlapping intent. The Temporal version
uses an accumulator pattern that also tracks cost/tokens. The factory-dispatch
version is simpler but less accurate (doesn't handle `patch` terminal state).

### 8.4 Child Monitoring

```
factory-dispatch.ts:                    Temporal activities.ts:
  fetchChildren() — flat list             getChildSessionIds() — flat list
  areAllChildrenDone() — sequential       findActiveLeaf() — recursive tree walk
    check each child's messages             follows delegation chain to leaf
                                          getTreeStats() — recursive aggregation
```

**Verdict**: Temporal version is strictly superior. factory-dispatch checks if
all children are idle; Temporal walks the tree to find the active leaf and
aggregates stats across the entire tree.

---

## 9. Type Surface Overlap

Several types are defined in both modules:

| factory-dispatch.ts | workflows.ts / activities.ts | Overlap |
|--------------------|------------------------------|---------|
| `PromptPayload` | (inline in `sendPrompt`) | Partial |
| `SessionMessage` | (raw `Record<string, unknown>`) | Similar intent |
| `ChildSession` | (extracted as `string[]`) | Same data |
| `PreflightResult` | `HealthCheckResult` | Different structure, same intent |
| `AuditResult` | `AuditSummary` | Different shape, same domain |
| `DispatchResult` | `AgentTaskResult` | Overlapping fields |
| `MonitorResult` | `AgentResult` | Overlapping fields |

**Recommendation**: During Phase 1 (ovm.7), define canonical types in the
kilo-client module. Both paths import and adapt as needed. During Phase 2,
`DispatchResult` wraps `AgentTaskResult` for backward compatibility.

---

## 10. Conclusion

The Temporal SDK path (`agentTaskWorkflow` + `pollUntilDone`) is the de facto
production path, battle-tested through the foreman workflow. The factory-dispatch
session lifecycle is a historical artifact from before Temporal was integrated.

**Recommendation**: **Partial migration** over 3 phases:
1. Extract shared code (ovm.7) — immediate
2. Convert runDispatch to Temporal client — new subtask
3. Deprecate old monitoring path — deferred

This eliminates ~660 LOC of duplicated logic while preserving backward
compatibility and maintaining a fallback path for environments without Temporal.

The key insight is that this is not a build-vs-buy decision anymore. **The buying
already happened** — the Temporal integration exists and works. This is a
consolidation task: removing the hand-rolled path that predates it.
