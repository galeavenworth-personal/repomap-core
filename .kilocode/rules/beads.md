# Beads Task Tracking

Use 'bd' for task tracking throughout the project.

## Quick Reference

```bash
.kilocode/tools/bd ready              # Find available work
.kilocode/tools/bd show <id>          # View issue details
.kilocode/tools/bd update <id> --status in_progress  # Claim work
.kilocode/tools/bd close <id>         # Complete work
```

## Session Start

Sync Beads state from remote before starting work:

```bash
.kilocode/tools/bd sync --no-push
```

## Session End

When you intend to publish Beads state updates to the shared sync branch:

```bash
.kilocode/tools/bd sync
```

## Integration

Beads is the authoritative source for task state. See [`AGENTS.md`](../../AGENTS.md) for full workflow details.
