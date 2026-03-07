# Beads Task Tracking

Use the pinned `bd` version from `.kilocode/tools/beads_version` for task tracking throughout the project.

**Commands:** See beads entries in [`.kilocode/commands.toml`](../commands.toml) (`sync_remote`, `sync_push`, `claim_issue`, `close_issue`, `show_issue`, `list_ready`).

## JSONL ↔ Dolt Sync Model

Beads uses Dolt as the source of truth. The JSONL file (`.beads/issues.jsonl`) is the
git-portable representation. Sync between Dolt and JSONL happens via:

### OpenCode Plugin (agent-initiated git operations)

The plugin at `.opencode/plugins/beads-sync.ts` automatically handles:
- **Pre-commit:** `bd export` + stage JSONL before agent `git commit`
- **Post-merge:** `bd import` after agent `git pull`/`merge`/`rebase`
- **Pre-push:** Validate JSONL is current before agent `git push`
- **Session boundary:** `bd export` on `session.idle`

This covers ~90% of git operations in the agentic workflow.

### Manual git operations (the ~10% gap)

The plugin does NOT fire for manual `git commit` in a terminal, IDE git integration,
or CI/CD. For these cases:
- run `.kilocode/tools/bd import --from-jsonl .beads/issues.jsonl` after a cross-clone `git pull` brings newer JSONL and you need JSONL → Dolt refresh
- Run `bd export` manually before manual commits if JSONL needs to be current
- The merge driver (configured by `beads_git_setup.sh`) handles JSONL merge conflicts

### ⚠️ Do NOT use `bd hooks install`

Git hook shims resolve `bd` via PATH, which may find the wrong version (e.g., a release
binary without CGO support). This causes hard crashes that block all git commits.
The OpenCode plugin model eliminates this kill chain entirely by using the pinned
`bd` wrapper at `.kilocode/tools/bd`.

**v0.59.0 note:** Beads upstream continues to favor editor/plugin integration over git hooks,
and current releases keep improving fresh-clone / doctor / Dolt error handling. Missing hook
warnings remain expected in this repo because we intentionally use the plugin model.

**If `bd doctor --fix` installs hooks:** Remove them immediately:
```bash
rm .git/hooks/pre-commit .git/hooks/post-merge .git/hooks/pre-push .git/hooks/post-checkout .git/hooks/prepare-commit-msg
```

## Cross-Repo Routing

Cross-repo bead creation uses `routes.jsonl` — the beads happy path for multi-rig routing.

Each repo's `.beads/routes.jsonl` maps foreign prefixes to relative paths:

```jsonl
{"prefix":"daemon-","path":"../oc-daemon"}
```

**Create in another rig:** `bd create "Title" --prefix daemon`
**List another rig:** `bd list --rig daemon`

For setup details, see the [beads skill doc](../skills/beads-local-db-ops/SKILL.md).

## Merge Driver

Configure once per clone for JSONL merge conflict resolution:

```bash
.kilocode/tools/beads_git_setup.sh
```

## Integration

Beads is the authoritative source for task state. See [`AGENTS.md`](../../AGENTS.md) for full workflow details.
