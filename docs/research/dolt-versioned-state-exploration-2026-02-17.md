# Dolt as Versioned State Layer: The Fifth Axis

**Date:** 2026-02-17
**Status:** Exploration
**Thinking session:** [`.kilocode/thinking/dolt-versioned-state-2026-02-17.json`](../../.kilocode/thinking/dolt-versioned-state-2026-02-17.json)
**Source:** https://github.com/dolthub/dolt

---

## Core Hypothesis

The fabrication plant has four established axes: control (task graph), capability (workflow graph), instruction (command dialect), and observability (session data). All four operate over **unversioned, file-based state**. Dolt provides the fifth axis: **versioned, queryable, branchable state** — turning the plant's memory from scattered files into a proper database with git semantics.

---

## The Five-Axis Plant Architecture

| # | Axis | What It Does | Primitive | Source |
|---|------|-------------|-----------|--------|
| 1 | **Control** | Execution topology — when/what to run | `new_task` tree | [dual-graph-architecture](dual-graph-architecture-2026-02-17.md) |
| 2 | **Capability** | Traversal policy — what's allowed | Modes → skills → tools | [dual-graph-architecture](dual-graph-architecture-2026-02-17.md) |
| 3 | **Instruction** | Compressed triggers — how to invoke | Verb+Noun → skill binding | [command-dialect-exploration](command-dialect-exploration.md) |
| 4 | **Observability** | Proof of execution — what happened | Session JSON, self-monitoring | [roadmap pivot](../../plans/roadmap-plant-infrastructure.md) |
| 5 | **State** | Versioned memory — what the plant knows | SQL + git semantics for data | **This document** |

### What's Missing Without Axis 5

The plant can orchestrate, constrain, compress, and observe — but it can't **remember with structure**. Current state is:

| State Artifact | Current Form | Problem |
|---|---|---|
| Beads (task tracking) | JSONL files + git merge driver | Line-level diffs, no query, fragile merge |
| Session data | JSON files on disk (1.1GB, 863 tasks) | Write-only blobs, no aggregate queries |
| Gate audit log | JSONL append-only | No time-travel, no cross-reference |
| Commands.toml (planned) | Static TOML file | No version history of config changes |
| Cost data | Scattered in session JSON | No aggregate view |

Every piece of plant state is a file on disk with git as the sync mechanism. Git is designed for **code** (text files with line-level diffs), not **data** (structured records with field-level semantics).

---

## What Dolt Is

Dolt is a SQL database that implements Git version control primitives at the data level.

**Key facts:**
- MySQL-compatible wire protocol (any MySQL client works)
- Single binary, no external dependencies
- Storage: custom B-tree format (prolly trees) optimized for structural sharing
- Open source (Apache 2.0)
- Offline-first: works entirely local, push/pull to remotes optional

### Core Primitives

| Git | Dolt | What It Does |
|-----|------|-------------|
| `git init` | `dolt init` | Create a versioned database |
| `git clone` | `dolt clone` | Clone a database |
| `git branch` | `dolt branch` / `CALL DOLT_BRANCH()` | Branch data |
| `git checkout` | `dolt checkout` / `CALL DOLT_CHECKOUT()` | Switch branches |
| `git commit` | `dolt commit` / `CALL DOLT_COMMIT()` | Snapshot database state |
| `git merge` | `dolt merge` / `CALL DOLT_MERGE()` | Merge with conflict resolution |
| `git diff` | `dolt diff` / `SELECT * FROM dolt_diff_<table>` | Row-level diff |
| `git log` | `dolt log` / `SELECT * FROM dolt_log` | Commit history |
| `git push/pull` | `dolt push` / `dolt pull` | Sync with remotes |

### SQL-Native Version Control

The killer feature: version control operations are available as **SQL functions and system tables**.

```sql
-- Time-travel query: what was the state at a specific commit?
SELECT * FROM beads AS OF 'abc123def';

-- Row-level diff between commits
SELECT * FROM dolt_diff_gate_runs
WHERE from_commit = 'abc123' AND to_commit = 'def456';

-- Branch from SQL
CALL DOLT_BRANCH('subtask-gate-check');
CALL DOLT_CHECKOUT('subtask-gate-check');

-- Commit from SQL
CALL DOLT_COMMIT('-am', 'Gate check complete: all 4 gates passed');

-- Merge from SQL
CALL DOLT_CHECKOUT('main');
CALL DOLT_MERGE('subtask-gate-check');
```

