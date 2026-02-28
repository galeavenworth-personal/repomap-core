# Optimization Layer (`optimization/`)

This directory hosts the DSPy optimization layer for prompt compilation and related experimentation.

## Placement Decision

- `optimization/` is top-level by design.
- DSPy code does **not** live in `src/` because `src/` is the deterministic core certainty engine.
- DSPy code does **not** live in `daemon/src/` because daemon runtime behavior should remain decoupled from Python optimization workflows.

## Purpose

- Provide a Python-native workspace for DSPy signatures/modules and prompt compilation experiments.
- Prototype the Dolt-as-bus integration pattern where Python writes compiled artifacts and TypeScript reads them.

## Smoke Test

Run the DSPy local smoke test (no API keys required):

```bash
.venv/bin/python -m pytest optimization/tests/test_smoke.py -v
```

## Dolt-as-Bus Pattern

- Python writer: [`optimization/dolt_bus.py`](optimization/dolt_bus.py)
  - Writes/reads `compiled_prompts` records in Dolt (`punch_cards` DB over MySQL wire protocol).
- TypeScript reader: [`daemon/src/optimization/prompt-reader.ts`](daemon/src/optimization/prompt-reader.ts)
  - Reads single/multiple compiled prompt records for daemon-side consumption.
- DDL init script: [`optimization/scripts/init_compiled_prompts.sh`](optimization/scripts/init_compiled_prompts.sh)
  - Idempotently creates the `compiled_prompts` table.

