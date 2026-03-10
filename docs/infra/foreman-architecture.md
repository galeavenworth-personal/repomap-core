# Foreman Architecture -- Self-Driving Control Loop

> **Created:** 2026-03-09
> **Author:** Kilo (factory operator) + galeavenworth
> **Type:** Architecture Decision Record (ADR)
> **Bead:** `repomap-core-0mp.1` (decision, P1, in_progress)
> **Blocks:** `repomap-core-0mp.10` (TypeScript type definitions)
> **Blocked by:** `repomap-core-7l4` (trustworthy factory substrate)
> **Related:** `repomap-core-0mp.2` (cognitive services architecture -- external face)

---

## 1. What This Document Is

This document defines the internal control model for the self-driving foreman --
a long-lived Temporal workflow that continuously polls for eligible work,
dispatches it, monitors execution, handles failures, and escalates only when
a human is genuinely required.

This is the **internal face** of the Foreman epic (0mp). Its sibling,
[cognitive-services-architecture.md](cognitive-services-architecture.md), defines
the external interface. Together they are two faces of the same architecture.

**This document is specific enough to implement against.** Bead 0mp.10 will
derive TypeScript type definitions directly from the types, enums, and state
shapes defined here. Beads 0mp.11-0mp.19 will implement the components.

### Dependency Chain

```
0mp.1 (THIS DOCUMENT -- architecture + contracts)
  +-- 0mp.10 (foreman.types.ts -- TypeScript type definitions)
        +-- 0mp.11 (foreman workflow shell + continue-as-new)
        +-- 0mp.12 (stack health activity)
        +-- 0mp.13 (bead selector activity)
        +-- 0mp.14 (dispatch activity)
        +-- 0mp.15 (monitor activity)
        +-- 0mp.16 (outcome handler activity)
        +-- 0mp.17 (operator signal handlers)
        +-- 0mp.18 (foreman integration tests)
        +-- 0mp.19 (foreman CLI + dashboard query)
```

---

## 2. Design Principles

1. **Temporal-native.** The foreman uses continue-as-new, signals, queries,
   child workflows, and activity retries. No custom durability layer.

2. **Thin orchestration.** The foreman is a control loop, not an intelligence
   layer. All cognitive work happens in dispatched child workflows
   (`agentTaskWorkflow`). The foreman decides *what* to work on, not *how*.

3. **Observable by default.** Every state transition is queryable. Operators
   can inspect the foreman's current phase, work queue, dispatch history,
   and health status at any time via Temporal queries.

4. **Human-in-the-loop is the exception.** The foreman handles retries,
   line faults, and transient failures autonomously. Humans are required
   only for the specific exception classes defined in S7.

5. **Beads is the work source.** The foreman does not maintain its own
   work queue. It polls `bd ready` and applies scheduling heuristics.
   Beads is the single source of truth for what needs doing.

6. **Bounded history.** The foreman uses continue-as-new to prevent
   Temporal event history from growing unboundedly. State is carried
   forward explicitly.

---

## 3. Foreman Lifecycle

### 3.1 The Control Loop

The foreman is a single long-lived Temporal workflow that runs a
poll-dispatch-monitor-complete loop. Each iteration of the loop processes
one bead (or idles if no work is available).

```
+-----------------------------------------------------------+
|                    FOREMAN WORKFLOW                        |
|                                                           |
|  +--> POLL --> HEALTH_CHECK --> SELECT --> DISPATCH --+    |
|  |                                                   |    |
|  |    MONITOR <--------------------------------------+    |
|  |      |                                                 |
|  |      +--> COMPLETED --> CLOSE_BEAD --> (loop) ------>+ |
|  |      +--> FAILED --> RETRY_OR_ESCALATE --> (loop) -->+ |
|  |      +--> TIMEOUT --> ESCALATE --> (loop) ---------->+ |
|  |                                                   |    |
|  +---------------------------------------------------+    |
|                                                           |
|  continue-as-new every N iterations or T elapsed          |
|                                                           |
|  SIGNALS: pause, resume, shutdown, forceDispatch          |
|  QUERIES: status, history, health                         |
+-----------------------------------------------------------+
```

### 3.2 Workflow Phases

Each iteration of the control loop progresses through a sequence of named
phases. The phase name is the primary observable state.

| Phase | Description | Duration | Can Fail? |
|---|---|---|---|
| `polling` | Waiting for the next poll interval | Configurable (default: 60s) | No |
| `health_check` | Verifying stack prerequisites | < 30s | Yes |
| `selecting` | Evaluating `bd ready` output for next bead | < 15s | Yes |
| `dispatching` | Starting child workflow for selected bead | < 30s | Yes |
| `monitoring` | Polling child workflow progress | Minutes to hours | Yes (timeout) |
| `completing` | Processing successful child outcome | < 30s | Yes |
| `failing` | Processing failed child outcome | < 30s | Yes |
| `retrying` | Re-dispatching after bounded failure | < 30s | Yes |
| `escalating` | Creating escalation issue for human | < 30s | Yes |
| `idle` | No work available; waiting for next poll | Configurable | No |
| `paused` | Operator-paused; waiting for resume signal | Indefinite | No |
| `shutting_down` | Graceful shutdown after current work completes | < 60s | No |