---

## Integration Points with the Plant

### 1. Beads → Dolt Table

**Current:** JSONL files synced via git merge driver on `beads-sync` branch.
**With Dolt:**

```sql
CREATE TABLE beads (
    id VARCHAR(20) PRIMARY KEY,
    title TEXT NOT NULL,
    status ENUM('open', 'in_progress', 'closed') NOT NULL,
    assignee VARCHAR(50),
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    closed_at DATETIME,
    labels JSON,
    body TEXT
);
```

`bd` commands become thin SQL wrappers:
- `bd ready` → `SELECT * FROM beads WHERE status = 'open'`
- `bd show <id>` → `SELECT * FROM beads WHERE id = ?`
- `bd update <id> --status in_progress` → `UPDATE beads SET status = 'in_progress' WHERE id = ?`
- `bd close <id>` → `UPDATE beads SET status = 'closed', closed_at = NOW() WHERE id = ?`
- `bd sync` → `dolt pull; dolt push`

**Advantage:** Row-level merge conflicts instead of line-level JSONL conflicts. Query capability. History via `dolt_log`.

### 2. Gate Runs → Dolt Table

**Current:** JSONL append-only log at `.kilocode/gate_runs.jsonl`.
**With Dolt:**

```sql
CREATE TABLE gate_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    gate_name VARCHAR(50) NOT NULL,
    result ENUM('pass', 'fail', 'timeout', 'stall') NOT NULL,
    exit_code INT,
    duration_ms INT,
    timestamp DATETIME NOT NULL,
    task_id VARCHAR(50),
    branch VARCHAR(100),
    details JSON
);
```

**Advantage:** `SELECT * FROM gate_runs WHERE result = 'fail' ORDER BY timestamp DESC` — instant failure archaeology. Time-travel: `SELECT * FROM gate_runs AS OF 'last-known-good-commit'`.

### 3. Session Summaries → Dolt Table

Not raw session JSON (too large, wrong granularity), but structured summaries:

```sql
CREATE TABLE session_summaries (
    task_id VARCHAR(50) PRIMARY KEY,
    mode VARCHAR(30) NOT NULL,
    model VARCHAR(50) NOT NULL,
    cost_usd DECIMAL(8,4),
    duration_seconds INT,
    tools_used JSON,
    completion_status ENUM('completed', 'failed', 'abandoned') NOT NULL,
    parent_task_id VARCHAR(50),
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    token_count INT
);
```

**Advantage:** `SELECT SUM(cost_usd) FROM session_summaries WHERE started_at > '2026-02-17'` — instant cost rollup. Parent-child correlation via `parent_task_id` foreign key.

### 4. Branch-Per-Subtask Pattern

The most architecturally significant integration:

```
Plant Manager (main branch)
  │
  ├── CALL DOLT_BRANCH('subtask-gate-check')
  │   └── Subtask writes gate results to this branch
  │       └── On success: CALL DOLT_MERGE('subtask-gate-check')
  │       └── On failure: branch abandoned (zero-cost rollback)
  │
  ├── CALL DOLT_BRANCH('subtask-refactor-module-x')
  │   └── ...
```

**This maps directly to the `new_task` tree.** Each `new_task` subtask gets a Dolt branch. The branch is the subtask's isolated workspace for state changes. Merge is the "accept result" action. Abandon is the "reject/retry" action.

**No cleanup needed for failed subtasks.** The branch just dies. No partial state to roll back.

### 5. Multi-Agent Sync

**Current:** Two-clone model with beads sync-branch workaround.
**With Dolt:**

```bash
# Windsurf clone (session start)
dolt pull origin main

# Kilo clone (session start)
dolt pull origin main

# Either clone (session end)
dolt add .
dolt commit -m "Session work complete"
dolt push origin main
```

Conflicts are row-level, not line-level. If both agents modify the same bead, Dolt knows it's a field conflict and can resolve deterministically (last-write-wins, or manual resolution).

---

## The Complete Loop (With Dolt)

The roadmap's loop was:

```
Command → Spawn → Monitor → Verify
```

With Dolt it becomes:

```
Command → Spawn → Monitor → Verify → Commit → Query
   │                                     │        │
   │         (versioned state layer)     │        │
   │                                     ▼        ▼
   │                              dolt commit  dolt diff
   │                              dolt merge   AS OF queries
   └──────────────────────────────────────────────┘
                    (feedback via SQL queries)
```

