# Auto-Approval Settings for Kilo Code

**Phase 6: Auto-Approval Tuning**

This document provides recommended auto-approval settings for the repomap-core project in Kilo Code. These settings balance fabrication velocity with safety.

---

## How to Configure

1. Open VSCode with Kilo Code extension
2. Open Settings (Cmd/Ctrl + ,)
3. Search for "Kilo Code auto approval"
4. Configure the settings below

---

## Recommended Settings

### ✅ Safe to Auto-Approve

#### Read-Only Operations
- **Setting:** "Always approve read-only operations"
- **Rationale:** Reading files cannot cause harm
- **Enable:** ✅ Yes

#### Todo List Updates
- **Setting:** "Always approve todo list updates"
- **Rationale:** Task tracking updates are low-risk
- **Enable:** ✅ Yes

#### Command Allowlist
- **Setting:** Command auto-approval allowlist
- **Commands to allowlist:**
  ```
  git status
  git log
  git diff
  git show
  .venv/bin/python
  bd sync --no-push
  bd sync --status
  bd show
  bd ready
  bd list
  .kilocode/tools/bd sync --no-push
  .kilocode/tools/bd sync --status
  .kilocode/tools/bd show
  .kilocode/tools/bd ready
  .kilocode/tools/bd list
  pytest
  ruff
  mypy
  gh pr view
  gh pr diff
  gh pr checks
  gh pr list
  ```

**Rationale:** These commands are:
- Read-only (`git status`, `bd show`, `.kilocode/tools/bd show`, `gh pr view`)
- Safe operations within venv (`.venv/bin/python`)
- Non-destructive Beads queries (`bd ready`, `bd show`, `.kilocode/tools/bd ready`, `.kilocode/tools/bd show`)

### ⚠️ Manual Approval Required

#### Write Operations
- **Setting:** "Always approve write operations"
- **Enable:** ❌ No
- **Rationale:** Code changes should be reviewed before execution

#### Delete Operations
- **Setting:** "Always approve delete operations"
- **Enable:** ❌ No
- **Rationale:** Deletions are irreversible and require human judgment

#### Commands Requiring Manual Approval
- `bd sync` (pushes to remote - state mutation)
- `bd update` (modifies issue state)
- `bd close` (modifies issue state)
- `git commit` (creates commits)
- `git push` (pushes to remote)
- `git rebase` (rewrites history)
- `git reset` (destructive)
- `rm` (destructive)
- `pip install` (modifies environment)
- Any wildcard commands (`*`)

**Rationale:** These commands:
- Mutate state (Beads, git)
- Push to remote (sync, push)
- Are destructive (delete, reset)
- Modify environment (pip install)

### 🔧 MCP Tool Auto-Approval

#### Augment Context Engine
- **Tool:** `codebase-retrieval`
- **Setting:** "Always allow" checkbox in MCP server config
- **Enable:** ✅ Yes (already configured in `.kilocode/mcp.json`)
- **Rationale:** Read-only semantic search, high-value tool

#### Other MCP Tools
- **Tools:** `context7`, `sequentialthinking`, `sonarqube`
- **Setting:** Manual approval for now
- **Enable:** ❌ No (until proven safe through usage)
- **Rationale:** Conservative approach during dogfooding phase

---

## Testing Auto-Approval

After configuring settings, test with simple tasks:

1. **Test read-only auto-approval:**
   - Ask Kilo to read a file
   - Verify it auto-approves without prompt

2. **Test command allowlist:**
   - Ask Kilo to run `bd ready`
   - Verify it auto-approves
   - Ask Kilo to run `bd sync`
   - Verify it requires manual approval

3. **Test write protection:**
   - Ask Kilo to edit a file
   - Verify it requires manual approval

---

## Iteration Plan

During Phase 7 (dogfooding), track:

1. **Friction points** - Commands that should be auto-approved but aren't
2. **Safety issues** - Commands that auto-approved but shouldn't have
3. **Velocity impact** - How much faster is fabrication with auto-approval?

Update this document based on learnings.

---

## Safety Principles

1. **Read-only is safe** - File reads, git status, bd show
2. **Venv-scoped is safer** - `.venv/bin/python` limits blast radius
3. **State mutations require approval** - bd update, git commit, bd sync
4. **Remote operations require approval** - git push, bd sync (without --no-push)
5. **Destructive operations require approval** - delete, reset, rebase
6. **When in doubt, require approval** - Conservative by default

---

## References

- Kilo Code docs: Auto-approval settings
- Setup notes: [`docs/KILO_CODE_VSCODE_SETUP_NOTES.md`](../docs/KILO_CODE_VSCODE_SETUP_NOTES.md)
- Assessment: [`plans/kilo_code_assessment_and_roadmap.md`](../plans/kilo_code_assessment_and_roadmap.md)
