# repomap-core

Deterministic repo scanning + artifact generation for **agent-grade code understanding**.

`repomap-core` turns a codebase into a small set of **stable, machine-readable artifacts** (think: an index, not a narrative). Agents (or humans) can then answer questions like “where is this symbol used?” or “what depends on this module?” without re-parsing the entire repo every time.

The core design goal is simple: **same inputs → byte-identical outputs**. That makes the artifacts safe to cache, diff, and trust in automated workflows.

---

## What you get

`repomap-core` produces an artifact directory (default `repo_map/`, commonly configured as `.repomap/`) that becomes the query surface for agents.

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
# Generate artifacts (preferred output dir is a hidden folder)
repomap generate .           # uses repomap.toml if present

# or, in some staging snapshots / older docs, the command may be named:
repomap analyze . --output-dir .repomap

# Confirm output exists
ls -la .repomap/  # or repo_map/

# (Recommended) verify determinism / contracts
repomap verify .