### 3.3 Continue-As-New Strategy

The foreman calls `continueAsNew` when any of these thresholds are met:

| Trigger | Threshold | Rationale |
|---|---|---|
| Iteration count | 50 iterations | Prevent unbounded history growth |
| Wall-clock time | 4 hours | Temporal best practice for long-lived workflows |
| Operator signal | `shutdown` signal | Graceful restart requested |

On continue-as-new, the foreman serializes its state into `ForemanContinueAsNewState`
and passes it to the new workflow execution. The new execution resumes
from the carried-forward state without losing dispatch history or health
context.

---

## 4. State Shapes

These are the canonical state shapes. Bead 0mp.10 will generate TypeScript
interfaces directly from these definitions.

### 4.1 ForemanInput

The initial input when starting the foreman workflow.

```
ForemanInput {
  // Identity
  workflowId: string              // Stable ID for the foreman instance
  repoPath: string                // Absolute path to the repository

  // Temporal config
  taskQueue: string               // Task queue for child workflows (default: "agent-tasks")

  // Kilo serve config
  kiloHost: string                // default: "127.0.0.1"
  kiloPort: number                // default: 4096

  // Dolt config
  doltHost: string                // default: "127.0.0.1"
  doltPort: number                // default: 3307
  doltDatabase: string            // default: "beads_repomap-core"

  // Timing
  pollIntervalMs: number          // How often to poll bd ready (default: 60_000)
  healthCheckIntervalMs: number   // Min interval between health checks (default: 300_000)
  maxIterations: number           // Continue-as-new after N iterations (default: 50)
  maxWallClockMs: number          // Continue-as-new after T ms (default: 14_400_000 = 4h)

  // Dispatch config
  maxConcurrentDispatches: number // default: 1 (serial execution)
  defaultTimeoutMs: number        // Per-dispatch timeout (default: 7_200_000 = 2h)
  defaultCostBudgetUsd: number    // Per-dispatch cost budget (default: 5.00)

  // Retry config
  maxRetriesPerBead: number       // default: 2 (so 3 total attempts)
  retryBackoffMs: number          // Backoff between retries (default: 30_000)

  // Carried-forward state (set by continue-as-new, null on fresh start)
  carriedState: ForemanContinueAsNewState | null
}
```

### 4.2 ForemanContinueAsNewState

Serialized state carried across continue-as-new boundaries.

```
ForemanContinueAsNewState {
  // Counters
  totalIterations: number         // Lifetime iteration count
  totalDispatches: number         // Lifetime dispatch count
  totalCompletions: number        // Lifetime successful completions
  totalFailures: number           // Lifetime failures (after retries exhausted)
  totalEscalations: number        // Lifetime escalations to human

  // Health snapshot
  lastHealthCheck: HealthCheckResult | null
  lastHealthCheckAt: string | null    // ISO 8601

  // Recent history (bounded ring buffer)
  recentOutcomes: DispatchOutcome[]   // Last 20 outcomes
  retryLedger: RetryLedgerEntry[]     // Active retry tracking

  // Operator state
  pauseRequested: boolean
  shutdownRequested: boolean

  // Timing
  foremanStartedAt: string            // ISO 8601, original start time
  lastContinueAsNewAt: string | null  // ISO 8601
}
```

### 4.3 HealthCheckResult

Result of the stack health gate. All subsystems must pass before dispatch.

```
HealthCheckResult {
  overall: "pass" | "degraded" | "fail"
  checkedAt: string                   // ISO 8601
  subsystems: {
    kiloServe: SubsystemHealth
    dolt: SubsystemHealth
    git: SubsystemHealth
    temporal: SubsystemHealth
    beads: SubsystemHealth
  }
}

SubsystemHealth {
  status: "up" | "degraded" | "down"
  message: string | null
  latencyMs: number | null
}
```

**Health check activities:**

| Subsystem | Check | Pass Criteria |
|---|---|---|
| `kiloServe` | `GET /session` returns 2xx | HTTP 200 within 5s |
| `dolt` | `SELECT 1` on configured database | Query succeeds within 5s |
| `git` | `git status --porcelain` | Exit code 0, no merge conflicts |
| `temporal` | Implicit (if this activity runs, Temporal is up) | Activity executes |
| `beads` | `bd ready --json` exits cleanly | Exit code 0, valid JSON |

