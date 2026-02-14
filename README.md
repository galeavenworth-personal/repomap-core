# repomap-core

Deterministic repo scanning + artifact generation for **agent-grade code understanding**.

`repomap-core` turns a codebase into a small set of **stable, machine-readable artifacts** (think: an index, not a narrative). Agents (or humans) can then answer questions like “where is this symbol used?” or “what depends on this module?” without re-parsing the entire repo every time.

The core design goal is simple: **same inputs → byte-identical outputs**. That makes the artifacts safe to cache, diff, and trust in automated workflows.

---

## What you get

`repomap-core` produces an artifact directory (default `.repomap/`) that becomes the query surface for agents.

Typical artifacts include:

- `symbols.jsonl` — symbol catalog (functions/classes/methods with locations and metadata)
- `deps.edgelist` — dependency edges (module → module)
- additional summaries (integration/layer/analyzer outputs) depending on config and enabled analyzers

The artifact directory is designed to be:
- **text-native** (JSONL / edgelists / small summaries)
- **diff-friendly**
- **incremental-workflow friendly** (generate → verify → query/report)

---

## Quick start (agent-friendly)

Generate artifacts first, then treat the artifact directory as your “truth layer”.

```bash
# Generate artifacts (default output dir is .repomap/)
repomap generate .           # uses repomap.toml if present

# Confirm output exists
ls -la .repomap/

# (Recommended) verify determinism / contracts
repomap verify .
