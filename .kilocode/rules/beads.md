# Beads Task Tracking

Use 'bd' for task tracking throughout the project.

**Commands:** See beads entries in [`.kilocode/commands.toml`](../commands.toml) (`sync_remote`, `sync_push`, `claim_issue`, `close_issue`, `show_issue`, `list_ready`).

## JSONL ↔ Dolt Sync Model

Beads uses Dolt as the source of truth. The JSONL file (`.beads/issues.jsonl`) is the
git-portable representation. Sync between Dolt and JSONL happens via:

### OpenCode Plugin (agent-initiated git operations)

The plugin at `.opencode/plugins/beads-sync.ts` automatically handles:
- **Pre-commit:** `bd export` + stage JSONL before agent `git commit`
- **Post-merge:** `bd import` after agent `git pull`/`merge`/`rebase`
- **Pre-push:** Validate JSONL is current before agent `git push`
- **Session boundary:** `bd export` on `session.idle` and agent stop

This covers ~90% of git operations in the agentic workflow.

### Manual git operations (the ~10% gap)

The plugin does NOT fire for manual `git commit` in a terminal, IDE git integration,
or CI/CD. For these cases:
- `bd sync` in the landing-the-plane workflow covers session-end sync
- Run `bd export` manually before manual commits if JSONL needs to be current
- The merge driver (configured by `beads_git_setup.sh`) handles JSONL merge conflicts

### ⚠️ Do NOT use `bd hooks install`

Git hook shims resolve `bd` via PATH, which may find the wrong version (e.g., v0.49.3
without CGO support). This causes hard crashes that block all git commits.
The OpenCode plugin model eliminates this kill chain entirely by using the pinned
`bd` wrapper at `.kilocode/tools/bd`.

## Merge Driver

Configure once per clone for JSONL merge conflict resolution:

```bash
.kilocode/tools/beads_git_setup.sh
```

## Integration

Beads is the authoritative source for task state. See [`AGENTS.md`](../../AGENTS.md) for full workflow details.
