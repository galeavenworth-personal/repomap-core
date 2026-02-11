# Kilo Code Sequential Thinking Migration

This directory contains updated Kilo Code configuration files for the arben-adm sequential thinking migration.

## What Changed

**Updated Files:**
- `rules/general-workflow.md` - New tool names (`process_thought`, `generate_summary`, `export_session`, `import_session`) with stage-based workflow
- `skills/sequential-thinking-default/SKILL.md` - Stage progression guidance and epistemic metadata
- `workflows/prep-task.md` - All sequential thinking → `process_thought` with stage hints and branch-first protocol
- `workflows/respond-to-pr-review.md` - Updated decision-making pattern to include `generate_summary`
- `workflows/refactor.md` - Stage guidance for refactoring decisions

**Unchanged Files:**
- All other rules, skills, workflows, and hooks remain identical

## Configuration Already Applied

**Note:** If you're pulling this branch, the Kilo Code configuration files in `.kilocode/` are already updated. No file copying is needed - the changes are in place.

## MCP Server Installation

**Required:** Install the arben-adm sequential thinking server

### Step 1: Install the Server

The server has been installed in this project's virtual environment:

```bash
# Clone the repository to a temporary location
cd /tmp
git clone https://github.com/arben-adm/mcp-sequential-thinking.git
cd mcp-sequential-thinking

# SECURITY: Pin to a specific commit for reproducibility
# Check the latest stable commit at: https://github.com/arben-adm/mcp-sequential-thinking/commits/main
git checkout <commit-hash>  # e.g., git checkout abc123def456

# Install in editable mode (adjust path to your project's venv)
.venv/bin/pip install -e .

# Install missing dependency
.venv/bin/pip install portalocker
```

**Security Note:** Always pin to a specific commit hash rather than using the default branch. This prevents automatic execution of potentially malicious updates. Verify the commit hash matches a known good state before installation.

**Note:** This has already been done for this clone. If you're setting up a different clone, run these commands from your project root directory so `.venv/bin/pip` resolves correctly.

### Step 2: Verify Installation

```bash
.venv/bin/mcp-sequential-thinking --version
# Should output: Starting Sequential Thinking MCP server
```

### Step 3: Update MCP Configuration

The MCP configuration for Kilo Code is managed through VSCode settings. You need to update the sequential thinking server configuration.

**Location:** VSCode settings (either workspace or user settings)

**Old configuration:**
```json
{
  "sequentialthinking": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
  }
}
```

**New configuration:**
```json
{
  "sequentialthinking": {
    "command": "${workspaceFolder}/.venv/bin/mcp-sequential-thinking",
    "type": "stdio"
  }
}
```

**Note:** `${workspaceFolder}` will automatically resolve to your project root. Alternatively, use an absolute path to your project's `.venv/bin/mcp-sequential-thinking`.

## Verification

After applying changes and restarting VSCode/Kilo Code:

1. Check MCP server loads: Look for sequential thinking server in Kilo's MCP panel
2. Test thought processing: Try using `process_thought` with a stage parameter
3. Test summary retrieval: Use `generate_summary` after processing thoughts
4. Verify storage: Check `~/.mcp_sequential_thinking/current_session.json` is created
5. Test session management: Try `export_session` and `import_session`

## Key Differences from Old System

| Feature | Old (Anthropic) | New (arben-adm) |
|---------|-----------------|-----------------|
| **Tool name** | `sequentialthinking` | `process_thought` |
| **Stages** | Free-form string | Enum-validated: Problem Definition, Research, Analysis, Synthesis, Conclusion |
| **Retrieval** | ❌ None | ✅ `generate_summary` returns full session overview |
| **Metadata** | Basic | Rich: `tags`, `axioms_used`, `assumptions_challenged` |
| **Storage** | In-memory only | Persistent to `~/.mcp_sequential_thinking/` |
| **Related thoughts** | ❌ None | ✅ Automatic discovery by stage/tags |
| **Session management** | ❌ None | ✅ `export_session` and `import_session` for multi-session work |

## New Capabilities

### 1. Stage-Based Reasoning
The new system enforces a structured progression through reasoning stages:
- **Problem Definition** - Clarify what you're solving
- **Research** - Gather necessary information
- **Analysis** - Evaluate options and approaches
- **Synthesis** - Compare and integrate findings
- **Conclusion** - Make final decision with rationale

### 2. Epistemic Metadata
Track the foundations of your reasoning:
- **tags** - Categorize thoughts for later retrieval
- **axioms_used** - Document principles applied
- **assumptions_challenged** - Track what you're questioning

### 3. Session Management
Preserve reasoning across work sessions:
- **export_session** - Save your thinking to a file
- **import_session** - Resume from a previous session
- **generate_summary** - Review your reasoning before deciding

### 4. Branch Budget Protocol
Mandatory exploration before implementation:
- Minimum 2 branches for non-trivial tasks
- Unspent budget = insufficient exploration
- Hard gate: Can't edit code until Conclusion stage reached

## Migration Guide for Existing Workflows

### Before (Old System)
```python
sequentialthinking(
    thought="Considering approach A vs approach B",
    thoughtNumber=1,
    totalThoughts=2,
    nextThoughtNeeded=True
)
```

### After (New System)
```python
# Branch A
process_thought(
    thought="Approach A: Extract to module. Pros: clean. Cons: migration cost.",
    thought_number=1,
    total_thoughts=4,
    next_thought_needed=True,
    stage="Analysis",
    tags=["refactoring", "approach-a"]
)

# Branch B
process_thought(
    thought="Approach B: Inline refactor. Pros: no migration. Cons: coupling.",
    thought_number=2,
    total_thoughts=4,
    next_thought_needed=True,
    stage="Analysis",
    tags=["refactoring", "approach-b"]
)

# Verify exploration
generate_summary()

# Decision
process_thought(
    thought="Choosing A: separation worth migration cost.",
    thought_number=3,
    total_thoughts=3,
    next_thought_needed=False,
    stage="Conclusion",
    axioms_used=["Favor explicit over implicit"]
)

# Save for future
export_session(file_path=".kilocode/thinking/refactor-2026-01-21.json")
```

## Rollback

If you need to revert:

```bash
# Restore from git
git checkout HEAD~1 .kilocode/

# Or restore specific files
git checkout HEAD~1 .kilocode/rules/general-workflow.md
git checkout HEAD~1 .kilocode/skills/sequential-thinking-default/SKILL.md
git checkout HEAD~1 .kilocode/workflows/prep-task.md
git checkout HEAD~1 .kilocode/workflows/respond-to-pr-review.md
git checkout HEAD~1 .kilocode/workflows/refactor.md
```

Then update MCP config back to original npx command.

## Notes

- The arben-adm server is installed in `.venv/bin/mcp-sequential-thinking` (already done for this clone)
- Thought sessions auto-save to `~/.mcp_sequential_thinking/current_session.json`
- Exported sessions can be saved anywhere (recommended: `.kilocode/thinking/`)
- This migration is Kilo-only; Windsurf has its own separate configuration
- The server requires `portalocker` dependency (already installed)

## Support

For issues or questions:
1. Check that the MCP server is properly installed: `.venv/bin/mcp-sequential-thinking --version`
2. Verify VSCode MCP settings are correct
3. Check MCP server logs in VSCode output panel
4. Review the updated workflow files for examples

## References

- Windsurf migration: `.windsurf/README_MIGRATION.md`
- arben-adm fork: https://github.com/arben-adm/mcp-sequential-thinking
- Original Anthropic server: https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking
