# Beads Sync Workflow

Sync Beads state with remote before/after work session.

## Purpose

In the two-clone "employees" model, each clone (Windsurf employee, Kilo employee) maintains its own local Beads database (`.beads/beads.db`). The remote `beads-sync` branch is the shared truth.

This workflow ensures you pull the latest state before starting work and can push your changes when done.

## Session Start: Pull Latest State

### 1. Sync from Remote (No Push)

Pull latest Beads state from remote without pushing local changes:

```bash
.kilocode/tools/bd sync --no-push
```

### 2. Check Sync Status

Verify sync status and see if there are uncommitted changes:

```bash
.kilocode/tools/bd sync --status
```

### 3. List Available Work

Show issues ready to be worked on:

```bash
.kilocode/tools/bd ready
```

## Session End: Push Changes

### 1. Sync to Remote (With Push)

Push local Beads changes to remote:

```bash
.kilocode/tools/bd sync
```

### 2. Verify Sync

Confirm changes were pushed successfully:

```bash
.kilocode/tools/bd sync --status
```

## Operational Contract (Two-Clone Model)

To avoid "truth fights" between Windsurf and Kilo employees:

1. **Never assign the same task/issue to both employees concurrently**
2. **Only one clone runs the daemon at a time** (optional but clean)
3. **When switching employees, run `bd sync --no-push` before starting new work**

## Daemon Management (Optional)

Run Beads daemon with auto-commit but not auto-push:

```bash
.kilocode/tools/bd daemon start --auto-commit
```

Check daemon status:

```bash
.kilocode/tools/bd daemon status
```

Stop daemon:

```bash
.kilocode/tools/bd daemon stop
```

## One-time install + init (per machine / per clone)

This repo uses a pinned Beads CLI version installed into a user-local, versioned prefix.

Install pinned `bd` (once per machine/version):

```bash
.kilocode/tools/beads_install.sh
```

Initialize Beads for this repo (once per clone):

```bash
.kilocode/tools/bd init
```

## References

- Skill: [`beads-local-db-ops`](../skills/beads-local-db-ops/SKILL.md)
- Agent instructions: [`AGENTS.md`](../../AGENTS.md)
- Setup notes: [`docs/KILO_CODE_VSCODE_SETUP_NOTES.md`](../../docs/KILO_CODE_VSCODE_SETUP_NOTES.md)
