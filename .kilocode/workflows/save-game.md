# Save Game Workflow

**Purpose:** Create an explicit context checkpoint for transferring critical context between sessions

**Trigger:** User invokes `/save-game`

**When to use:**
- Before ending a complex work session
- After completing a major milestone
- When switching between different tasks/branches
- Before risky refactoring or major changes
- When you want to preserve current narrative/goal/task through-line

## Workflow Steps

### 1. Prompt for Checkpoint Name

Ask user:
```
What should I name this checkpoint? 
(Leave blank for auto-generated name: YYYY-MM-DD-HH-MM-<branch>)

Suggestions:
- pre-refactor-models
- milestone-claims-pipeline-working
- before-pr-111-review
- <custom-name>
```

### 2. Generate Context Summary (500-1000 words)

Create a comprehensive summary including:

#### Current Task/Goal
- What are you working on right now?
- What is the end goal of this work?
- What issue/PR/branch is this related to?

#### Progress Made This Session
- What was accomplished?
- What files were changed?
- What decisions were made?
- What tests were added/modified?

#### Key Decisions & Rationale
- Why did you choose this approach?
- What alternatives were considered?
- What tradeoffs were made?
- What patterns were followed?

#### Critical Context
- What files are most relevant?
- What patterns or conventions matter?
- What gotchas or edge cases exist?
- What dependencies or constraints apply?

#### Blockers or Open Questions
- What is blocking progress?
- What needs clarification?
- What assumptions need validation?
- What technical debt was created?

#### Next Steps (Prioritized)
1. Immediate next action
2. Follow-up tasks
3. Future considerations
4. Testing/validation needed

#### Environment State
- Current branch
- Uncommitted changes (if any)
- Active issues (from `.kilocode/tools/bd ready`)
- Quality gate status

### 3. Save Checkpoint

Create checkpoint file:
```bash
mkdir -p .kilocode/checkpoints
# Save to .kilocode/checkpoints/<name>.md
```

### 4. Update Memory Bank Reference

Update `.kilocode/rules/memory-bank/context.md`:
- Add checkpoint reference to "Recent Changes"
- Update "Current State" if needed
- Note checkpoint name and timestamp

### 5. Optionally Commit Checkpoint

Ask user:
```
Should I commit this checkpoint to git?
- Yes (recommended for major milestones)
- No (keep local only)
```

If yes:
```bash
git add .kilocode/checkpoints/<name>.md
git add .kilocode/rules/memory-bank/context.md
git commit -m "checkpoint: <name>"
```

### 6. Confirm Completion

Report to user:
```
✅ Checkpoint saved: <name>
📍 Location: .kilocode/checkpoints/<name>.md
📊 Size: <word-count> words
🔗 Reference added to Memory Bank

To load this checkpoint later, use: /load-game
```

## Example Checkpoint Format

```markdown
# Checkpoint: <name>

**Created:** 2026-01-21 12:52 EST
**Branch:** repomap-pxt.1
**Session Cost:** $0.13
**Agent:** Kilo Code (code mode)

## Current Task

Working on models serialization refactoring (Phase 4-5). Goal is to split
monolithic models.py into focused modules while maintaining 100% backward
compatibility.

## Progress This Session

- Created base.py with 3 base classes (RepomapBaseModel, VersionedModel, TimestampedModel)
- Updated __init__.py to re-export all 73 baseline symbols
- Added model_rebuild() calls to resolve forward references
- Verified 193 import statements work (baseline was 186)
- All quality gates passing

## Key Decisions

1. **Base class hierarchy** - Chose composition over deep inheritance
   - RepomapBaseModel: Common ConfigDict
   - VersionedModel: Schema version tracking
   - TimestampedModel: Creation/update timestamps

2. **Backward compatibility** - Explicit re-exports in __init__.py
   - Maintains all existing import paths
   - No code changes needed in consumers

## Critical Context

- **Files:** repomap/artifacts/models/base.py, __init__.py
- **Pattern:** Pydantic v2 with ConfigDict
- **Gotcha:** Forward references require model_rebuild()
- **Constraint:** Zero breaking changes allowed

## Next Steps

1. Monitor PR #111 for approval/merge
2. Continue dogfooding Kilo Code
3. Compare velocity vs. Windsurf
4. Practice cost-aware Memory Bank updates

## Environment

- Branch: repomap-pxt.1 (ahead 1, behind 1)
- Uncommitted: None (last commit ca62b8a)
- Quality gates: All passing ✅
- Active issues: Check with `.kilocode/tools/bd ready`
```

## Notes

- Checkpoints are **git-tracked** by default (unlike experimental logs)
- Checkpoints are **human-readable** markdown
- Checkpoints **complement** Memory Bank (don't replace it)
- Use checkpoints for **explicit save points**, Memory Bank for **continuous state**
