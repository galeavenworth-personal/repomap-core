# Checkpoints Directory

This directory stores explicit context checkpoints created via the `/save-game` workflow.

## Purpose

Checkpoints are **explicit save points** for transferring critical context between sessions, similar to save games in video games. They complement the Memory Bank by providing:

- **Named snapshots** of work state at specific moments
- **Full narrative context** (500-1000 words) for session transfer
- **Portable context** that can be shared between agents/sessions
- **Immutable history** of project evolution

## Usage

### Create a Checkpoint
```
User: /save-game
Agent: [prompts for name, generates summary, saves checkpoint]
```

### Load a Checkpoint
```
User: /load-game
Agent: [lists available checkpoints, user selects, loads context]
```

## Checkpoint Format

Each checkpoint is a markdown file with:

```markdown
# Checkpoint: <name>

**Created:** <timestamp>
**Branch:** <branch-name>
**Session Cost:** $X.XX
**Agent:** <agent-name> (<mode>)

## Current Task
<what-you're-working-on>

## Progress This Session
<what-was-accomplished>

## Key Decisions
<why-you-chose-this-approach>

## Critical Context
<files-patterns-gotchas>

## Next Steps
1. <immediate-next-action>
2. <follow-up-tasks>

## Environment
<branch-issues-quality-gates>
```

## Naming Conventions

- **Descriptive:** `pre-refactor-models`, `milestone-claims-pipeline`
- **Auto-generated:** `2026-01-21-12-52-repomap-pxt.1`
- **Milestone-based:** `v1.0-release-ready`, `phase-4-complete`
- **Feature-based:** `feature-claims-working`, `bugfix-serialization`

## Best Practices

1. **Create checkpoints liberally** - Storage is cheap, context loss is expensive
2. **Use descriptive names** - Future you will thank present you
3. **Commit to git** - Preserve checkpoint history
4. **Don't edit checkpoints** - Create new ones instead (immutable)
5. **Reference in Memory Bank** - Link checkpoints in `context.md`

## Relationship to Memory Bank

| Feature | Checkpoint | Memory Bank |
|---------|-----------|-------------|
| **Purpose** | Explicit save points | Continuous state |
| **Frequency** | User-triggered | Auto-updated |
| **Scope** | Full context snapshot | Incremental updates |
| **Format** | 500-1000 word narrative | Structured sections |
| **Git tracking** | Yes (by default) | Yes |
| **Use case** | Session transfer | Within-session memory |

**Think of it like:**
- **Checkpoints** = Save game slots (explicit, named, portable)
- **Memory Bank** = Auto-save (continuous, incremental, contextual)

## Examples

### Good Checkpoint Moments

- ✅ Before ending a work session
- ✅ After completing a major milestone
- ✅ Before risky refactoring
- ✅ When switching between tasks
- ✅ After resolving a complex bug
- ✅ Before/after PR review

### Poor Checkpoint Moments

- ❌ Every 5 minutes (too frequent)
- ❌ In the middle of broken code
- ❌ Before understanding the problem
- ❌ When nothing has changed

## Maintenance

Checkpoints are **git-tracked** and **immutable**. To clean up old checkpoints:

```bash
# Archive old checkpoints (don't delete)
mkdir -p .kilocode/checkpoints/archive/2026-01
mv .kilocode/checkpoints/old-checkpoint.md .kilocode/checkpoints/archive/2026-01/

# Or use git history to recover
git log -- .kilocode/checkpoints/
```

## See Also

- [`/save-game` workflow](../workflows/save-game.md)
- [`/load-game` workflow](../workflows/load-game.md)
- [Memory Bank](../rules/memory-bank/)
- [Context management rules](../rules/memory-bank/context.md)