**Health gate rules:**
- `overall: "pass"` -- all subsystems `up`. Dispatch proceeds.
- `overall: "degraded"` -- at least one subsystem `degraded`, none `down`.
  Dispatch proceeds with warning logged.
- `overall: "fail"` -- at least one subsystem `down`. Dispatch blocked.
  Foreman idles and retries health check on next iteration.

### 4.4 BeadCandidate

A bead eligible for dispatch, as returned by the bead selector activity.

```
BeadCandidate {
  beadId: string                  // e.g., "repomap-core-4f0.13"
  title: string
  priority: "P0" | "P1" | "P2" | "P3"
  labels: string[]
  dependsOn: string[]             // Bead IDs this bead depends on
  estimatedComplexity: "trivial" | "small" | "medium" | "large" | "unknown"
}
```

### 4.5 DispatchabilityResult

The foreman's decision about whether a bead can be dispatched.

```
DispatchabilityResult {
  decision: "dispatch" | "skip" | "defer" | "block"
  beadId: string
  reason: string
  // Populated when decision is "dispatch"
  dispatchPlan: DispatchPlan | null
}

DispatchPlan {
  beadId: string
  prompt: string                  // The prompt to send to the agent
  agent: string                   // Agent mode slug (e.g., "code", "plant-manager")
  title: string                   // Workflow title for observability
  timeoutMs: number               // Override from bead metadata or default
  costBudgetUsd: number           // Override from bead metadata or default
  cardId: string | null           // Punch card ID to validate against
  enforcedOnly: boolean           // Whether to enforce only required punch types
}
```

**Skip/defer/block reasons:**

| Decision | When |
|---|---|
| `dispatch` | Bead is ready, dependencies met, health passes, not recently failed |
| `skip` | Bead has been completed by another process since last poll |
| `defer` | Bead's retry backoff has not elapsed, or priority is below threshold |
| `block` | Bead's dependencies are not met, or bead is in `in_progress` state |

### 4.6 DispatchOutcome

The durable record of what happened when a bead was dispatched.

```
DispatchOutcome {
  beadId: string
  workflowId: string              // Temporal child workflow ID
  sessionId: string | null        // Kilo serve session ID
  startedAt: string               // ISO 8601
  completedAt: string             // ISO 8601
  durationMs: number
  totalCost: number
  tokensInput: number
  tokensOutput: number

  result: DispatchResult
  audit: AuditSummary | null      // Post-workflow audit (from agentTaskWorkflow)
  attempt: number                 // 1-indexed attempt number
}

DispatchResult =
  | { kind: "completed" }
  | { kind: "failed"; error: string; retryable: boolean }
  | { kind: "validation_failed"; missing: string[]; violations: string[] }
  | { kind: "budget_exceeded"; actualCost: number; budgetUsd: number }
  | { kind: "timeout"; elapsedMs: number; timeoutMs: number }
  | { kind: "aborted"; reason: string }
```

### 4.7 RetryLedgerEntry

Tracks retry state for a bead across attempts.

```
RetryLedgerEntry {
  beadId: string
  attempts: number                // Total attempts so far
  maxAttempts: number             // Configured maximum (default: 3)
  lastAttemptAt: string           // ISO 8601
  lastError: string
  lastResult: DispatchResult
  nextRetryAfter: string          // ISO 8601 (backoff expiry)
  exhausted: boolean              // true when attempts >= maxAttempts
}
```

### 4.8 Operator Commands (Signals)

```
ForemanSignal =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "shutdown"; reason: string }
  | { type: "forceDispatch"; beadId: string }
  | { type: "skipBead"; beadId: string; reason: string }
  | { type: "updateConfig"; config: Partial<ForemanInput> }

// Temporal signal definitions:
// defineSignal("foreman.pause")
// defineSignal<[{ reason: string }]>("foreman.shutdown")
// defineSignal("foreman.resume")
// defineSignal<[{ beadId: string }]>("foreman.forceDispatch")
// defineSignal<[{ beadId: string; reason: string }]>("foreman.skipBead")
// defineSignal<[Partial<ForemanInput>]>("foreman.updateConfig")
```

### 4.9 Operator Queries

```
ForemanStatusQuery -> ForemanStatus {
  phase: string                   // Current phase name
  currentBeadId: string | null    // Bead being worked on
  currentWorkflowId: string | null // Child workflow ID
  iterationCount: number          // Current run iteration
  lifetimeIterations: number      // Total across all continue-as-new runs
  lifetimeDispatches: number
  lifetimeCompletions: number
  lifetimeFailures: number
  lifetimeEscalations: number
  uptime: number                  // Ms since foremanStartedAt
  lastHealthCheck: HealthCheckResult | null
  recentOutcomes: DispatchOutcome[] // Last 20
  retryLedger: RetryLedgerEntry[]
  paused: boolean
  shuttingDown: boolean
}

ForemanHealthQuery -> HealthCheckResult
  // Returns the most recent health check result

ForemanHistoryQuery -> DispatchOutcome[]
  // Returns the recent outcomes ring buffer
```

