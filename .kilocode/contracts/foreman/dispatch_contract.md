# Foreman Contract: Dispatch

## Purpose

Define the guarantees exchanged between the foreman workflow and a dispatched
child workflow (`agentTaskWorkflow`). This contract governs every dispatch
the foreman initiates.

## Parties

- **Foreman** -- the long-lived Temporal workflow that selects and dispatches work.
- **Child** -- an `agentTaskWorkflow` instance executing a single bead.

## Foreman Guarantees (Pre-Dispatch)

Before starting a child workflow, the foreman guarantees:

1. **Stack health verified.** The most recent `HealthCheckResult.overall`
   is `"pass"` or `"degraded"` (never `"fail"`).

2. **Bead claimed.** The bead's Beads status has been set to `in_progress`
   via `bd update <id> --status in_progress`.

3. **Valid input.** The `AgentTaskInput` passed to the child contains:
   - A non-empty `prompt` derived from the bead's description
   - A valid `agent` mode slug
   - `kiloHost` and `kiloPort` pointing to a verified kilo serve instance
   - `timeoutMs` > 0
   - `doltConfig` populated if punch card validation is configured
   - `costBudget.maxSessionCostUsd` > 0

4. **Timeout enforcement.** The foreman's monitor activity will abort the
   child workflow if it exceeds `DispatchPlan.timeoutMs`.

5. **No concurrent dispatch to the same bead.** The foreman dispatches
   at most one child workflow per bead ID at any time.

## Child Guarantees (Post-Dispatch)

The child workflow guarantees:

1. **Terminal result.** Returns an `AgentTaskResult` with one of the
   defined statuses: `completed`, `failed`, `aborted`, `validation_failed`,
   `budget_exceeded`.

2. **Cost accounting.** Reports `totalCost`, `tokensInput`, `tokensOutput`
   in the result.

3. **Punch card validation.** If `cardId` is configured in the input,
   validates its punch card before reporting `completed`.

4. **Session cleanup.** On cancellation or failure, aborts its kilo serve
   session (including all child sessions in the delegation tree).

5. **Audit report.** If `doltConfig` is provided and audit is not disabled,
   includes an `AuditSummary` in the result.

## DispatchPlan Shape

```
DispatchPlan {
  beadId: string
  prompt: string
  agent: string
  title: string
  timeoutMs: number
  costBudgetUsd: number
  cardId: string | null
  enforcedOnly: boolean
}
```

## Failure Modes

| Failure | Who Detects | Recovery |
|---|---|---|
| Child workflow throws | Temporal (workflow failure) | Foreman receives error, classifies retryability |
| Child exceeds timeout | Foreman monitor activity | Foreman cancels child, records timeout outcome |
| Child exceeds cost budget | Child's budget check activity | Child returns `budget_exceeded` status |
| Punch card validation fails | Child's validation activity | Child returns `validation_failed` status |
| kilo serve dies mid-session | Child's poll activity (ECONNREFUSED) | Child throws, foreman classifies as retryable |

## References

- Architecture: [`docs/infra/foreman-architecture.md`](../../../docs/infra/foreman-architecture.md) S5.4, S12.1
- Existing workflow: [`daemon/src/temporal/workflows.ts`](../../../daemon/src/temporal/workflows.ts)
- Error propagation: [`composability/error_propagation.md`](../composability/error_propagation.md)
