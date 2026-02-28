# Load Game Workflow

**Purpose:** Explicitly load context from a previous checkpoint to resume work

**Trigger:** User invokes `/load-game`

**When to use:**
- Starting a new session on a paused task
- Switching between parallel work streams
- Recovering from context loss
- Onboarding another agent/session
- Resuming after interruption

## Commands Referenced

All commands below are routed through [`commands.toml`](../commands.toml):

| Route | Verb | Noun | Purpose |
|-------|------|------|---------|
| `list_ready` | list | ready | Find available issues |
| `show_issue` | show | issue | View issue details |
| `format_ruff` | format | ruff | Quality gate: formatting |
| `check_ruff` | check | ruff | Quality gate: linting |
| `check_mypy` | check | mypy | Quality gate: type checking |
| `import_beads` | import | beads | Import JSONL after cross-clone sync |
| `punch_checkpoint` | checkpoint | punch-card | Exit gate |

## Workflow Steps

### 1. List Available Checkpoints

Scan for checkpoints:
```bash
ls -lt .kilocode/checkpoints/*.md
```

Display to user:
```
Available checkpoints:

1. pre-refactor-models (2026-01-20 15:30) - 847 words
2. milestone-determinism-gates-green (2026-01-19 10:15) - 923 words
3. before-pr-111-review (2026-01-18 14:45) - 756 words
4. [latest] - Most recent checkpoint

Which checkpoint would you like to load?
(Enter number, name, or 'latest')
```

### 2. User Selects Checkpoint

Prompt user:
```
Select checkpoint to load:
- 1-N (by number)
- <name> (by name)
- latest (most recent)
- cancel (abort)
```

### 3. Load Checkpoint Content

Read selected checkpoint file:
```bash
cat .kilocode/checkpoints/<name>.md
```

Parse checkpoint sections:
- Current Task/Goal
- Progress Made
- Key Decisions
- Critical Context
- Next Steps
- Environment State

### 4. Compare with Current State

Check for differences:
- Current branch vs checkpoint branch
- Current Memory Bank vs checkpoint state
- Uncommitted changes
- Time elapsed since checkpoint

Display comparison:
```
📍 Loading checkpoint: <name>
📅 Created: <timestamp> (<X> days ago)
🌿 Branch: <checkpoint-branch> (current: <current-branch>)
⚠️  Differences detected:
   - Memory Bank updated <N> times since checkpoint
   - <N> commits on current branch since checkpoint
   - <N> uncommitted changes in workspace

How should I proceed?
1. Load checkpoint only (ignore current state)
2. Merge checkpoint with current Memory Bank
3. Show full diff first
4. Cancel
```

### 5. Apply Checkpoint Context

Based on user choice:

#### Option 1: Load Only
- Replace current context with checkpoint
- Ignore current Memory Bank state
- Use for "hard reset" scenarios

#### Option 2: Merge (Recommended)
- Load checkpoint as primary context
- Preserve relevant current Memory Bank updates
- Merge "Next Steps" from both
- Highlight conflicts for user review

#### Option 3: Show Diff
- Display side-by-side comparison
- Let user decide what to keep
- Then proceed with Option 1 or 2

### 6. Update Memory Bank

Update `.kilocode/rules/memory-bank/context.md`:
```markdown
## Current State

**Loaded from checkpoint:** <name> (created <timestamp>)
**Checkpoint summary:** <brief-summary>

<checkpoint-content-merged-here>

## Changes Since Checkpoint

- <list-of-changes-if-merged>
```

### 7. Verify Environment Alignment

Check if environment matches checkpoint:
```bash
# Branch alignment
git branch --show-current

# Uncommitted changes
git status --short

# Active issues  <!-- route: list_ready -->
.kilocode/tools/bd ready

# Quality gates  <!-- route: format_ruff, check_ruff, check_mypy -->
.venv/bin/python -m ruff format --check . --quiet
.venv/bin/python -m ruff check . --quiet
.venv/bin/python -m mypy src --quiet
```

Report misalignments:
```
⚠️  Environment differences:
- Checkpoint branch: repomap-pxt.1
- Current branch: main
- Recommendation: git checkout repomap-pxt.1

Continue anyway? (y/n)
```

### 8. Confirm Loaded Context

