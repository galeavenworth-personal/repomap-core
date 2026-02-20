---
name: beads-local-db-ops
description: Use Beads (bd) with Dolt server backend for task tracking across two-clone setup.
---

# Beads Dolt Server Ops

## Goal

Use Beads with Dolt server backend where:

- Local Dolt database (via server mode on port 3307) is persistent storage
- JSONL files (`.beads/issues.jsonl`) are interchange format for cross-clone sync
- Two clones (Windsurf + Kilo) sync via remote rendezvous
- With Dolt backend, `bd sync` is a no-op (writes persist immediately)

## Two-Clone "Employees" Model

- **Windsurf employee:** `~/Projects/repomap-windsurf/`
- **Kilo employee:** `~/Projects-Employee-1/repomap-core/`
- Each clone connects to the shared Dolt server on port 3307
- Remote repo is the rendezvous point for JSONL interchange
- **Never assign same task to both employees concurrently**

## When to use this skill

Use this skill for:

- Session start: verify Dolt server is running, check bd status
- During work: update issue status (writes persist immediately)
- Session end: export to JSONL if needed for cross-clone sync

## Dolt Server Prerequisites

The Dolt server must be running before bd commands work:

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
```

### Session End

```bash
# Close completed issues
.kilocode/tools/bd close <id>

# With Dolt backend, sync is a no-op — data persists immediately
# For cross-clone JSONL interchange, export if needed:
# .kilocode/tools/bd export --format jsonl > .beads/issues.jsonl
```

## Operational Contract

- Always verify Dolt server is running at session start
- Only one clone runs daemon at a time (optional but clean)
- When switching employees, ensure Dolt server is accessible
- Never work on same issue in both clones concurrently
- CGO-enabled bd binary is required (build from source if release binary lacks CGO)

## CGO Build Note (v0.52.0)

The v0.52.0 GitHub release binary ships with `CGO_ENABLED=0` (known upstream
bug: [#1849](https://github.com/steveyegge/beads/issues/1849)). The Dolt
backend requires CGO. Use `.kilocode/tools/beads_install.sh` which builds
from source with `CGO_ENABLED=1`.

## Troubleshooting

- **CGO error on init**: Binary lacks CGO — rebuild with `beads_install.sh`
- **Server not listening**: Start Dolt server: `cd ~/.dolt-data/beads && dolt sql-server --port 3307 --host 127.0.0.1`
- **Database not found**: Run `bd init --server --from-jsonl` to initialize
- **Sync divergence**: With Dolt, sync is a no-op; divergence warnings about uncommitted .beads/ changes are expected during migration
- **Federation errors**: Federation requires the beads database name on the server; use `bd doctor` for diagnostics