---

## 5. Activity Contracts

Each activity is independently retryable by Temporal. Activities contain
all I/O; the workflow is deterministic.

### 5.1 checkStackHealth

**Input:** `{ repoPath: string; doltConfig: DoltConfig; kiloConfig: KiloConfig }`

**Output:** `HealthCheckResult`

**Timeout:** 30 seconds

**Retries:** 2 attempts, 5s backoff

**Behavior:** Runs health checks against all five subsystems in parallel.
Returns aggregate result. Never throws -- failures are reported in the result
structure.

### 5.2 selectNextBead

**Input:** `{ repoPath: string; retryLedger: RetryLedgerEntry[]; skipList: string[] }`

**Output:** `BeadCandidate | null`

**Timeout:** 30 seconds

**Retries:** 2 attempts, 5s backoff

**Behavior:**
1. Runs `bd ready --json` in the repository directory.
2. Parses the JSON output into `BeadCandidate[]`.
3. Filters out beads in `skipList` and beads with exhausted retries.
4. Sorts by priority (P0 > P1 > P2 > P3), then by dependency satisfaction.
5. Returns the highest-priority dispatchable bead, or `null` if none.

### 5.3 evaluateDispatchability

**Input:** `{ candidate: BeadCandidate; healthResult: HealthCheckResult; retryLedger: RetryLedgerEntry[]; config: ForemanInput }`

**Output:** `DispatchabilityResult`

**Timeout:** 15 seconds

**Retries:** 1 attempt

**Behavior:** Pure decision function. Evaluates whether the candidate can
be dispatched given current health state, retry state, and configuration.
Constructs the `DispatchPlan` if dispatching.

### 5.4 dispatchBead

**Input:** `DispatchPlan`

**Output:** `{ workflowId: string; runId: string }`

**Timeout:** 60 seconds

**Retries:** 2 attempts, 5s backoff

**Behavior:** Starts an `agentTaskWorkflow` child workflow with the
configured parameters. Returns the child workflow's ID and run ID.
The child workflow is the existing `agentTaskWorkflow` from
`daemon/src/temporal/workflows.ts` -- no new workflow type.

### 5.5 monitorDispatch

**Input:** `{ workflowId: string; runId: string; timeoutMs: number; pollIntervalMs: number }`

**Output:** `DispatchOutcome`

**Timeout:** Matches the dispatch timeout + 60s buffer

**Retries:** 0 (monitoring is not retryable -- the child workflow is the
retryable unit)

**Behavior:** Queries the child workflow's status query at regular intervals.
Detects completion, failure, timeout, or abort. Returns a `DispatchOutcome`
when the child workflow reaches a terminal state. Heartbeats progress to
Temporal so the foreman's liveness is observable.

### 5.6 closeBead

**Input:** `{ repoPath: string; beadId: string; outcome: DispatchOutcome }`

**Output:** `{ closed: boolean; error: string | null }`

**Timeout:** 30 seconds

**Retries:** 3 attempts, 5s backoff

**Behavior:** Runs `bd close <beadId>` in the repository directory. Updates
beads state. Exports JSONL for git-portable sync.

### 5.7 createEscalation

**Input:** `{ repoPath: string; beadId: string; reason: string; outcomes: DispatchOutcome[]; retryEntry: RetryLedgerEntry }`

**Output:** `{ escalationBeadId: string }`

**Timeout:** 30 seconds

**Retries:** 2 attempts, 5s backoff

**Behavior:** Creates a new bead describing the escalation, including:
- The original bead ID and title
- All dispatch outcomes (attempts, errors, costs)
- The retry ledger entry showing exhaustion
- A human-readable summary of why autonomous recovery failed
- Label: `escalation`, `human-required`

---

## 6. Beads State -> Scheduling Decisions

The foreman does not maintain its own work queue. It derives scheduling
decisions from Beads state.

### 6.1 Beads State Mapping

| Beads Status | Foreman Interpretation | Action |
|---|---|---|
| `ready` | Eligible for dispatch | Include in candidate evaluation |
| `in_progress` | Being worked on (possibly by another agent) | Skip -- do not dispatch |
| `blocked` | Dependencies not met | Skip -- dependencies must close first |
| `closed` | Completed | Skip -- nothing to do |
| `wontfix` | Explicitly skipped | Skip |

### 6.2 Selection Heuristics

When multiple beads are `ready`, the foreman applies these heuristics
in order:

1. **Priority.** P0 > P1 > P2 > P3.
2. **Retry-pending.** Beads with pending retries (backoff elapsed) are
   dispatched before new beads at the same priority level.
3. **Dependency proximity.** Beads whose completion would unblock other
   beads are preferred.
4. **Staleness.** Beads that have been `ready` longest are preferred
   (FIFO within priority).
