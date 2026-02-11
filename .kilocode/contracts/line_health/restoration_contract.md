# Restoration Contract (Template)

## Purpose

A **Restoration Contract** is the minimal payload returned by Fitter → Orchestrator describing what mitigation was applied in the workflow/runner layer, how it was verified, and what Fit Profile adjustments are now recommended.

Orchestrator uses this contract to decide whether to retry the blocked station (bounded).

## Minimum MVP Fields

- `gate_id` (string): stable identifier for the gate.
- `mitigation_applied` (array[string]): what changed (budgets/invocation/env alignment), phrased concretely.
- `verification_run` (object): evidence that the mitigation was exercised.
- `updated_fit_profile` (object): updated budgets/notes for future runs.

## JSON Example (MVP)

```json
{
  "gate_id": "pytest",
  "mitigation_applied": [
    "Increase no-output (stall) budget from 30s → 60s for pytest gate",
    "If stall persists, adjust invocation to show progress: add '-vv' to reduce false stall classification"
  ],
  "verification_run": {
    "invocation": ".venv/bin/python -m pytest -q",
    "status": "PASS",
    "elapsed_seconds": 142
  },
  "updated_fit_profile": {
    "timeout_seconds": 180,
    "stall_seconds": 60,
    "tail_lines": 50,
    "notes": "pytest output can be sparse during collection on some repos; stall budget increased. If still stalling, add verbosity (-vv) so the bounded runner can distinguish work vs hang.",
    "confidence": "medium"
  }
}
```

## Canonical Fit Profile (repomap-core default gates)

Use these as the **starting** budgets for repomap-core's offline quality gates:

| gate_id | invocation | timeout_seconds | stall_seconds | tail_lines |
|---|---|---:|---:|---:|
| `ruff-format` | `.venv/bin/python -m ruff format --check .` | 60 | 30 | 50 |
| `ruff-check` | `.venv/bin/python -m ruff check .` | 90 | 30 | 50 |
| `mypy-src` | `.venv/bin/python -m mypy src` | 120 | 30 | 50 |
| `pytest` | `.venv/bin/python -m pytest -q` | 180 | 30 | 50 |
