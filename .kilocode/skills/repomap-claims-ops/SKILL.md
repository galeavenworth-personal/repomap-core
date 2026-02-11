---
name: repomap-claims-ops
description: EXPERIMENTAL / out-of-scope for repomap-core. Guidance for running a claims pipeline in a claims-capable distribution (if installed). Not part of default offline quality gates.
---

# Repomap Claims Ops (EXPERIMENTAL / out-of-scope for repomap-core)

This repository is **repomap-core** (core-only). The claims pipeline is **unsupported/experimental** here.

- Do **not** require secrets/network for default development or CI parity.
- Only use this skill when you are intentionally working in a claims-capable environment.

## When to use this skill

Use this skill when you need to:

- Run `repomap claims generate`, `repomap claims advance`, `repomap claims verify`, or `repomap claims pipeline`
- Debug failures in the claims pipeline (generation, advancement, verification)
- Ensure commands match CI and project conventions

If you are working on repomap-core itself, prefer the core gates:

```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```

## Critical invariants

- Use the project virtual environment for all Python execution.
- Prefer explicit venv invocation:
  - `.venv/bin/python -m repomap ...`
  - `.venv/bin/python -m ruff ...`
  - `.venv/bin/python -m pytest ...`
- Artifacts directory is typically `.repomap` in this repo (configured in `repomap.toml` via `output_dir = ".repomap"`).

## Environment prerequisites

- Provider secrets (example: `OPENROUTER_API_KEY`) may be required for claim generation/advancement.
- A claims-capable distribution must be installed (repomap-core does not ship claims by default).

## Standard workflows

### Workflow A: End-to-end pipeline (most common)

1. Generate deterministic artifacts:

```bash
.venv/bin/python -m repomap generate .
```

2. Generate skeleton claims (only if claims commands exist in your environment):

```bash
.venv/bin/python -m repomap claims generate --artifacts-dir .repomap -o claims_skeleton.jsonl
```

3. Advance claims (evidence gathering):

```bash
.venv/bin/python -m repomap claims advance -c claims_skeleton.jsonl --artifacts-dir .repomap -o claims_advanced.jsonl
```

4. Verify claims against artifacts:

```bash
.venv/bin/python -m repomap claims verify -c claims_advanced.jsonl --artifacts-dir .repomap -o claims_verified.jsonl
```

### Workflow B: Single-command pipeline (advance → verify)

If you already have a skeleton claims file:

```bash
.venv/bin/python -m repomap claims pipeline -c claims_skeleton.jsonl --artifacts-dir .repomap -o claims_verified.jsonl
```

### Workflow C: Debugging / fast iteration

- Limit claim count:

```bash
.venv/bin/python -m repomap claims generate --artifacts-dir .repomap --max-claims 5
.venv/bin/python -m repomap claims pipeline -c claims_skeleton.jsonl --artifacts-dir .repomap --max-claims 3
```

- Resume an interrupted run:

```bash
.venv/bin/python -m repomap claims advance -c claims_skeleton.jsonl --artifacts-dir .repomap --resume
.venv/bin/python -m repomap claims verify -c claims_advanced.jsonl --artifacts-dir .repomap --resume
```

- Clean state and start fresh:

```bash
.venv/bin/python -m repomap claims verify -c claims_advanced.jsonl --artifacts-dir .repomap --clean
```

## Common failure modes and fixes

### Missing artifacts / wrong artifacts dir

- Symptom: CLI complains `--artifacts-dir` missing or directory not found.
- Fix: run generation and confirm the output directory:

```bash
.venv/bin/python -m repomap generate .
ls -la .repomap/
```

### Missing LangChain/OpenRouter configuration

- Symptom: network/auth errors during generation/advance.
- Fix: ensure `OPENROUTER_API_KEY` is set in the environment used to run the command.

### Quality gates after changes

Run the same checks as repomap-core CI:

```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```