Summarize what was loaded:
```
✅ Checkpoint loaded: <name>

📋 Task: <current-task-summary>
🎯 Goal: <end-goal>
📍 Progress: <progress-summary>
🔜 Next Steps:
   1. <next-step-1>
   2. <next-step-2>
   3. <next-step-3>

🔗 Critical Files:
   - <file-1>
   - <file-2>

⚠️  Blockers:
   - <blocker-1>

Ready to continue? I'll start with: <next-step-1>
```

### 9. Optional: Sync with Beads

If checkpoint mentions active issues and a cross-clone git pull brought new JSONL:

<!-- route: import_beads, show_issue -->
```bash
.kilocode/tools/bd import --from-jsonl .beads/issues.jsonl
.kilocode/tools/bd show <issue-id>
```

Confirm issue status matches checkpoint expectations.

> **Note:** With Dolt backend, local writes persist immediately. The `import_beads`
> step is only needed after `git pull` brings JSONL changes from the other clone.
> See `commands.toml: sync_remote` (deprecated) for history.

## Advanced Features

### Checkpoint Diff

Show what changed between two checkpoints:
```bash
diff .kilocode/checkpoints/<checkpoint-1>.md \
     .kilocode/checkpoints/<checkpoint-2>.md
```

### Checkpoint History

Show git history of checkpoints:
```bash
git log --oneline -- .kilocode/checkpoints/
```

### Checkpoint Search

Search checkpoints by keyword:
```bash
grep -l "line health" .kilocode/checkpoints/*.md
```

## Error Handling

### No Checkpoints Found
```
❌ No checkpoints found in .kilocode/checkpoints/

Would you like to:
1. Create a checkpoint now (/save-game)
2. Load from Memory Bank instead
3. Start fresh
```

### Checkpoint Corrupted
```
❌ Checkpoint file is corrupted or unreadable

Would you like to:
1. Try another checkpoint
2. Load from git history
3. Start fresh
```

### Branch Mismatch
```
⚠️  Checkpoint was created on branch '<checkpoint-branch>'
    but you're currently on '<current-branch>'

Recommended actions:
1. Switch to checkpoint branch: git checkout <checkpoint-branch>
2. Continue on current branch (may have conflicts)
3. Cancel and review branches first
```

## Integration with Memory Bank

Checkpoints **complement** Memory Bank:

| Feature | Checkpoint | Memory Bank |
|---------|-----------|-------------|
| **Purpose** | Explicit save points | Continuous state |
| **Frequency** | User-triggered | Auto-updated |
| **Scope** | Full context snapshot | Incremental updates |
| **Format** | 500-1000 word narrative | Structured sections |
| **Git tracking** | Yes (by default) | Yes |
| **Use case** | Session transfer | Within-session memory |

**Best practice:** Use checkpoints for major milestones, Memory Bank for ongoing work.

## Example Usage

### Scenario 1: Resume After Weekend
```
User: /load-game
Agent: [lists checkpoints]
User: latest
Agent: [loads Friday's checkpoint, shows progress, next steps]
Agent: "Ready to continue with: Run quality gates before PR merge"
```

### Scenario 2: Switch Tasks
```
User: /save-game
Agent: [saves current work on feature-A]
User: /load-game
Agent: [lists checkpoints]
User: feature-B-checkpoint
Agent: [loads feature-B context, switches mental model]
```

### Scenario 3: Onboard New Agent
```
User: /load-game
Agent: [lists checkpoints]
User: milestone-determinism-gates-green
Agent: [loads checkpoint, understands project state]
Agent: "I see you completed the determinism gate migration. Next step: run the bounded gate sweep"
```

## Punch Card Exit Gate

**This workflow is not complete until the following gate passes:**

<!-- route: punch_checkpoint -->
```bash
python3 .kilocode/tools/punch_engine.py checkpoint {task_id} {card_id}
```

The punch card verifies:
- A checkpoint was successfully loaded and confirmed (Step 8)
- Environment alignment was verified (Step 7)
- Memory Bank was updated with checkpoint reference (Step 6)

## Notes

- Checkpoints are **immutable** (don't edit after creation)
- Create new checkpoint instead of modifying old one
- Checkpoints are **portable** (can share between agents/sessions)
- Checkpoints are **versioned** (git history preserves evolution)
- Use `/save-game` liberally - storage is cheap, context loss is expensive
