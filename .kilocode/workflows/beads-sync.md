# Beads Sync Workflow

Manage Beads state with Dolt server backend and JSONL interchange for cross-clone sync.

## Purpose

In the two-clone "employees" model, each clone connects to the shared Dolt server
(port 3307). All writes persist immediately — no sync step is needed for local work.
JSONL interchange (`bd export` / `bd import`) handles cross-clone state transfer via git.

## Commands Referenced

All commands below are routed through [`commands.toml`](../commands.toml):

| Route | Verb | Noun | Purpose |
|-------|------|------|---------|
| `diagnose_issues` | diagnose | issues | Check Dolt server + Beads health |
| `list_ready` | list | ready | Find available issues |
| `claim_issue` | claim | issue | Mark issue as in-progress |
| `show_issue` | show | issue | View issue details |
| `close_issue` | close | issue | Mark issue as completed |
| `export_beads` | export | beads | Export Dolt state to JSONL for git interchange |
| `import_beads` | import | beads | Import JSONL into Dolt after cross-clone sync |

## Session Start

### 1. Verify Dolt Server Health

<!-- route: diagnose_issues -->
```bash
nc -z 127.0.0.1 3307 && echo "Server OK" || echo "Start Dolt server first"
.kilocode/tools/bd_doctor_safe.sh
```

### 2. Import JSONL (if cross-clone sync needed)

Only needed after `git pull` brings new JSONL from the other clone:

<!-- route: import_beads -->
```bash
.kilocode/tools/bd import --from-jsonl .beads/issues.jsonl
```

### 3. List Available Work

<!-- route: list_ready -->
```bash
.kilocode/tools/bd ready
```

### 4. Claim an Issue

<!-- route: claim_issue -->
```bash
.kilocode/tools/bd update <id> --status in_progress
```

## Session End

### 1. Close Completed Issues

<!-- route: close_issue -->
```bash
.kilocode/tools/bd close <id>
```

### 2. Export to JSONL (for cross-clone interchange)

<!-- route: export_beads -->
```bash
.kilocode/tools/bd export -o .beads/issues.jsonl
```

Then commit and push the JSONL file via git so the other clone can import it:

```bash
git add .beads/issues.jsonl
git commit -m "beads: export JSONL for cross-clone sync"
git push
```

## Operational Contract (Two-Clone Model)

To avoid "truth fights" between Windsurf and Kilo employees:

1. **Never assign the same task/issue to both employees concurrently**
2. **Only one clone runs the Dolt daemon at a time** (optional but clean)
3. **When switching employees:** export JSONL from active clone, git push, git pull from other clone, then import JSONL

## Deprecated Commands

The following commands are no-ops with the Dolt backend and exist only for backward compatibility:

- `bd sync --no-push` → No-op. See `commands.toml: sync_remote` (deprecated).
- `bd sync` → No-op. See `commands.toml: sync_push` (deprecated).

**Replacements:** `export_beads` and `import_beads` routes in `commands.toml`.

## One-Time Setup (per machine / per clone)

Install pinned `bd` (once per machine/version):

```bash
.kilocode/tools/beads_install.sh
```

Initialize Beads for this repo (once per clone):

```bash
.kilocode/tools/bd init
```

### Configure git merge driver (once per clone)

```bash
.kilocode/tools/beads_git_setup.sh
```

## Punch Card Exit Gate

**This workflow is not complete until the following gate passes:**

<!-- route: punch_checkpoint -->
```bash
python3 .kilocode/tools/punch_engine.py checkpoint auto {card_id}
```

The punch card verifies:
- Dolt server health check was performed (`diagnose_issues`)
- JSONL export was executed if session produced state changes (`export_beads`)
- Issue status was updated (`claim_issue` / `close_issue`)

## References

- Skill: [`beads-local-db-ops`](../skills/beads-local-db-ops/SKILL.md)
- Routing: [`commands.toml`](../commands.toml)
- Agent instructions: [`AGENTS.md`](../../AGENTS.md)
