# Compressed Workflow Proof: Command Dialect Token Savings

**Bead:** repomap-core-4f0.8  \
**Date:** 2026-02-20  \
**Depends on:** command dialect routing matrix (repomap-core-4f0.7) via [`commands.toml`](../../.kilocode/commands.toml)  \
**Baseline artifact:** [`beads_land_plane.sh`](../../.kilocode/tools/beads_land_plane.sh)

## 1) Problem Statement

Workflow automation expressed as verbose bash scripts consumes a disproportionate amount of context budget:

- Each workflow invocation repeats boilerplate (shell setup, error handling, consistent flags).
- The same “quality gates + close + sync” sequence appears across multiple workflows.
- Repeating those details forces models to spend tokens re-parsing *execution mechanics* instead of making decisions.

The command dialect (defined in [`commands.toml`](../../.kilocode/commands.toml)) replaces verbose scripts with short **verb+noun** pairs that route deterministically to pre-defined tool bindings.

## 2) The Three Compressed Forms (and Their Dialect Routing)

### A. 6-line form (expanded individual gates + closing)

Dialect form:

```text
format ruff
check ruff
check mypy
test pytest
close issue {id}
sync push
```

Routing model:

- Each line is a **verb+noun** pair used as a lookup key in [`commands.toml`](../../.kilocode/commands.toml).
- The router binds that key to a concrete tool invocation (typically a deterministic CLI command).

Illustrative mapping (conceptual expansion):

| Dialect | Routed intent (defined in `commands.toml`) | Canonical underlying action (example) |
|---|---|---|
| `format ruff` | run formatting gate | `.venv/bin/python -m ruff format --check .` |
| `check ruff` | run lint gate | `.venv/bin/python -m ruff check .` |
| `check mypy` | run typecheck gate | `.venv/bin/python -m mypy src` |
| `test pytest` | run tests gate | `.venv/bin/python -m pytest -q` |
| `close issue {id}` | close Beads issue | `bd close {id}` (via repo tooling) |
| `sync push` | sync Beads state to shared branch | `bd sync` (via repo tooling) |

### B. 3-line form (composite quality gate + closing)

Dialect form:

```text
gate quality
close issue {id}
sync push
```

Routing model:

- `gate quality` is a **composite** command in [`commands.toml`](../../.kilocode/commands.toml).
- It expands to the same four gate invocations as the 6-line form, but references them indirectly.

Illustrative mapping (conceptual expansion):

| Dialect | Routed intent (defined in `commands.toml`) | Expands to |
|---|---|---|
| `gate quality` | run the standard quality gate bundle | `format ruff` + `check ruff` + `check mypy` + `test pytest` |

### C. 1-line form (composite-of-composites)

Dialect form:

```text
land plane --bead-id {id}
```

Routing model:

- `land plane` is a **composite-of-composites** entry in [`commands.toml`](../../.kilocode/commands.toml).
- It encapsulates the end-of-session landing procedure (gates + close + sync) behind a single short command.

Illustrative mapping (conceptual expansion):

| Dialect | Routed intent (defined in `commands.toml`) | Expands to |
|---|---|---|
| `land plane --bead-id {id}` | complete the “landing the plane” workflow | `gate quality` + `close issue {id}` + `sync push` |

## 3) Token Measurements (Verified)

**Token estimation method:** word count × 1.3 multiplier (standard code heuristic)

| Artifact | Lines | Words | Chars | ~Tokens |
|----------|-------|-------|-------|---------|
| `beads_land_plane.sh` (full script) | 196 | 522 | 4,819 | 678 |
| `commands.toml` (full routing matrix) | 406 | 1,150 | 11,330 | 1,495 |
| `commands.toml` (gate entries only) | 42 | 132 | 1,171 | 171 |
| `commands.toml` (composite entry) | 8 | 31 | 295 | 40 |
| `commands.toml` (land entry) | 10 | 43 | 388 | 55 |
| **6-line dialect form** | **6** | **13** | **72** | **16** |
| **3-line composite form** | **3** | **7** | **39** | **9** |
| **1-line land form** | **1** | **4** | **25** | **5** |

**Savings vs `beads_land_plane.sh`:**

- 6-line form: 662 tokens saved (97.6% reduction)
- 3-line composite: 669 tokens saved (98.7% reduction)
- 1-line land: 673 tokens saved (99.3% reduction)

## 4) Why It Works

### 1) Pre-training exploitation (self-documenting commands)

Verb+noun pairs like “format ruff” or “check mypy” align with widely-known tool idioms, so models can infer intent without re-reading long scripts. The dialect leverages the model’s existing prior on common developer actions.

### 2) Amortized knowledge (load once, reference many)

The routing matrix in [`commands.toml`](../../.kilocode/commands.toml) is a one-time cost. After it is loaded into working context for a session, subsequent workflow invocations only need the short dialect references.

### 3) Compositional compression (composites reduce repeated structure)

The dialect supports composition:

- `gate quality` encapsulates four gates in two words.
- `land plane` encapsulates the entire “quality gates + close + sync” landing procedure behind a single command.

This captures *structure* (workflow shape) rather than *mechanics* (script implementation details).

## 5) Amortization Analysis

Using the verified measurements:

- One-time routing matrix load cost: **~1,495 tokens** for full [`commands.toml`](../../.kilocode/commands.toml).
- Per-invocation savings vs the verbose baseline: **~670 tokens** (using the 3-line or 1-line forms).

Breakeven point:

```text
breakeven ≈ 1,495 / 670 ≈ 2.2 invocations
```

Rounded to whole invocations, breakeven occurs at **invocation #3**.

After that point, each additional workflow invocation produces net token savings while preserving determinism (the router still executes the same underlying commands).

## 6) Broader Implications

The broader plant infrastructure contains ~12 workflow files totaling ~3,017 lines. Quality gate references appear repeatedly across workflows (e.g., session end, CI-fix loops, verification runs). The command dialect compresses all repeated gate boilerplate into:

- a stable routing table (one-time cost), and
- minimal per-use references (`gate quality`, `land plane`).

This is especially valuable for:

- **Long sessions** where repeated “land the plane” invocations occur.
- **Multi-agent handoffs** where new agents must quickly align on canonical gate procedures.
- **Context-constrained models** where even a few hundred tokens reclaimed per step meaningfully reduce truncation risk.

Roadmap alignment: this proof supports the Phase 2, item 3 direction in [`roadmap-plant-infrastructure.md`](../../plans/roadmap-plant-infrastructure.md) by showing the routing matrix design is not merely organizational—it is operationally efficient.

## 7) Conclusion

The command dialect achieves **97–99% token reduction per workflow invocation** compared to the verbose baseline script [`beads_land_plane.sh`](../../.kilocode/tools/beads_land_plane.sh).

Because [`commands.toml`](../../.kilocode/commands.toml) is loaded once and then referenced cheaply, the approach reaches amortized breakeven at approximately **3 invocations**, after which every invocation is “pure savings.”

This document therefore proves the routing matrix design (repomap-core-4f0.7) is operationally useful: it reduces repeated boilerplate tokens while preserving deterministic execution.