5. **Operator override.** A `forceDispatch` signal bypasses all heuristics.

### 6.3 Bead Lifecycle During Foreman Dispatch

```
Bead: ready
  | foreman selects
Bead: in_progress (foreman runs `bd update <id> --status in_progress`)
  | child workflow starts
  | child workflow completes
  | foreman evaluates outcome
  |
  +-- SUCCESS -> bd close <id> -> Bead: closed
  |
  +-- FAILURE (retryable) -> Bead stays in_progress, retry scheduled
  |     | retry exhausted -> bd update <id> --status ready + create escalation
  |
  +-- FAILURE (non-retryable) -> create escalation -> bd update <id> --status ready
```

The foreman sets the bead back to `ready` (not `blocked`) on exhausted
retries so that a human can investigate and re-trigger. The escalation
bead provides the failure context.

---

## 7. Exception Taxonomy

The foreman handles most failure modes autonomously. Human intervention
is required only for the classes listed below.

### 7.1 Autonomous Recovery (No Human Required)

| Exception Class | Detection | Recovery |
|---|---|---|
| Transient kilo serve failure | Health check: `kiloServe.status = "down"` | Idle until next health check passes |
| Transient Dolt failure | Health check: `dolt.status = "down"` | Idle until next health check passes |
| Agent task timeout | `DispatchResult.kind = "timeout"` | Retry with same parameters (bounded) |
| Agent task error (retryable) | `DispatchResult.kind = "failed"` with `retryable = true` | Retry with same parameters (bounded) |
| Punch card validation failure | `DispatchResult.kind = "validation_failed"` | Retry once; escalate if second attempt also fails |
| Cost budget exceeded | `DispatchResult.kind = "budget_exceeded"` | Log, do not retry; create issue for cost review |
| Git dirty state | Health check: `git.status = "degraded"` | Log warning, proceed (agent may be mid-commit) |

### 7.2 Human-Required Exceptions

These are the **only** cases where the foreman creates an escalation
and stops attempting the bead:

| Exception Class | Detection | Escalation |
|---|---|---|
| **Persistent infrastructure failure** | Same subsystem `down` for 3+ consecutive health checks | Create escalation bead: "Infrastructure down: {subsystem}. Manual investigation required." |
| **Retry exhaustion** | `RetryLedgerEntry.exhausted = true` | Create escalation bead with all attempt outcomes and error details |
| **Non-retryable agent failure** | `DispatchResult.kind = "failed"` with `retryable = false` | Create escalation bead immediately -- the failure indicates a structural problem (bad prompt, missing evidence, impossible task) |
| **Repeated punch card failure** | Two consecutive `validation_failed` outcomes for same bead | Create escalation bead: punch card requirements may be misconfigured |
| **Unknown error** | Unclassified exception in activity | Create escalation bead with full error trace |

### 7.3 Retryability Classification

The foreman classifies `DispatchResult` into retryable vs. non-retryable:

```
isRetryable(result: DispatchResult): boolean =
  match result.kind:
    "timeout"            -> true   // Transient -- might succeed with more time
    "failed"             -> result.retryable  // Agent-reported
    "validation_failed"  -> true   // Might be timing (punches not yet minted)
    "budget_exceeded"    -> false  // Structural -- same budget will fail again
    "aborted"            -> false  // Operator-initiated -- do not retry
    "completed"          -> false  // Not a failure
```

---

## 8. Telemetry and Checkpoints -> Completion and Failure Decisions

The foreman does not directly inspect Dolt telemetry. It delegates
monitoring to the existing `agentTaskWorkflow`, which already handles:

- Poll-based progress monitoring via `pollUntilDone`
- Cost budget enforcement via `checkCostBudget`
- Punch card validation via `validateTaskPunchCard`
- Post-workflow session audit via `runSessionAudit`

The foreman consumes the `AgentTaskResult` returned by the child workflow
and maps it to `DispatchOutcome`.

### 8.1 Child Workflow Result -> Dispatch Outcome Mapping

| `AgentTaskResult.status` | `DispatchResult.kind` | Retryable? |
|---|---|---|
| `"completed"` | `"completed"` | N/A |
| `"failed"` | `"failed"` | Depends on error message classification |
| `"aborted"` | `"aborted"` | No |
| `"validation_failed"` | `"validation_failed"` | Yes (once) |
| `"budget_exceeded"` | `"budget_exceeded"` | No |

### 8.2 Error Classification Heuristics

When `AgentTaskResult.status = "failed"`, the foreman classifies the error:

| Error Pattern | Classification | Retryable? |
|---|---|---|
| Contains "timeout" or "timed out" | Timeout | Yes |
| Contains "ECONNREFUSED" or "ENOTFOUND" | Infrastructure | Yes |
| Contains "session" + "not found" | Stale session | Yes |
| Contains "rate limit" or "429" | Rate limit | Yes (with backoff) |
| `AgentTaskResult.audit?.verdict = "fail"` with critical findings | Structural failure | No |
| All other errors | Unknown | No (conservative) |

