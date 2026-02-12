# Repeatable Tasks

This file contains common workflows and command patterns for the repomap-core project.

## Workflows

See `.kilocode/workflows/` for full procedures:

### Original Workflows (Monolithic)
- `/start-task` - Task preparation with discovery, exploration, and prep
- `/execute-task` - Task execution with implementation loop
- `/save-game` - Create context checkpoint
- `/load-game` - Load previous checkpoint
- `/respond-to-pr-review` - PR review response workflow
- `/fix-ci` - Quality gate fixes
- `/refactor` - Architecture-aware refactoring
- `/claims-pipeline` - Claims generation pipeline
- `/codebase-exploration` - Systematic codebase exploration

### Orchestrator Workflows (Factory Line)
- `/orchestrate-start-task` - Task preparation with isolated subtasks
- `/orchestrate-execute-task` - Task execution with isolated subtasks
- `/orchestrate-refactor` - Refactoring with isolated subtasks

**See [ORCHESTRATOR_WORKFLOWS.md](.kilocode/workflows/ORCHESTRATOR_WORKFLOWS.md) for details on when to use which.**

## Common Commands

### Session Management
```bash
# Session start
.kilocode/tools/bd sync --no-push
.kilocode/tools/bd ready

# During work
.kilocode/tools/bd update <id> --status in_progress
.kilocode/tools/bd show <id>

# Session end
.kilocode/tools/bd close <id>
.kilocode/tools/bd sync  # Push to remote
```

### Quality Gates
```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```

## References

- Full workflows: `.kilocode/workflows/`
- Skills: `.kilocode/skills/`
- Agent instructions: `AGENTS.md`
