# Foreman Contract: Health Gate

## Purpose

Define the pre-dispatch health verification protocol. No work is dispatched
unless the stack health gate passes.

## Subsystems Checked

| Subsystem | Check Method | Pass Criteria | Degraded Criteria |
|---|---|---|---|
| `kiloServe` | `GET /session` | HTTP 200 within 5s | Response > 3s |
| `dolt` | `SELECT 1` on configured database | Query succeeds within 5s | Query succeeds but > 3s |
| `git` | `git status --porcelain` | Exit 0, no merge conflicts | Exit 0 with uncommitted changes |
| `temporal` | Implicit (activity execution) | Activity runs | N/A (binary: up or not) |
| `beads` | `bd ready --json` | Exit 0, valid JSON | Exit 0 but empty results |

## HealthCheckResult Shape

```
HealthCheckResult {
  overall: "pass" | "degraded" | "fail"
  checkedAt: string               // ISO 8601
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

## Aggregation Rules

```
overall =
  if ANY subsystem is "down"     -> "fail"
  if ANY subsystem is "degraded" -> "degraded"
  else                           -> "pass"
```

## Dispatch Gate Rules

| Overall Status | Dispatch Allowed? | Foreman Action |
|---|---|---|
| `pass` | Yes | Proceed to bead selection |
| `degraded` | Yes | Log warning, proceed to bead selection |
| `fail` | No | Enter `idle` phase, wait for next poll interval |

## Throttling

- Health checks run at most once per `healthCheckIntervalMs` (default: 300,000ms = 5 min).
- A cached health result is considered valid for `healthCheckIntervalMs`.
- When the foreman has been idle (no beads dispatched), health checks still
  run on schedule to detect infrastructure recovery.

## Persistent Failure Detection

If the same subsystem is `"down"` for 3 or more consecutive health checks,
the foreman creates an infrastructure escalation bead:

```
Title: "Escalation: Infrastructure down -- {subsystem}"
Labels: ["escalation", "human-required", "infrastructure"]
Priority: P0
```

The foreman continues running (it does not shut down for infrastructure
failures) but will not dispatch until the subsystem recovers.

## References

- Architecture: [`docs/infra/foreman-architecture.md`](../../../docs/infra/foreman-architecture.md) S4.3, S5.1, S12.4
- Restoration contract: [`line_health/restoration_contract.md`](../line_health/restoration_contract.md)
