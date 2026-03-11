# Foreman Contract: Operator Control

## Purpose

Define the signals and queries that allow human operators to inspect and
control the running foreman workflow.

## Signals (Commands)

Signals are fire-and-forget messages sent to the foreman workflow via
Temporal's signal mechanism. They take effect on the next iteration of
the control loop (or immediately if the foreman is in `idle` or `paused`
phase).

### pause

**Signal name:** `foreman.pause`

**Payload:** none

**Behavior:** The foreman completes its current dispatch (if any), then
enters the `paused` phase. No new work is polled or dispatched. The
foreman remains alive and queryable.

**Idempotent:** Yes. Sending pause while already paused is a no-op.

### resume

**Signal name:** `foreman.resume`

**Payload:** none

**Behavior:** The foreman exits the `paused` phase and resumes from
`polling`. If the foreman is not paused, this is a no-op.

**Idempotent:** Yes.

### shutdown

**Signal name:** `foreman.shutdown`

**Payload:** `{ reason: string }`

**Behavior:** The foreman completes its current dispatch (if any), then
performs a clean continue-as-new with `shutdownRequested: true`. The next
workflow execution exits immediately with a "shutdown" result.

This ensures the workflow terminates with a Temporal "Completed" status
rather than being cancelled.

**Idempotent:** Yes. Subsequent shutdown signals update the reason but
do not change behavior.

### forceDispatch

**Signal name:** `foreman.forceDispatch`

**Payload:** `{ beadId: string }`

**Behavior:** Bypasses normal selection heuristics. The specified bead
is dispatched on the next iteration. If a dispatch is in progress, the
forced dispatch is queued.

**Validation:** The bead must exist. If it does not, the foreman logs
a warning and ignores the signal.

### skipBead

**Signal name:** `foreman.skipBead`

**Payload:** `{ beadId: string; reason: string }`

**Behavior:** Adds the bead to the skip list for the current foreman
run. The bead will not be dispatched until the foreman restarts.

### updateConfig

**Signal name:** `foreman.updateConfig`

**Payload:** `Partial<ForemanInput>`

**Behavior:** Merges the partial configuration into the foreman's active
config. Takes effect on the next iteration.

**Restricted fields:** `workflowId`, `repoPath`, and `carriedState`
cannot be updated via signal (they are immutable for a foreman instance).

## Queries (Inspection)

Queries are synchronous read operations that return the foreman's current
state without affecting its behavior.

### status

**Query name:** `foreman.status`

**Returns:** `ForemanStatus`

```
ForemanStatus {
  phase: string
  currentBeadId: string | null
  currentWorkflowId: string | null
  iterationCount: number
  lifetimeIterations: number
  lifetimeDispatches: number
  lifetimeCompletions: number
  lifetimeFailures: number
  lifetimeEscalations: number
  uptime: number
  lastHealthCheck: HealthCheckResult | null
  recentOutcomes: DispatchOutcome[]
  retryLedger: RetryLedgerEntry[]
  paused: boolean
  shuttingDown: boolean
}
```

### health

**Query name:** `foreman.health`

**Returns:** `HealthCheckResult | null`

The most recent health check result. Null if no health check has been
performed yet.

### history

**Query name:** `foreman.history`

**Returns:** `DispatchOutcome[]`

The recent outcomes ring buffer (last 20 dispatch outcomes).

## CLI Integration

The foreman is operated via Temporal CLI or a thin wrapper:

```bash
# Start the foreman
temporal workflow start \
  --task-queue agent-tasks \
  --type foremanWorkflow \
  --workflow-id foreman-repomap-core \
  --input '{"repoPath": "/home/user/repomap-core", ...}'

# Query status
temporal workflow query \
  --workflow-id foreman-repomap-core \
  --type foreman.status

# Pause
temporal workflow signal \
  --workflow-id foreman-repomap-core \
  --name foreman.pause

# Resume
temporal workflow signal \
  --workflow-id foreman-repomap-core \
  --name foreman.resume

# Shutdown
temporal workflow signal \
  --workflow-id foreman-repomap-core \
  --name foreman.shutdown \
  --input '{"reason": "Maintenance window"}'

# Force dispatch
temporal workflow signal \
  --workflow-id foreman-repomap-core \
  --name foreman.forceDispatch \
  --input '{"beadId": "repomap-core-4f0.13"}'
```

## References

- Architecture: [`docs/infra/foreman-architecture.md`](../../../docs/infra/foreman-architecture.md) S4.8, S4.9, S9
