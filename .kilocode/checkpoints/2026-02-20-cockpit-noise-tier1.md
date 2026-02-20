# Checkpoint: cockpit-noise-tier1

**Created:** 2026-02-20 17:00 EST
**Branch:** erganomics-retro
**Session Cost:** $4.56
**Agent:** Kilo Code (plant-manager mode, claude-opus-4.6)

## Current Task

Cockpit ergonomics retrospective — reducing token noise in the system prompt by identifying and removing dead/out-of-scope/broken items from the plant infrastructure (modes, skills, rules).

## Progress This Session

### Cockpit Analysis
- Built complete inventory of all cockpit items: 17 modes, 7 skills, 13 inline rules, 35+ tools
- Cross-referenced every item against plant roadmap (`plans/roadmap-plant-infrastructure.md`) and sprint plan (`plans/plant-sprint-plan.md`)
- Categorized items into 3 tiers by removal confidence and token impact

### Tier 1 Removals (Committed: `d1bfef6`)
- **`spike-orchestrator` mode** — Proven experiment (`new_task` works from custom modes), now pure noise
- **`claims-ops` mode** — Explicitly out-of-scope for repomap-core
- **`repomap-claims-ops` skill** — Self-documented as experimental/out-of-scope
- **`gpt-mode.md` rule** — Generic filler ("pick the right mode"), adds nothing
- **`context-limit.md` rule** — Broken template tokens (`<|context_window|>`) that never resolved

**Impact:** ~1,700 tokens/turn removed, 200 lines deleted across 4 files

### Cockpit Description (Meta)
- Produced a detailed "cockpit view" describing what the model actually sees each turn
- Documented ergonomic pain points for future tuning (rule density, skill check overhead, MCP namespace verbosity)

## Key Decisions

1. **Three-tier system** for cockpit changes: Tier 1 (clear removals) → Tier 2 (consolidation) → Tier 3 (compression). Prevents rash wholesale deletion.
2. **claims-ops removed entirely** — not just the skill but the mode too. Both are dead weight in repomap-core.
3. **context-limit.md removed rather than fixed** — the template tokens were never going to resolve in Kilo Code's architecture.

## Critical Context

- `.kilocodemodes` went from 39,793 chars → 36,895 chars (7.3% reduction)
- YAML validation passed after removals
- Pre-existing uncommitted changes (`.gitignore`, `beads.md`, `beads_git_setup.sh`) were left untouched — they predate this session

## Blockers / Open Items

No blockers. Tier 2 and Tier 3 remain as future work:

### Tier 2: Consolidation Candidates (~3,000 tokens/turn savings)
- `capabilities.md` — heavy overlap with MODES + AVAILABLE_SKILLS system sections
- `tasks.md` — 80% overlap with capabilities.md
- `beads.md` — beads protocol described in 4 places
- `quality-gate-ownership.md` — philosophy doc that could be 3 sentences

### Tier 3: Compression Candidates (~1,500 tokens/turn savings)
- `general-workflow.md` — extract examples to reference doc
- `sonarqube-mcp-instructions.md` — fold into sonarqube-ops skill
- `code` mode still references claims/LangChain/OPENROUTER_API_KEY

## Next Steps

1. Decide whether to proceed with Tier 2 consolidation this session or defer
2. The `code` mode `customInstructions` should be updated to remove claims references (Tier 3 item #12)
3. Remaining unstaged changes (`.gitignore`, `beads.md`, `beads_git_setup.sh`, `.opencode/`) need separate attention

## Environment

- Branch: `erganomics-retro` (ahead of main by 1 commit)
- Last commit: `d1bfef6 chore(plant): remove tier-1 cockpit noise`
- Uncommitted: `.gitignore`, `beads.md`, `beads_git_setup.sh` (preexisting), `.opencode/` (untracked)
- Quality gates: Not run (plant-only changes, no `src/` impact)
- Active beads: 10 ready issues (see `bd ready`)
