---
name: beads-local-db-ops
description: Use Beads (bd) with Dolt server backend for multi-repo task tracking.
---

# Beads Dolt Server Ops

## Goal

Use Beads with Dolt server backend where:

- Shared Dolt database (via server mode on port 3307) is persistent storage
- All writes persist immediately — no sync step needed
- Multiple repos (prefixed by `issue_prefix` in config) share a single Dolt database
- JSONL files (`.beads/issues.jsonl`) are interchange format for cross-clone git sync
- `bd export` / `bd import` replace the deprecated `bd sync` commands

## Multi-Repo Model

Each repository connects to the shared Dolt server with its own prefix:

- **repomap-core**: `issue_prefix = repomap-core` (this repo)
- Other repos: their own prefix, same Dolt server on port 3307
- The Dolt database at `~/.dolt-data/beads` holds all repos' issues
- `--prefix` flag on `bd create` routes issues to the correct partition

## Two-Clone "Employees" Model

- **Windsurf employee:** `~/Projects/repomap-windsurf/`
- **Kilo employee:** `~/Projects-Employee-1/repomap-core/`
- Each clone connects to the shared Dolt server on port 3307
- JSONL interchange via git for cross-clone sync when needed
- **Never assign same task to both employees concurrently**

## When to use this skill

Use this skill for:

- Session start: verify Dolt server is running, check `bd status`
- During work: `bd create`, `bd update`, `bd show`, `bd close` (all persist immediately)
- Session end: `bd export` if JSONL interchange is needed for cross-clone sync
- Cross-clone sync: `bd export` → git commit JSONL → other clone `bd import`

## Dolt Server Prerequisites

The Dolt server must be running before `bd` commands work:

```bash
# Start Dolt server (one-time per boot)
cd ~/.dolt-data/beads && nohup dolt sql-server --port 3307 --host 127.0.0.1 > /tmp/dolt-beads-server.log 2>&1 &

# Verify server is listening
nc -z 127.0.0.1 3307 && echo "Server OK" || echo "Server NOT running"
```

## Critical Workflow

### Session Start

```bash
# Verify Dolt server is running
nc -z 127.0.0.1 3307 && echo "Server OK" || echo "Start Dolt server first"

# Check database health
.kilocode/tools/bd doctor

# Find available work
.kilocode/tools/bd ready

# Claim an issue
.kilocode/tools/bd update <id> --status in_progress
```

### During Work

```bash
# View issue details
.kilocode/tools/bd show <id>

# Update status (writes persist immediately — no sync needed)
.kilocode/tools/bd update <id> --status in_progress

# Add notes as you learn
.kilocode/tools/bd update <id> --notes "..."

# Create new issues
.kilocode/tools/bd create "Title" -d "Description" -p 0 -l "label1,label2"
```

### Session End

```bash
# Close completed issues (persists immediately)
.kilocode/tools/bd close <id>

# Export to JSONL for cross-clone interchange (if needed)
.kilocode/tools/bd export -o .beads/issues.jsonl
```

## Deprecated Commands

The following commands exist for backward compatibility but are **no-ops** with Dolt backend:

- `bd sync` — Returns instantly. All writes persist via Dolt server immediately.
- `bd sync --no-push` — Returns instantly. Same reason.

**Replacements:**
- For JSONL interchange: `bd export` (to JSONL) and `bd import` (from JSONL)
- For Dolt remote ops: `bd dolt push` and `bd dolt pull`

## Advanced Features (available in v0.52.0+)

- `bd gate` — Async coordination gates for fanout/collect patterns
- `bd query` — Query issues using simple query language
- `bd dep` — Manage dependencies between issues
- `bd diff` — Show changes between Dolt commits/branches
- `bd history` — Show version history for an issue (Dolt feature)
- `bd mol` — Molecule commands (work templates)
- `bd formula` — Workflow formulas
- `bd slot` — Agent bead slots
- Custom types: molecule, gate, convoy, merge-request, slot, agent, role, rig, message

## Operational Contract

- Always verify Dolt server is running at session start
- Only one clone should run the Dolt daemon at a time
- When switching employees, ensure Dolt server is accessible
- Never work on same issue in both clones concurrently
- CGO-enabled bd binary is required (build from source if release binary lacks CGO)
- Issue prefix (`repomap-core`) automatically partitions issues per repo in the shared database

## CGO Build Note (v0.52.0)

The v0.52.0 GitHub release binary ships with `CGO_ENABLED=0` (known upstream
bug: [#1849](https://github.com/steveyegge/beads/issues/1849)). The Dolt
backend requires CGO. Use `.kilocode/tools/beads_install.sh` which builds
from source with `CGO_ENABLED=1`.

## Troubleshooting

- **CGO error on init**: Binary lacks CGO — rebuild with `beads_install.sh`
- **Server not listening**: Start Dolt server: `cd ~/.dolt-data/beads && dolt sql-server --port 3307 --host 127.0.0.1`
- **Database not found**: Run `bd init --server --from-jsonl` to initialize
- **Sync deprecated warnings**: Expected; `bd sync` is a no-op with Dolt. Use `bd export`/`bd import` for interchange.
- **Federation errors**: Federation requires the beads database name on the server; use `bd doctor` for diagnostics
- **Count mismatch (Dolt vs JSONL)**: Normal during migration. Run `bd export -o .beads/issues.jsonl` to re-sync JSONL.
