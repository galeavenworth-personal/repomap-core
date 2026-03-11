# Foreman Contract: Retry

## Purpose

Define the bounded retry behavior for bead dispatch failures. Retries are
the foreman's primary autonomous recovery mechanism.

## Definitions

- **attempt:** One execution of a child workflow for a bead.
- **retry:** An additional attempt after a failed attempt.
- **Formula:** `total_attempts = 1 + retries_used`.
- **max_attempts:** `maxRetriesPerBead + 1` (configurable, default: 3).

## Retry Eligibility

A failed dispatch is eligible for retry if and only if:

1. The `DispatchResult` is classified as retryable (see classification table below).
2. The `RetryLedgerEntry.attempts < RetryLedgerEntry.maxAttempts`.
3. The retry backoff period has elapsed (`now >= RetryLedgerEntry.nextRetryAfter`).

### Retryability Classification

| DispatchResult.kind | Retryable? | Rationale |
|---|---|---|
| `completed` | N/A | Not a failure |
| `failed` (retryable=true) | Yes | Agent-reported transient error |
| `failed` (retryable=false) | No | Structural failure |
| `validation_failed` | Yes (max 1 retry) | Punches may not have been minted yet |
| `budget_exceeded` | No | Same budget will produce same breach |
| `timeout` | Yes | Transient -- may succeed with more time |
| `aborted` | No | Operator-initiated -- do not override |

### Audit-Informed Overrides

When the child workflow includes an audit summary, the foreman applies
these overrides regardless of the base retryability classification:

| Audit Finding | Override |
|---|---|
| `loop_signature` | Force non-retryable |
| `cost_anomaly` | Force non-retryable |
| `missing_quality_gate` | Allow retry (max 1) |
| `incomplete_subtask_tree` | Allow retry (max 1) |

## RetryLedgerEntry Shape

```
RetryLedgerEntry {
  beadId: string
  attempts: number
  maxAttempts: number
  lastAttemptAt: string         // ISO 8601
  lastError: string
  lastResult: DispatchResult
  nextRetryAfter: string        // ISO 8601
  exhausted: boolean
}
```

## Backoff Strategy

- **Base backoff:** `retryBackoffMs` (configurable, default: 30,000ms).
- **Strategy:** Fixed backoff (not exponential).
  Rationale: the foreman dispatches expensive multi-minute workflows.
  Exponential backoff would create unnecessarily long delays. If 30s
  is insufficient for recovery, the problem is structural.
- **Calculation:** `nextRetryAfter = lastAttemptAt + retryBackoffMs`.

## Invariants

1. A bead's retry ledger entry is **created** on first failure.
2. A bead's retry ledger entry is **updated** on subsequent failures.
3. A bead's retry ledger entry is **removed** on successful completion.
4. Retry ledger entries **survive continue-as-new** (carried in state).
5. Exhausted retries **always** produce an escalation bead (see escalation contract).
6. The foreman **never** retries a bead more than `maxAttempts` times
   across all continue-as-new boundaries.

## References

- Architecture: [`docs/infra/foreman-architecture.md`](../../../docs/infra/foreman-architecture.md) S7, S12.2
- Error propagation: [`composability/error_propagation.md`](../composability/error_propagation.md)
