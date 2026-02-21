# Checkpoint: legacy-cockpit-upgrade

**Created:** 2026-02-20 17:11 EST
**Branch:** erganomics-retro
**Session Cost:** ~$4.25
**Agent:** Kilo Code (plant-manager mode, claude-opus-4.6)

## Current Task

Cockpit ergonomics retrospective — Tier 2 "legacy system uninstall" completing the migration to `commands.toml` as the single authoritative routing matrix.

## Progress This Session

### Loaded Checkpoint
- Resumed from `2026-02-20-cockpit-noise-tier1` (Tier 1 complete)

### Dependency Analysis
- Reviewed `commands.toml` (4f0.7, CLOSED), sprint plan, and all Tier 2/3 candidates
- Identified that `capabilities.md` and `tasks.md` are legacy predecessors superseded by `commands.toml`
- Identified `beads.md` as KEEP (unique operational warnings) with trimmable Quick Reference
- Identified `quality-gate-ownership.md` as compressible philosophy doc
- Identified `sonarqube-mcp-instructions.md` as foldable into sonarqube-ops skill

### Tier 2 Removals (Committed: `355b51e`)
- **`capabilities.md`** — gutted from 87→16 lines, now pointer to `commands.toml`
- **`tasks.md`** — deleted entirely (100% duplicate)
- **`quality-gate-ownership.md`** — compressed from 55→6 lines
- **`beads.md`** — Quick Reference replaced with `commands.toml` pointer
- **`sonarqube-mcp-instructions.md`** — deleted, content folded into `sonarqube-ops/SKILL.md`
- **`sonarqube-ops/SKILL.md`** — fixed stale `mcp3_*` tool names to `mcp--sonarqube--*`
- **`code` mode** — removed claims/LangChain/OPENROUTER_API_KEY references from roleDefinition, whenToUse, customInstructions

**Impact:** 265 lines deleted, 58 added. ~2,400 tokens/turn saved.

## Key Decisions

1. **`commands.toml` is the single routing authority** — all prose duplicates (capabilities.md, tasks.md) are now retired or reduced to pointers
2. **`beads.md` kept** — operational warnings (kill-chain, sync model) have no equivalent in `commands.toml`
3. **`sonarqube-mcp-instructions.md` folded into skill** — only loads when SonarQube work is active, not every turn
4. **`code` mode cleaned** — claims pipeline is out of scope for repomap-core; references were orphaned after Tier 1

## Critical Context

- `.kilocodemodes` validates as YAML with 15 modes (down from 17 after Tier 1)
- Cumulative savings: Tier 1 (~1,700 tokens/turn) + Tier 2 (~2,400 tokens/turn) = ~4,100 tokens/turn
- Pre-existing uncommitted changes (`.gitignore`, `beads_git_setup.sh`) remain untouched

## Blockers / Open Items

No blockers. Tier 3 remains as future work:

### Tier 3: Compression Candidates (~1,500 tokens/turn savings)
- `general-workflow.md` — extract examples to reference doc (active protocol, low priority)
- `code` mode `customInstructions` — could reference `commands.toml` for quality gates instead of inline commands

## Next Steps

1. Decide whether to proceed with Tier 3 compression or defer
2. Remaining unstaged changes (`.gitignore`, `beads_git_setup.sh`) need separate attention
3. Consider PR for `erganomics-retro` branch (now 4 commits ahead of main)

## Environment

- Branch: `erganomics-retro` (4 commits ahead of main)
- Last commit: `355b51e chore(plant): tier-2 cockpit noise — uninstall legacy routing predecessors`
- Uncommitted: `.gitignore`, `beads_git_setup.sh` (preexisting), `.opencode/` (untracked)
- Quality gates: Not run (plant-only changes, no `src/` impact)
- Active beads: 10 ready issues (all product-code tasks)