**Commit** closes the loop: verified work becomes permanent, queryable state.
**Query** enables the feedback: the plant can ask "what happened?" via SQL instead of parsing JSON files.

---

## Critical Discovery: Beads Already Has a Dolt Backend

Beads v0.49.6 ships with **first-class Dolt backend support**. This eliminates the entire migration question.

```bash
# Initialize beads with Dolt backend (instead of SQLite)
bd init --backend dolt

# Embedded mode (default): Dolt runs in-process, zero infrastructure
# Server mode: connects to dolt sql-server for multi-writer access
bd init --backend dolt --server --server-port 3307
```

**Key findings from `bd init --help`:**

| Feature | Support |
|---|---|
| `--backend dolt` | ✅ Storage backend flag |
| Embedded mode | ✅ Default, no server process needed |
| Server mode | ✅ `--server` flag, auto-detects `dolt sql-server` on 3307/3306 |
| Auto-commit | ✅ `--dolt-auto-commit on` commits after every write |
| Multi-writer | ✅ Via server mode |
| Password auth | ✅ Via `BEADS_DOLT_PASSWORD` env var |

**What this means:**

1. **Beads ergonomics stay identical.** `bd ready`, `bd show`, `bd close`, `bd sync` — all the same commands. Only the storage layer changes.
2. **No migration code needed.** Beads handles the SQLite → Dolt transition internally.
3. **The `bd` CLI IS the Dolt interface.** We don't need a separate Dolt CLI workflow for task tracking.
4. **Dolt's git primitives apply to beads data.** Branch-per-task, time-travel queries, row-level diff — all available through Dolt's native tooling on the same database that `bd` writes to.

### The Architecture Simplification

```
Before (hypothetical):
  bd CLI → SQLite ←→ JSONL ←→ git sync-branch (line-level merge)

After:
  bd CLI → Dolt DB ←→ dolt push/pull (row-level merge, branch, diff, time-travel)
```

The JSONL/git-merge-driver layer that requires `.kilocode/tools/beads_git_setup.sh` and the custom merge driver becomes unnecessary. Dolt handles merge semantics natively at the row level.

### Multi-Agent Sync With Dolt Backend

```bash
# Kilo clone (session start)
cd .beads && dolt pull origin main && cd ..
bd ready

# Work happens via normal bd commands...

# Kilo clone (session end)
cd .beads && dolt add . && dolt commit -m "Session work" && dolt push origin main && cd ..
```

Or if `bd sync` is Dolt-aware (likely), it may handle push/pull internally.

---

## Evolutionary Path

The same bridge technology pattern from [command-dialect-exploration](command-dialect-exploration.md):

| Phase | What | State Substrate | Risk |
|-------|------|----------------|------|
| 0 | This exploration | Files on disk (current) | None |
| 0.5 | Install Dolt, `bd init --backend dolt` | Dolt via native beads support | **Very low: beads handles it** |
| 1 | Validate sync, branch, diff on real beads data | Dolt primary for beads | Low: `bd` CLI unchanged |
| 2 | Gate runs + session summaries as additional Dolt tables | Dolt for all plant state | Medium: Schema design matters |
| 3 | Branch-per-subtask pattern | Full integration with task graph | Higher: Architectural change |

### Phase 0.5 Details (Minimal Viable Integration)

```bash
# Install Dolt (single binary)
sudo bash -c 'curl -L https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash'

# Re-initialize beads with Dolt backend
bd init --backend dolt --dolt-auto-commit on

# That's it. bd commands work identically.
bd ready
bd show <id>
bd close <id>
```

**Exit criteria for Phase 0.5:**
- Dolt installed
- `bd init --backend dolt` succeeds
- `bd ready`, `bd show`, `bd update`, `bd close` all work identically
- `dolt log` shows beads write history
- `dolt diff` shows row-level changes between commits

---

## Relationship to Existing Roadmap

Dolt doesn't replace any roadmap item — it provides a better **substrate** for all of them.