### 8.3 Audit-Informed Decisions

When the child workflow's post-completion audit is available, the foreman
uses it to inform retry decisions:

| Audit Verdict | Foreman Action |
|---|---|
| `"pass"` | Accept completion |
| `"warn"` | Accept completion, log warnings |
| `"fail"` with `loop_signature` | Do not retry -- the agent is looping |
| `"fail"` with `cost_anomaly` | Do not retry -- cost is anomalous |
| `"fail"` with `missing_quality_gate` | Retry once -- gate might have been skipped transiently |
| `"fail"` with `incomplete_subtask_tree` | Retry once -- subtask might have been orphaned |

---

## 9. Operator Control

### 9.1 Pause/Resume

- **Pause:** The foreman completes its current dispatch (if any), then
  enters the `paused` phase. No new work is polled or dispatched.
  The foreman remains alive and queryable.
- **Resume:** The foreman exits the `paused` phase and resumes the
  control loop from the `polling` phase.

### 9.2 Shutdown

- **Shutdown:** The foreman completes its current dispatch (if any), then
  calls `continueAsNew` with `shutdownRequested: true` in the carried
  state. The new workflow execution sees this flag, logs the shutdown
  reason, and returns without entering the control loop.

  This ensures the workflow terminates cleanly with a "Completed" status
  rather than being cancelled.

### 9.3 Force Dispatch

- **forceDispatch:** Bypasses the normal selection heuristics and
  dispatches the specified bead immediately. The bead must exist and
  be in a dispatchable state (`ready` or `in_progress`). If the foreman
  is currently monitoring a dispatch, the force dispatch is queued and
  executed after the current dispatch completes.

### 9.4 Skip Bead

- **skipBead:** Adds the bead to the skip list for the current foreman
  run. The bead is not dispatched until the foreman restarts (via
  continue-as-new or fresh start). The reason is logged.

### 9.5 Update Config

- **updateConfig:** Merges partial configuration into the foreman's
  active config. Takes effect on the next iteration. Useful for
  adjusting poll intervals, cost budgets, or retry limits without
  restarting.

---

## 10. Foreman Workflow Pseudocode

```typescript
async function foremanWorkflow(input: ForemanInput): Promise<ForemanResult> {
  const state = initializeState(input);
  registerSignalHandlers(state);
  registerQueryHandlers(state);

  // Check for shutdown from previous continue-as-new
  if (state.shutdownRequested) {
    return makeResult("shutdown", state);
  }

  while (true) {
    // -- Check continue-as-new thresholds --
    if (shouldContinueAsNew(state, input)) {
      return continueAsNew<typeof foremanWorkflow>({
        ...input,
        carriedState: serializeState(state),
      });
    }

    // -- Check operator signals --
    if (state.shutdownRequested) {
      return makeResult("shutdown", state);
    }
    if (state.pauseRequested) {
      state.phase = "paused";
      await condition(() => !state.pauseRequested || state.shutdownRequested);
      if (state.shutdownRequested) return makeResult("shutdown", state);
      continue;
    }

    // -- Check for forced dispatch --
    const forcedBeadId = state.forceDispatchQueue.shift();

    // -- Phase: Health Check (throttled) --
    if (shouldRunHealthCheck(state, input)) {
      state.phase = "health_check";
      state.lastHealthCheck = await checkStackHealth(...);
      state.lastHealthCheckAt = now();
    }

    if (state.lastHealthCheck?.overall === "fail") {
      state.phase = "idle";
      await sleep(input.pollIntervalMs);
      state.iterationCount++;
      continue;
    }

    // -- Phase: Select --
    state.phase = "selecting";
    const candidate = forcedBeadId
      ? await getBeadById(forcedBeadId)
      : await selectNextBead(input.repoPath, state.retryLedger, state.skipList);

    if (!candidate) {
      state.phase = "idle";
      await sleep(input.pollIntervalMs);
      state.iterationCount++;
      continue;
    }

    // -- Phase: Evaluate Dispatchability --
    const evaluation = await evaluateDispatchability(
      candidate, state.lastHealthCheck, state.retryLedger, input
    );

    if (evaluation.decision !== "dispatch") {
      state.phase = "idle";
      await sleep(input.pollIntervalMs);
      state.iterationCount++;
      continue;
    }

    // -- Phase: Dispatch --
    state.phase = "dispatching";
    state.currentBeadId = candidate.beadId;
    await claimBead(input.repoPath, candidate.beadId);
    const { workflowId, runId } = await dispatchBead(evaluation.dispatchPlan!);
    state.currentWorkflowId = workflowId;

    // -- Phase: Monitor --
    state.phase = "monitoring";
    const outcome = await monitorDispatch(
      workflowId, runId,
      evaluation.dispatchPlan!.timeoutMs,
      input.pollIntervalMs,
    );

    // -- Phase: Handle Outcome --
    state.recentOutcomes.push(outcome);  // Ring buffer, max 20
    state.currentBeadId = null;
    state.currentWorkflowId = null;
    state.lifetimeDispatches++;

    switch (outcome.result.kind) {
      case "completed":
        state.phase = "completing";
        await closeBead(input.repoPath, candidate.beadId, outcome);
        state.lifetimeCompletions++;
        removeFromRetryLedger(state, candidate.beadId);
        break;

      case "failed":
      case "timeout":
      case "validation_failed":
        state.phase = "failing";
        const retryEntry = updateRetryLedger(state, candidate.beadId, outcome);
        if (!retryEntry.exhausted && isRetryable(outcome.result)) {
          state.phase = "retrying";
          // Backoff is enforced by nextRetryAfter in the ledger
        } else {
          state.phase = "escalating";
          await createEscalation(input.repoPath, candidate.beadId, ...);
          await unclaimBead(input.repoPath, candidate.beadId);
          state.lifetimeFailures++;
          state.lifetimeEscalations++;
        }
        break;

      case "budget_exceeded":
        state.phase = "escalating";
        await createEscalation(input.repoPath, candidate.beadId, ...);
        await unclaimBead(input.repoPath, candidate.beadId);
        state.lifetimeFailures++;
        state.lifetimeEscalations++;
        break;

      case "aborted":
        await unclaimBead(input.repoPath, candidate.beadId);
        break;
    }

    state.iterationCount++;
  }
}
```

