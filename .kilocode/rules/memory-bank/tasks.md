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

### Orchestrator Modes (preferred)
- **process-orchestrator** → Control-plane orchestrator for isolated specialist subtasks. Lifecycle: discover → explore → prepare → execute → gate → land.
- **audit-orchestrator** → Adversarial audit orchestrator for pressure tests. Phases: Identity Attack → Friction Audit → Surface Minimization → Leverage Hunt → Synthesis.

**When to use Orchestrator modes:**
- Complex tasks with distinct phases
- Need hard separation of concerns (isolated subtask contexts)
- Want native progress tracking via todo list
- Long-running tasks requiring resumability
- Adversarial pressure testing (audit-orchestrator)

**When to use Original workflows:**
- Straightforward tasks
- Simpler single-agent flow preferred
- Manageable context size

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
- Mode definitions: `.kilocodemodes`
