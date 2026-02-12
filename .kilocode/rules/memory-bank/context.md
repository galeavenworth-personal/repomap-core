# Current Context

**Purpose:** Lightweight pointers to current session state


**Last update:** 2026-02-10 - repomap-core line-health migration: canonical local quality gates established (ruff/mypy/pytest), bounded gate runner added under `.kilocode/tools/`, and workflow/docs drift reduced toward core-only `src/` layout.

## Active Checkpoint

**Current work:** Use `/load-game` to see available checkpoints
**Session history:** See `.kilocode/checkpoints/` directory

## Sequential Thinking Sessions

**Current prep session:** None (use `/start-task <id>` to create)
**Current execution session:** None (use `/execute-task <id>` to create)

**Usage:**
- Load prep session: `mcp--sequentialthinking--import_session(file_path=".kilocode/thinking/task-{id}-prep-{date}.json")`
- Review decisions: `mcp--sequentialthinking--generate_summary()`
- Continue reasoning: `mcp--sequentialthinking--process_thought(...)`

**DO NOT copy thinking contents into memory banks - use pointers only.**

**Session directory:** `.kilocode/thinking/` (created by workflows)

## Quick Status Commands

```bash
# Current state
git branch --show-current  # Active branch
git status                 # Uncommitted changes
.kilocode/tools/bd ready                   # Available issues
.kilocode/tools/bd show <id>               # Issue details

# Quality gates
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```

## Environment

- **Clone:** `~/Projects-Employee-1/repomap-core/` (Kilo employee)
- **Virtual environment:** `.venv/` (Python 3.11+)
- **Artifacts:** `.repomap/` directory

## References

- **Checkpoints:** `.kilocode/checkpoints/` (session history)
- **Plans:** `plans/`, `docs/` (strategic context)
- **Issues:** `bd show <id>` (task details)
- **PRs:** `gh pr view` (code review context)
- **Config:** `pyproject.toml`, `repomap.toml` (tech stack)