| Roadmap Item | Current Approach | With Dolt |
|---|---|---|
| `3wo.2` (commands.toml) | Static TOML file | TOML stays; Dolt commands added to routing matrix |
| `mon.1` (parent-child correlation) | File-based session parsing | `parent_task_id` foreign key in `session_summaries` |
| `mon.2` (cost budget) | Session data parsing | `SELECT SUM(cost_usd) FROM session_summaries WHERE ...` |
| `vfy.1` (spawn-and-verify) | Verify via session file reads | Verify via branch merge status + SQL queries |
| `aud.1` (post-workflow audit) | Parse session JSON | SQL queries over `gate_runs` + `beads` |
| `hlth.1` (plant health composite) | Multiple file reads + parsing | Single composite SQL query |

---

## Risk Registry

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Dolt adds infrastructure complexity | Medium | Single binary, no daemon required for CLI mode, zero dependencies |
| Dolt learning curve for agents | Low | MySQL-compatible SQL — something every LLM knows deeply |
| Dolt storage overhead | Low | Prolly trees have high structural sharing; plant state is small |
| Migration disrupts existing workflows | Medium | Bridge pattern: dual-write in Phase 0.5, cut over gradually |
| Dolt performance for small datasets | Non-issue | Plant state is <10k rows; any DB handles this trivially |
| Dolt is overkill for current scale | Medium | True today. Investment pays off when plant grows or more agents join. |
| Over-engineering the state layer | High | **Guard against this.** Phase 0.5 must prove value before Phase 1. |

---

## Why Dolt Over Alternatives

| Alternative | Why Not |
|---|---|
| Plain SQLite | No version control, no branch/merge, no time-travel, no remote sync |
| SQLite + git | Git sees binary changes, no row-level diff, merge is broken |
| PostgreSQL | Server process required, no version control, overkill for local plant |
| Regular files + git | Current approach. Works but no structured queries, line-level only |
| DuckDB | Analytics-focused, no version control primitives |
| Dolt | ✅ SQL + git semantics + single binary + offline-first + row-level diff + time-travel |

Dolt is the only option that provides SQL **and** version control **and** offline-first **and** single-binary deployment.

---

## Command Dialect Extensions

New commands for the routing matrix:

```toml
[commands.commit_state]
verb = "commit"
noun = "state"
skill = "plant-state"
tool = "dolt commit -am"
receipt_required = false

[commands.branch_subtask]
verb = "branch"
noun = "subtask"
skill = "plant-state"
tool = "dolt branch"
receipt_required = false

[commands.merge_subtask]
verb = "merge"
noun = "subtask"
skill = "plant-state"
tool = "dolt merge"
receipt_required = false

[commands.query_state]
verb = "query"
noun = "state"
skill = "plant-state"
tool = "dolt sql -q"
receipt_required = false

[commands.sync_state]
verb = "sync"
noun = "state"
skill = "plant-state"
tool = "dolt pull && dolt push"
receipt_required = false
```

New verbs: `commit`, `branch`, `merge`, `query` (4 additions to the 12-verb vocabulary).
New nouns: `state`, `subtask` (reused from existing vocabulary).

---

## Key Insight

The plant's architecture has been converging on a pattern: **exploit existing infrastructure instead of building new systems.** Session data replaced receipts. Self-monitoring replaced the Factory Inspector mode. Command dialect replaced verbose workflows.

Dolt continues this pattern. It doesn't add a new system — it provides a **better substrate** for the state that already exists. Beads, gate runs, session summaries, cost data — all of this already exists as files. Dolt makes it queryable, versionable, branchable, and syncable.

The five axes are now:
1. **Control** — `new_task` tree (task graph)
2. **Capability** — Modes → skills → tools (workflow graph)
3. **Instruction** — Verb+Noun → skill binding (command dialect)
4. **Observability** — Session data + self-monitoring (proof layer)
5. **State** — Dolt SQL + git semantics (memory layer)

**Command → Spawn → Monitor → Verify → Commit → Query.** That's the complete plant.

---

## References

- Dolt repository: https://github.com/dolthub/dolt
- Dolt documentation: https://docs.dolthub.com/
- Dual-graph architecture: [`dual-graph-architecture-2026-02-17.md`](dual-graph-architecture-2026-02-17.md)
- Command dialect: [`command-dialect-exploration.md`](command-dialect-exploration.md)
- Nested new_task experiment: [`nested-new-task-experiment-2026-02-15.md`](nested-new-task-experiment-2026-02-15.md)
- Plant infrastructure roadmap: [`plans/roadmap-plant-infrastructure.md`](../../plans/roadmap-plant-infrastructure.md)
