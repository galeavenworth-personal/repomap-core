# Line Fault Contract (Template)

## Purpose

A **Line Fault Contract** is the minimal, human+agent readable payload emitted when a gate cannot complete deterministically within budgets.

This payload is the only required context passed from Orchestrator → Fitter.

## Minimum MVP Fields

 - `gate_id` (string): stable identifier for the gate (e.g., `pytest`, `mypy-src`, `ruff-check`).
- `invocation` (string): the exact command line that was executed.
- `elapsed_seconds` (number): wall-clock time elapsed when the stop occurred.
- `last_output_lines` (array[string]): tail of stdout/stderr (bounded; recommended `<= 50`).
- `stop_reason` (string enum): `timeout` | `stall` | `env_missing` | `ambiguous`.
- `repro_hints` (array[string]): minimal reproduction hints (e.g., working directory, required env vars, commands to re-run).

## JSON Example (MVP)

```json
{
  "gate_id": "pytest",
  "invocation": ".venv/bin/python -m pytest -q",
  "elapsed_seconds": 620,
  "last_output_lines": [
    "tests/integration/test_runtime_sampling_integration.py::test_sampling_distribution ...",
    "[progress] collected 412 items",
    "[progress] 6%"
  ],
  "stop_reason": "stall",
  "repro_hints": [
    "Run from repo root: /home/galeavenworth/Projects-Employee-1/repomap-core",
    "If reproducing locally, ensure venv is active; no network/secrets should be required for core quality gates",
    "Try increasing verbosity to surface progress so stall detection can distinguish work vs hang"
  ]
}
```
