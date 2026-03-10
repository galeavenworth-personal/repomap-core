# Foreman Contract: Escalation

## Purpose

Define the structure and semantics of escalations -- the foreman's mechanism
for requesting human intervention when autonomous recovery has failed.

## When Escalation Occurs

Escalation is triggered in exactly these cases:

| Trigger | Detection |
|---|---|
| Retry exhaustion | `RetryLedgerEntry.exhausted = true` |
| Non-retryable failure | `DispatchResult.kind = "failed"` with `retryable = false` |
| Budget exceeded | `DispatchResult.kind = "budget_exceeded"` |
| Repeated punch card failure | Two consecutive `validation_failed` for same bead |
| Persistent infrastructure failure | Same subsystem `down` for 3+ consecutive health checks |
| Unknown error | Unclassified exception in foreman activity |

## Escalation Bead Structure

The foreman creates a new Beads issue with the following structure:

```
Title: "Escalation: {original bead title}"
Labels: ["escalation", "human-required"]
Priority: Same as original bead (or P0 if infrastructure failure)
```

**Body content (markdown):**

```markdown
## Escalation Summary

- **Original bead:** {beadId} -- {title}
- **Exception class:** {class from taxonomy}
- **Total attempts:** {count}
- **Total cost incurred:** ${total across all attempts}

## Dispatch History

### Attempt 1
- **Started:** {ISO 8601}
- **Duration:** {ms}
- **Cost:** ${cost}
- **Result:** {kind}: {details}
- **Session ID:** {sessionId}
- **Workflow ID:** {workflowId}

### Attempt 2
...

## Retry Ledger
- **Max attempts:** {maxAttempts}
- **Last error:** {lastError}
- **Exhausted:** {yes/no}

## Recommended Actions
- {Action 1 based on exception class}
- {Action 2}

## Context
- **Foreman workflow ID:** {foremanWorkflowId}
- **Foreman uptime:** {duration}
- **Health at escalation:** {last health check summary}
```

## Post-Escalation Behavior

1. The original bead is set back to `ready` status
   (`bd update <id> --status ready`).
2. The foreman adds the original bead to its skip list for the current run.
3. The foreman does NOT attempt the bead again until:
   - The escalation bead is closed by a human
   - The foreman is restarted (continue-as-new or fresh start)
   - An operator sends a `forceDispatch` signal for the bead

## Escalation Is Final

Within a single foreman lifecycle (including continue-as-new runs),
an escalated bead is not re-attempted automatically. The escalation
bead serves as the communication channel between the foreman and the
human operator.

## Recommended Actions by Exception Class

| Exception Class | Recommended Actions |
|---|---|
| Retry exhaustion | Review dispatch history for patterns. Check if the bead's prompt or evidence is correct. Consider splitting the bead. |
| Non-retryable failure | Review the error trace. The failure is structural -- the bead may need redesign. |
| Budget exceeded | Review cost budget. The bead may need a higher budget or scope reduction. |
| Repeated punch card failure | Check punch card definitions. Required punches may be misconfigured or the workflow may not produce them. |
| Persistent infrastructure failure | Check {subsystem} health. The foreman has been unable to reach it for 3+ consecutive checks. |
| Unknown error | Review the full error trace. This is an unclassified exception that needs investigation. |

## References

- Architecture: [`docs/infra/foreman-architecture.md`](../../../docs/infra/foreman-architecture.md) S7.2, S12.3
- Error propagation: [`composability/error_propagation.md`](../composability/error_propagation.md)
