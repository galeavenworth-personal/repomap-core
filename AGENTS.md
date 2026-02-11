# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
```

## Session Start

Sync Beads state from remote before starting work:

```bash
bd sync --no-push
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Check for orphaned issues** - Run `bd doctor` to detect process failures
4. **Update issue status** - Close finished work, update in-progress items
5. **Sync Beads** - Publish task state updates:
   ```bash
   bd sync
   ```
6. **PUSH TO REMOTE** (only if explicitly requested):
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
7. **Clean up** - Clear stashes, prune remote branches
8. **Verify** - All changes committed, and pushed if explicitly requested
9. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until changes are committed, and pushed if explicitly requested
- NEVER say "ready to push when you are" - either push (when requested) or state what remains
- If push fails, resolve and retry until it succeeds

