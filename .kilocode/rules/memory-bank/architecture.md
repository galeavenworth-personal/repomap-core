# Architecture

## Layered Architecture

Repomap follows a strict layered architecture defined in [`repomap.toml`](../../../repomap.toml).

```
┌─────────────────────────────────────┐
│  interface (CLI)                    │  src/cli.py
├─────────────────────────────────────┤
│  verification (determinism)         │  src/verify/**
├─────────────────────────────────────┤
│  foundation (core)                  │  src/artifacts/**, src/rules/**,
│                                     │  src/parse/**, src/scan/**,
│                                     │  src/graph/**, src/utils.py
└─────────────────────────────────────┘
```

### Dependency Rules

- **Foundation** → depends on nothing
- **Verification** → depends on foundation only
- **Interface** → depends on all layers

**Enforcement:** Layer rules are configured in `repomap.toml` and applied in core analysis code.

## Core↔Extension boundary

repomap-core exposes a small, stable contract surface under `src/contract/` intended for optional extension packages.

## Design Patterns

repomap-core focuses on deterministic scanning + artifact generation. Workflow-layer patterns (like line-health bounded gate execution) live under `.kilocode/`.

## References

- Layer config: [`repomap.toml`](../../../repomap.toml) (authoritative)
- Package manifest: [`pyproject.toml`](../../../pyproject.toml)
- Plans: [`plans/`](../../../plans/)