---

## 11. Integration With Existing Infrastructure

### 11.1 Temporal Integration

The foreman is registered as a new workflow in `all-workflows.ts`:

```typescript
export { foremanWorkflow, /* signals, queries */ } from "./foreman.workflows.js";
```

It runs on the same `"agent-tasks"` task queue as `agentTaskWorkflow`.
The worker configuration (`maxConcurrentWorkflowTaskExecutions`) may need
adjustment to accommodate the long-lived foreman alongside short-lived
agent tasks.

### 11.2 Child Workflow: agentTaskWorkflow

The foreman dispatches work by starting `agentTaskWorkflow` as a Temporal
child workflow. This is the existing workflow from
`daemon/src/temporal/workflows.ts`. The foreman constructs `AgentTaskInput`
from the `DispatchPlan`:

```
AgentTaskInput {
  prompt:         DispatchPlan.prompt
  agent:          DispatchPlan.agent
  title:          DispatchPlan.title
  kiloHost:       ForemanInput.kiloHost
  kiloPort:       ForemanInput.kiloPort
  timeoutMs:      DispatchPlan.timeoutMs
  doltConfig:     { host, port, database } from ForemanInput
  cardId:         DispatchPlan.cardId
  costBudget:     { maxSessionCostUsd: DispatchPlan.costBudgetUsd }
}
```

### 11.3 Beads Integration

The foreman interacts with Beads via shell commands executed in activities:

| Operation | Command | When |
|---|---|---|
| List ready work | `bd ready --json` | Every poll cycle |
| Claim a bead | `bd update <id> --status in_progress` | Before dispatch |
| Close a bead | `bd close <id>` | After successful completion |
| Unclaim a bead | `bd update <id> --status ready` | After exhausted retries or non-retryable failure |
| Create escalation | `bd create "Escalation: <title>" --label escalation --label human-required` | After exhausted retries |
| Export state | `bd export -o .beads/issues.jsonl` | After any beads mutation |

### 11.4 Punch Card Integration

The foreman does not validate punch cards directly. Punch card validation
is performed by the child `agentTaskWorkflow` as its penultimate step
(Step 7 in the existing workflow). The foreman consumes the validation
result as part of `AgentTaskResult`.

### 11.5 Governor Integration

The governor subsystem (loop detection, session killing, diagnosis,
fitter dispatch) operates independently of the foreman. The governor
watches live sessions and kills runaway agents. The foreman observes
the result via `AgentTaskResult.status = "failed"` with an error
message from the governor.

Future integration: the foreman could subscribe to governor events
to preemptively cancel dispatches or adjust cost budgets. This is
deferred until the foreman's basic loop is proven.

---

## 12. Contracts

Control contracts formalize the interfaces between foreman components.
These live under `.kilocode/contracts/foreman/`.

### 12.1 Dispatch Contract

The dispatch contract defines what the foreman guarantees to a dispatched
child workflow and what it requires in return.

**Foreman guarantees to child:**
- Stack health was verified before dispatch
- The bead exists and was in `ready` state at dispatch time
- The child receives a well-formed `AgentTaskInput` with valid config
- Cost budget and timeout are set
- The foreman will wait for the child to complete (bounded by timeout)

