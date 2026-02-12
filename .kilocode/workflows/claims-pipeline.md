# Claims Pipeline Workflow (EXPERIMENTAL / out-of-scope for repomap-core)

This repo is **repomap-core** (core-only). The claims pipeline is **unsupported/experimental** here.

- Expect **networked** execution and **secrets** (not offline by default).
- Do **not** treat this workflow as a default quality gate.
- If you need claims functionality, use the appropriate extension/package/branch that provides it.

## Prerequisites (only if you are intentionally running experimental claims tooling)

- A claims-capable distribution must be installed (not provided by repomap-core by default)
- Virtual environment must be activated
- Artifacts must be generated first
- Any required provider secrets (example: `OPENROUTER_API_KEY`) must be set

## Workflow Steps

### 1. Check Environment (optional)

Verify required environment variables for your provider:

```bash
test -n "$OPENROUTER_API_KEY" && echo "✓ OPENROUTER_API_KEY is set" || echo "✗ OPENROUTER_API_KEY is missing"
```

### 2. Generate Artifacts

Generate deterministic artifacts (symbols, deps, complexity, etc.):

```bash
.venv/bin/python -m repomap generate .
```

### 3. Run Claims Pipeline (EXPERIMENTAL)

Execute the full pipeline (generate → advance → verify):

If your installed distribution exposes a claims pipeline command, run it per that distribution’s docs.

Example shape (may not exist in repomap-core):

```bash
.venv/bin/python -m repomap claims pipeline \
  -c claims_skeleton.jsonl \
  --artifacts-dir .repomap \
  -o repomap_claims.jsonl
```

For fast iteration (limit claims):

```bash
.venv/bin/python -m repomap claims pipeline \
  -c claims_skeleton.jsonl \
  --artifacts-dir .repomap \
  --max-claims 5 \
  -o repomap_claims.jsonl
```

### 4. Quality Gates (repomap-core defaults)

Run the same checks as repomap-core CI:

```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```

## Common Issues

### Missing OPENROUTER_API_KEY

```bash
export OPENROUTER_API_KEY="your-api-key-here"
```

### Missing Artifacts

```bash
.venv/bin/python -m repomap generate .
ls -la .repomap/
```

### Resume Interrupted Run

```bash
.venv/bin/python -m repomap claims pipeline \
  -c claims_skeleton.jsonl \
  --artifacts-dir .repomap \
  --resume \
  -o repomap_claims.jsonl
```

## References

- Skill: [`repomap-claims-ops`](../skills/repomap-claims-ops/SKILL.md)
- Config: [`repomap.toml`](../../repomap.toml)
- Artifacts: [`.repomap/`](../../.repomap/)
