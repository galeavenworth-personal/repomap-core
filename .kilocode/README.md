# Kilo Code Configuration

This directory contains Kilo Code configuration for **repomap-core**.

## Structure

```
.kilocode/
├── mcp.json              # MCP server configuration
├── rules/                # Project-specific rules
│   └── memory-bank/      # Memory Bank files (persistent context)
├── workflows/            # Executable workflows (/workflow.md triggers)
├── skills/               # Project-specific skills
└── checkpoints/          # Explicit context save points (/save-game, /load-game)
```

## Phase 0: Security & Scaffolding ✅

**Completed:**
- ✅ Fixed SonarQube token exposure (now uses `${SONARQUBE_TOKEN}` env var)
- ✅ Created directory structure
- ✅ Created `.kilocodeignore` (aligned with `.gitignore`)

**Environment Variables (default local quality gates):**

- **None required.** The default gates for this repo are intended to run offline without secrets.

**Optional (tooling / integrations):**

- `SONARQUBE_TOKEN` - SonarQube authentication token (only if using SonarQube MCP tooling)
- `OPENROUTER_API_KEY` - Experimental / out-of-scope for repomap-core (claims extension behavior)

## Next Steps

### Phase 1: Rules Migration (1-2 hours)
Copy Windsurf rules from `.windsurf/rules/` to `.kilocode/rules/`:
- `beads.md`
- `general-workflow.md`
- `context-limit.md`
- `sonarqube-mcp-instructions.md`
- `virtual-environment-mandate.md` (fix typo from Windsurf)

Remove Windsurf-specific frontmatter (`trigger: always_on`).

### Phase 2: Skills Migration (2-3 hours)
Copy Windsurf skills from `.windsurf/skills/` to `.kilocode/skills/`:
- Ensure `name:` field matches directory name (Kilo requirement)
- All 7 skills: `beads-local-db-ops`, `context7-docs-ops`, `github-cli-code-review`, `repomap-claims-ops`, `repomap-codebase-retrieval`, `sequential-thinking-default`, `sonarqube-ops`

### Phase 3: Workflows Migration (1-2 hours)
Copy Windsurf workflows from `.windsurf/workflows/` to `.kilocode/workflows/`:
- All 7 workflows: `respond-to-pr-review.md`, `codebase-exploration.md`, `dogfood-context-provider.md`, `execute-task.md`, `fix-ci.md`, `prep-task.md`, `refactor.md`
- Add new workflows:
  - `/claims-pipeline.md` - Experimental: claims pipeline (extension behavior; not part of repomap-core)
  - `/beads-sync.md` - Session start/end sync

### Phase 4: Custom Modes (2-3 hours)
Create `.kilocodemodes` in project root with:
- `fabricate-code` mode (full tool access, venv-only, Beads-aware)
- `pr-review` mode (read + command + browser, markdown-only edits)
- `claims-ops` mode (claims pipeline specialist)
- `architect` mode (planning, markdown-only, no code edits)

### Phase 5: Memory Bank Bootstrap (2-4 hours)
Run `initialize memory bank` in Kilo, then manually harden:
- `brief.md` - Software fabrication philosophy, hard rules
- `tech.md` - Venv-only, `.repomap/` artifacts, layered architecture (claims/LLM notes are experimental)
- `architecture.md` - Import from `repomap.toml` layers
- `tasks.md` - Repeatable workflows (fix CI, claims pipeline, code review, Beads sync)
- `context.md` - Current state (let Kilo manage)

### Phase 6: Auto-Approval Tuning (1 hour)
Configure auto-approval settings:
- ✅ Auto-approve: read-only operations
- ✅ Auto-approve: todo updates
- ✅ Commands allowlist: `git`, `.venv/bin/python`, `bd`, `pytest`, `ruff`, `mypy`, `gh`
- ❌ No auto-approve: write outside workspace, delete, wildcard commands

Beads note: prefer `.kilocode/tools/bd ...` so the repo can pin a `bd` version without affecting other projects.

### Phase 7: Dogfooding & Iteration (Ongoing)
- Use Kilo for 1 week on repomap tasks
- Track friction points
- Refine modes, workflows, Memory Bank
- Compare velocity vs. Windsurf
- Document learnings

## Context Management

### Memory Bank (Continuous State)
Located in [`rules/memory-bank/`](rules/memory-bank/):
- **`context.md`** - Current session state, recent changes, next steps
- **`brief.md`** - Project mission, philosophy, hard rules
- **`architecture.md`** - System design, layer definitions
- **`tech.md`** - Stack, dependencies, command patterns
- **`tasks.md`** - Repeatable workflows and procedures

Memory Bank is **automatically loaded** based on task relevance and updated when session cost exceeds $0.50.

### Checkpoints (Explicit Save Points)
Located in [`checkpoints/`](checkpoints/):
- **Purpose:** Explicit context snapshots for session transfer (like video game saves)
- **Format:** 500-1000 word narrative summaries
- **Usage:** `/save-game` to create, `/load-game` to restore
- **Git-tracked:** Yes (preserves history)

**Key difference:**
- **Memory Bank** = Auto-save (continuous, incremental)
- **Checkpoints** = Save game slots (explicit, named, portable)

See:
- [`workflows/save-game.md`](workflows/save-game.md) - Create checkpoint workflow
- [`workflows/load-game.md`](workflows/load-game.md) - Load checkpoint workflow
- [`checkpoints/README.md`](checkpoints/README.md) - Checkpoint system documentation

## MCP Servers Configured

1. **context7** - Up-to-date library documentation
2. **augment-context-engine** - Semantic codebase search (auto-allowed)
3. **sequentialthinking** - Structured reasoning for complex problems
4. **sonarqube** - Code quality metrics and issue tracking

## References

- Full assessment: [`plans/kilo_code_assessment_and_roadmap.md`](../plans/kilo_code_assessment_and_roadmap.md)
- Setup notes: [`docs/KILO_CODE_VSCODE_SETUP_NOTES.md`](../docs/KILO_CODE_VSCODE_SETUP_NOTES.md)
- Windsurf artifacts: `.windsurf/` (ready for migration)