**Child guarantees to foreman:**
- Returns `AgentTaskResult` with a valid status
- Does not exceed the cost budget (enforcement via governor)
- Does not run beyond the timeout (enforcement via `pollUntilDone`)
- If `cardId` is configured, validates its punch card before reporting completion

### 12.2 Retry Contract

The retry contract defines the bounded retry behavior.

**Invariants:**
- Maximum attempts per bead: `maxRetriesPerBead + 1` (default: 3)
- Backoff between retries: `retryBackoffMs` (default: 30s)
- Retry state survives continue-as-new (carried in `retryLedger`)
- A bead's retry ledger is cleared on successful completion
- Exhausted retries always produce an escalation bead

**Retry eligibility:**
- Only retryable `DispatchResult` kinds trigger retries (see S7.3)
- Budget-exceeded and aborted results never retry
- Retry backoff is enforced: the bead is not re-dispatched until
  `nextRetryAfter` has elapsed

### 12.3 Escalation Contract

The escalation contract defines the structure of human-required escalations.

**Escalation bead structure:**
- Title: `"Escalation: {original bead title}"`
- Labels: `["escalation", "human-required"]`
- Body contains:
  - Original bead ID and link
  - Exception class (from S7.2)
  - All dispatch outcomes for this bead (attempt number, error, cost, duration)
  - Retry ledger entry showing exhaustion
  - Recommended human actions
  - Total cost incurred across all attempts

**Escalation is final.** Once escalated, the foreman does not attempt the
original bead again unless the human closes the escalation bead and sets the
original bead back to `ready`.

### 12.4 Health Gate Contract

The health gate contract defines the pre-dispatch health verification.

**Invariants:**
- Health check runs at most once per `healthCheckIntervalMs`
- A cached health result is valid for `healthCheckIntervalMs`
- `overall: "fail"` blocks all dispatches
- `overall: "degraded"` allows dispatches with a logged warning
- `overall: "pass"` allows dispatches
- Individual subsystem checks are independent and run in parallel
- Health check failures are never retried within a single check
  (the next scheduled check serves as the retry)

---

## 13. What This Does NOT Change

- **`agentTaskWorkflow` is unchanged.** The foreman uses it as-is.
  No modifications to the existing workflow or activities.
- **Governor is unchanged.** Loop detection, session killing, and
  diagnosis continue to operate independently.
- **Punch cards are unchanged.** Validation happens in the child
  workflow, not in the foreman.
- **Beads commands are unchanged.** The foreman uses standard `bd`
  CLI commands.
- **Worker setup is unchanged** except for adding the foreman workflow
  to the barrel file.

---

## 14. Future Extensions (Deferred)

These are explicitly out of scope for the current implementation but
inform the architecture's extensibility:

1. **Parallel dispatch.** `maxConcurrentDispatches > 1` with work-stealing
   and git worktree isolation. Requires Phase 5 (parallel line operations).

2. **Adaptive scheduling.** Use historical `DispatchOutcome` data to
   predict dispatch success probability and adjust scheduling heuristics.

3. **Governor integration.** Subscribe to governor kill events to
   preemptively mark dispatches as failed without waiting for timeout.

4. **Cross-repo dispatch.** Use Beads' multi-repo routing to dispatch
   work in `repomap-plant-daemon` or other repositories.

5. **Cognitive role creation.** Detect repeated failure patterns and
   create new agent modes to address them (Axis 7 from the cognitive
   services architecture).

6. **A2A facade.** Expose the foreman's dispatch and status queries
   via A2A protocol (Surface 2 from the cognitive services architecture).

---

## 15. Verification Checklist

This document covers the five required content areas from bead 0mp.1:

| Required Content | Section |
|---|---|
| ADR for foreman lifecycle and continue-as-new loop | S3 (Lifecycle), S10 (Pseudocode) |
| Contracts for dispatch, monitor, retry, recover, pause, resume, escalate | S5 (Activities), S9 (Operator Control), S12 (Contracts) |
| Exception taxonomy defining when humans are required | S7 (Exception Taxonomy) |
| Mapping from Beads state to foreman scheduling decisions | S6 (Beads State -> Scheduling Decisions) |
| Mapping from durable telemetry/checkpoints to completion and failure decisions | S8 (Telemetry -> Decisions) |

This document is specific enough for bead 0mp.10 to derive TypeScript types:

| Type needed by 0mp.10 | Defined in |
|---|---|
| Named workflow phases with clear semantics | S3.2 |
| Dispatchability result types | S4.5 |
| Health gate result types | S4.3 |
| Durable outcome types (completion, failure, escalation) | S4.6 |
| Operator control commands (pause, resume, shutdown, inspect) | S4.8, S4.9 |
| Continue-as-new state shape | S4.2 |
| Activity input/output payload shapes | S5 |
