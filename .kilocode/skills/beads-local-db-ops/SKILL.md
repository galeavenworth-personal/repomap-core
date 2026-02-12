---
name: beads-local-db-ops
description: Use Beads (bd) with sync-branch workflow for task tracking across two-clone setup.
---

# Beads Sync-Branch Ops

## Goal

Use Beads with sync-branch model where:

- Local SQLite (`.beads/beads.db`) is a fast cache
- Remote `beads-sync` branch is the shared truth
- Two clones (Windsurf + Kilo) sync via remote rendezvous

## Two-Clone "Employees" Model

- **Windsurf employee:** `~/Projects/repomap-windsurf/`
- **Kilo employee:** `~/Projects-Employee-1/repomap-core/`
- Each clone has its own `.git/`, `.venv/`, `.beads/beads.db`
- Remote repo is the rendezvous point
- **Never assign same task to both employees concurrently**

## When to use this skill

Use this skill for:

- Session start: sync state from remote
- During work: update issue status locally
- Session end: push state to remote

## Critical Workflow

### Session Start

```bash
# Pull latest state from remote (no push)
.kilocode/tools/bd sync --no-push

# Find available work
.kilocode/tools/bd ready

# Claim an issue
.kilocode/tools/bd update <id> --status in_progress
```

### During Work

```bash
# View issue details
.kilocode/tools/bd show <id>

# Update status
.kilocode/tools/bd update <id> --status in_progress

# Add notes as you learn
.kilocode/tools/bd update <id> --notes "..."
```

### Session End

```bash
# Close completed issues
.kilocode/tools/bd close <id>

# Push state to remote
.kilocode/tools/bd sync
```

## Operational Contract

- Always run `.kilocode/tools/bd sync --no-push` at session start
- Only one clone runs daemon at a time (optional but clean)
- When switching employees, run `bd sync --no-push` before starting new work
- Never work on same issue in both clones concurrently

## Troubleshooting

- If Beads feels slow, ensure you are not in `no-db` mode
- If sync conflicts occur, remote `beads-sync` branch is authoritative
- Local DB is cache; sync operations reconcile with remote truth
