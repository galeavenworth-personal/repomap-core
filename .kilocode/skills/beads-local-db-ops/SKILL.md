---
name: beads-local-db-ops
description: Use Beads (bd) with Dolt server backend for multi-repo task tracking.
---

# Beads Dolt Server Ops

## Goal

Use Beads with Dolt server backend where:

- Shared Dolt database (via server mode on port 3307) is persistent storage
- All writes persist immediately — no sync step needed
- Multiple repos (prefixed by `issue-prefix` in config) share a single Dolt database
- JSONL files (`.beads/issues.jsonl`) are interchange format for cross-clone git sync
- `bd export` / `bd import` replace the deprecated `bd sync` commands

## Multi-Repo Model

Each repository connects to the shared Dolt server with its own prefix:

- **repomap-core**: `issue-prefix: repomap-core` (this repo)
- **oc-daemon**: `issue-prefix: daemon`
- Other repos: their own prefix, same Dolt server on port 3307
- The Dolt database at `~/.dolt-data/beads` holds all repos' issues
- `--prefix` flag on `bd create` routes issues to the correct partition

### Cross-Repo Routing (routes.jsonl)

To create beads in a different repo's prefix from the current repo, each repo
needs a `.beads/routes.jsonl` file mapping prefixes to relative paths:

**repomap-core** `.beads/routes.jsonl`:
```jsonl
{"prefix":"daemon-","path":"../oc-daemon"}
```

**oc-daemon** `.beads/routes.jsonl`:
```jsonl
{"prefix":"repomap-core-","path":"../repomap-core"}
```

**Format:** Each line is a JSON object with:
- `prefix`: the ID prefix with trailing hyphen (e.g., `"daemon-"`)
- `path`: relative path from the project root (parent of `.beads/`) to the target repo's project root

**Usage:**
```bash
# From repomap-core, create a bead in daemon's rig
.kilocode/tools/bd create "Fix classifier" -t task -p 1 --prefix daemon

# List beads in another rig
.kilocode/tools/bd list --rig daemon
```

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
- Cross-repo bead creation: use `--prefix` flag with routes.jsonl configured

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

# Create in another repo's prefix (requires routes.jsonl)
.kilocode/tools/bd create "Title" -t task -p 1 --prefix daemon
```

### Session End

```bash
# Close completed issues (persists immediately)
.kilocode/tools/bd close <id>

# Export to JSONL for cross-clone interchange (if needed)
.kilocode/tools/bd export -o .beads/issues.jsonl
```

## Git Hooks Policy

**Do NOT use `bd hooks install`.** Git hook shims resolve `bd` via PATH, which
may find the wrong version (e.g., a release binary without CGO support). This
causes hard crashes that block all git commits.

Instead, use the opencode plugin at `.opencode/plugins/beads-sync.ts` which:
- Uses the pinned `bd` wrapper at `.kilocode/tools/bd`
- Handles pre-commit export, post-merge import, pre-push validation
- Covers ~90% of agent-initiated git operations
- Degrades gracefully if `bd` is unavailable

If `bd doctor` warns about missing hooks, this is expected and safe to ignore.

**v0.55.4 note:** Beads upstream removed the `examples/git-hooks/` directory,
confirming the shift away from git hooks toward editor plugin integration.

## Deprecated Commands

The following commands exist for backward compatibility but are **no-ops** with Dolt backend:

- `bd sync` — Returns instantly. All writes persist via Dolt server immediately.
- `bd sync --no-push` — Returns instantly. Same reason.

**Replacements:**
- For JSONL interchange: `bd export` (to JSONL) and `bd import` (from JSONL)
- For Dolt remote ops: `bd dolt push` and `bd dolt pull`

## Advanced Features (available in v0.55.4+)

- `bd gate` — Async coordination gates for fanout/collect patterns
- `bd query` — Query issues using simple query language
- `bd dep` — Manage dependencies between issues
- `bd diff` — Show changes between Dolt commits/branches
- `bd history` — Show version history for an issue (Dolt feature)
- `bd mol` — Molecule commands (work templates)
- `bd formula` — Workflow formulas
- `bd slot` — Agent bead slots
- `bd compact` — Dolt compaction for closed issues (new in v0.55.4)
- `bd list --no-parent` — Filter to top-level issues only (new in v0.55.4)
- `bd list --rig <name>` — Query another rig's beads from current repo
- `bd move` / `bd refile` — Move issues between rigs
- Custom types: molecule, gate, convoy, merge-request, slot, agent, role, rig, message

## Operational Contract

- Always verify Dolt server is running at session start
- Only one clone should run the Dolt daemon at a time
- When switching employees, ensure Dolt server is accessible
- Never work on same issue in both clones concurrently
- CGO-enabled bd binary is required (build from source if release binary lacks CGO)
- Issue prefix (`repomap-core`) automatically partitions issues per repo in the shared database
- Cross-repo routing requires `routes.jsonl` in both repos

## CGO Build Note (v0.55.4)

The pinned build script at `.kilocode/tools/beads_install.sh` (local-only,
gitignored) builds from source with `CGO_ENABLED=1`, which is required for
the Dolt backend. Run it once per machine to install. The version pin is in
`.kilocode/tools/beads_version`.

## Troubleshooting

- **CGO error on init**: Binary lacks CGO — rebuild with `.kilocode/tools/beads_install.sh` (local-only, gitignored)
- **Server not listening**: Start Dolt server: `cd ~/.dolt-data/beads && dolt sql-server --port 3307 --host 127.0.0.1`
- **Database not found**: Run `bd init --server --from-jsonl` to initialize
- **Sync deprecated warnings**: Expected; `bd sync` is a no-op with Dolt. Use `bd export`/`bd import` for interchange.
- **Federation errors**: Federation requires the beads database name on the server; use `bd doctor` for diagnostics
- **Count mismatch (Dolt vs JSONL)**: Normal during migration. Run `bd export -o .beads/issues.jsonl` to re-sync JSONL.
- **Missing hooks warning**: Expected — we use the opencode plugin instead of git hooks. Safe to ignore.
- **Cross-repo create fails**: Check that `.beads/routes.jsonl` exists in the source repo with the correct prefix and relative path.
- **Nil pointer on cross-repo deps**: Ensure both repos have routes.jsonl configured bidirectionally, and the target repo's `.beads/config.yaml` has the correct `issue-prefix`.
