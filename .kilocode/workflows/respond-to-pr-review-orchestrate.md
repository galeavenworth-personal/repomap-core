---
description: Delegation orchestrator for PR review response. Spawns pr-review children for ledger building, code children for fixes, and pr-review children for acknowledgement. Process-orchestrator runs this — it coordinates, never implements.
auto_execution_mode: 3
punch_card: pr-review-orchestrate
---

# Respond to PR Review — Orchestration Workflow

A delegation orchestrator that coordinates the phased response to PR review feedback.
Each phase runs in its own isolated child session via `new_task`, ensuring context isolation,
bounded cost, and punch card enforcement at every phase boundary.

**Punch Card:** `pr-review-orchestrate` (10 rows, 5 required, 4 forbidden)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Usage

```
/respond-to-pr-review-orchestrate <pr-number> [--bead-id <bead-id>]
```

## Architecture

**You are a process-orchestrator (Tier 2).** You coordinate, you do not implement.

```
process-orchestrator (this workflow)
├── Phase 1: new_task → pr-review (build-pr-ledger)
│   └── Fetches GitHub comments + SonarQube gate → returns structured ledger
├── Phase 2: new_task → code (fix-pr-ledger-items)
│   └── Addresses each ledger item, ensures ALL quality gates pass
├── Phase 3: new_task → pr-review (acknowledge-pr-ledger)
│   └── Replies to each GitHub comment with fix references
└── punch card: pr-review-orchestrate (requires child_spawn, forbids direct tool use)
```

**Anti-delegation enforcement:** If you call `edit_file`, `apply_diff`, `write_to_file`,
or `retrieve codebase` directly, your punch card checkpoint will FAIL. Delegate to children.

## Why This Is Split Into Three Phases

The distance between **ledger creation** (reading PR comments) and **ledger acknowledgement**
(replying to each comment with fix references) is structurally too large for a single session.
If one agent does everything:

- The context window fills with code diffs and test output during fixing
- The agent deprioritizes the acknowledgement step
- The ledger-item ↔ fix mapping degrades because it was never a first-class artifact

Splitting ensures:
- **The ledger is a concrete artifact** that enters and exits each phase boundary
- **The fix mapping is a concrete artifact** the acknowledger receives clean
- **Each child has a focused mandate** with no context pollution

---

## Pre-Flight

1. Identify PR number and repo:

   ```bash
   gh repo view --json nameWithOwner
   gh pr view <PR_NUMBER> --json number,title,headRefName,reviewDecision
   ```

   Record: `owner/repo`, `pr_number`, `headRefName`

2. Verify branch state:

   ```bash
   git fetch origin
   git status
   ```

   Local branch must match `headRefName` and be up-to-date with `origin/<headRefName>`.

3. If a bead-id was provided:

   > 📌 `show issue {bead-id}` → [`commands.show_issue`](../commands.toml)

---

## Phase 1: Build Ledger (Delegate to PR-Review Child)

> 📌 `dispatch pr-review` → [`commands.dispatch_pr_review`](../commands.toml)
> Resolves to: `new_task` with `target_mode=pr-review`
> Contract: [`.kilocode/contracts/composability/handoff_packet.md`](../contracts/composability/handoff_packet.md)

**Handoff packet must include:**
- `task_id`
- `pr_number`
- `owner_repo`: `owner/repo` string
- `objective`: "Build a structured Comment Ledger from all PR review comments and SonarQube quality gate conditions. Do NOT fix code. Do NOT reply to comments."
- `success_criteria`: ["Ledger returned with every comment and every failing quality gate condition as a row", "Each row has: ledger_id, type, source_id, author, path:line, category, disposition, status"]
- `workflow_instruction`: "Follow `/respond-to-pr-review` workflow Phase 0 ONLY. Stop after building the ledger. Your punch card is `build-pr-ledger`."

**Critical scope constraint:** The ledger builder must:
- Fetch all PR review comments via `gh api`
- Query SonarQube quality gate status (not just issues — includes metrics like duplication)
- Query SonarQube issues on the PR
- Build the Comment Ledger with ALL sources unified
- Group comments that refer to the same underlying problem (optional, with rationale)
- **NOT** fix any code
- **NOT** reply to any PR comments
- Return the ledger as structured output

**Child workflow:** [`respond-to-pr-review.md`](./respond-to-pr-review.md) (Phase 0 only)

**Wait for child completion.** Parse the Comment Ledger from the child's return.

**Validate the ledger:** Every row must have `ledger_id`, `type`, `source_id`, `category`.

---

## Phase 2: Fix Ledger Items (Delegate to Code Child)

> 📌 `dispatch code` → [`commands.dispatch_code`](../commands.toml)
> Resolves to: `new_task` with `target_mode=code`

**Handoff packet must include:**
- `task_id`
- `pr_number`
- `owner_repo`
- `ledger`: the full Comment Ledger from Phase 1
- `objective`: "Address every ledger item with disposition=fix. Ensure ALL quality gates pass — including SonarQube quality gate metrics (duplication, coverage, etc.), not just issues."
- `success_criteria`:
  - "Every ledger item with disposition=fix has a corresponding code change"
  - "`npx tsc --noEmit` passes clean (or language-appropriate equivalent)"
  - "Test suite passes"
  - "Changes committed and pushed to origin/<headRefName>"
  - "Branch is 0 ahead / 0 behind origin/<headRefName>"
- `fix_mapping_required`: true — "For each ledger item you fix, record: ledger_id → commit SHA, file, line range, description of change"
- `constraints`:
  - "Stay on branch <headRefName>"
  - "Do not reply to GitHub PR comments — that is a separate phase"
  - "Check SonarQube quality gate status AFTER pushing to verify all conditions pass (including metric conditions like duplication threshold)"
- `workflow_instruction`: "Follow `/execute-subtask` workflow adapted for ledger-item resolution. Your punch card is `execute-subtask`."

**Child workflow:** [`execute-subtask.md`](./execute-subtask.md) (adapted for ledger items)

**Wait for child completion.** Parse:
- The **fix mapping** (ledger_id → fix details)
- The quality gate verification result
- The commit SHA and branch state

**Validate the fix mapping:**
- Every ledger item with `disposition=fix` must appear in the mapping
- The child must have pushed to origin

---

## Phase 3: Acknowledge Ledger (Delegate to PR-Review Child)

> 📌 `dispatch pr-review` → [`commands.dispatch_pr_review`](../commands.toml)
> Resolves to: `new_task` with `target_mode=pr-review`

**Handoff packet must include:**
- `task_id`
- `pr_number`
- `owner_repo`
- `ledger`: the full Comment Ledger from Phase 1
- `fix_mapping`: the fix mapping from Phase 2
- `objective`: "Reply to every PR comment in the ledger, referencing the actual fixes. Post acknowledgements to GitHub. Do NOT modify code."
- `success_criteria`:
  - "Every ledger row with type=review has a GitHub reply posted"
  - "Every ledger row with type=conversation has a GitHub PR comment posted"
  - "Every ledger row with type=sonarqube has been noted in a summary comment"
  - "All ledger rows marked status=acknowledged"
- `constraints`:
  - "Do NOT modify any code files"
  - "Do NOT create new commits"
  - "Only use `gh api` and `gh pr comment` to post replies"
- `workflow_instruction`: "Follow `/respond-to-pr-review` workflow Phase 5 ONLY. Your punch card is `acknowledge-pr-ledger`."

**Child workflow:** [`respond-to-pr-review.md`](./respond-to-pr-review.md) (Phase 5 only)

**Wait for child completion.** Verify all ledger rows are `acknowledged`.

---

## Execution Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│  PRE-FLIGHT                                                      │
│  ├── Identify PR number + repo + headRefName                    │
│  ├── Verify local branch matches headRefName                    │
│  └── git fetch origin; verify up-to-date                        │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 1: BUILD LEDGER (delegate to pr-review child)             │
│  ├── dispatch pr-review          → commands.dispatch_pr_review  │
│  │   └── child fetches GH comments + SonarQube gate → ledger   │
│  ├── Parse Comment Ledger from child return                     │
│  └── Validate ledger completeness                               │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 2: FIX LEDGER ITEMS (delegate to code child)             │
│  ├── dispatch code               → commands.dispatch_code       │
│  │   └── child fixes each item, runs ALL gates, pushes          │
│  ├── Parse fix mapping from child return                        │
│  └── Validate every fix-disposition item has a mapping entry    │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 3: ACKNOWLEDGE LEDGER (delegate to pr-review child)       │
│  ├── dispatch pr-review          → commands.dispatch_pr_review  │
│  │   └── child replies to every GH comment with fix references  │
│  ├── Verify all ledger rows = acknowledged                      │
│  └── Validate GitHub replies were actually posted               │
├─────────────────────────────────────────────────────────────────┤
│  EXIT GATE: PUNCH CARD CHECKPOINT                                │
│  ├── mint punches {task_id}      → commands.punch_mint          │
│  ├── checkpoint punch-card {task_id} pr-review-orchestrate      │
│  │                               → commands.punch_checkpoint     │
│  └── MUST PASS — checks child_spawn + forbids direct tool use   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Rules

### Delegation Is Mandatory
You are a Tier 2 orchestrator. You MUST delegate all specialist work to children via
`new_task`. Direct calls to `retrieve codebase`, `edit_file`, `apply_diff`, `write_to_file`,
`gh api`, or `gh pr comment` will cause your punch card checkpoint to FAIL.

### The Ledger Is the Contract
The Comment Ledger is the shared artifact that flows between phases. It is:
- Built in Phase 1 (immutable after this phase)
- Consumed in Phase 2 (fix mapping added)
- Consumed in Phase 3 (acknowledgements added)

Do not allow children to modify the ledger structure. Only status and mapping fields change.

### Quality Gate Completeness
Phase 2 must check the **full SonarQube quality gate status** — not just issues.
Quality gate conditions include metrics (duplication density, coverage) that are NOT
surfaced as issues. The code child must query `inspect quality-gate` after pushing
and address any failing conditions.

### Sequential Execution
Phases run in strict order. Phase 2 cannot start without the ledger from Phase 1.
Phase 3 cannot start without the fix mapping from Phase 2.

### Bounded Retry
Max 1 retry per failed phase. If a phase fails twice, STOP and escalate.

### Virtual Environment Mandate
**ALWAYS** use `.venv/bin/python -m ...` for Python execution.

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id}`

> 🚪 `checkpoint punch-card {task_id} pr-review-orchestrate` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} pr-review-orchestrate`
> **receipt_required = true** — this is a hard gate.

**Checkpoint verifies:**
- ✅ You spawned at least one `pr-review` child (ledger building happened)
- ✅ You spawned at least one `code` child (fixes happened)
- ✅ You received child completions
- ❌ You did NOT call `edit_file`, `apply_diff`, `write_to_file`, or `codebase_retrieval` directly

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review failures:
- Missing `child_spawn` → you forgot to delegate a phase
- Forbidden violations → you did specialist work yourself; re-run with proper delegation

**If checkpoint PASSES:** Proceed to `attempt_completion` with the response summary.

---

## Related Workflows

- [`/respond-to-pr-review`](./respond-to-pr-review.md) — Child-level workflow (ledger building + acknowledgement)
- [`/execute-subtask`](./execute-subtask.md) — Child-level workflow (code fixes)
- [`/start-task`](./start-task.md) — Task preparation orchestrator
- [`/execute-task`](./execute-task.md) — Task execution orchestrator
- [`/fix-ci`](./fix-ci.md) — Quality gate fixes

## Related Skills

- [`github-cli-code-review`](../skills/github-cli-code-review/SKILL.md) — PR comment fetching
- [`sonarqube-ops`](../skills/sonarqube-ops/SKILL.md) — Code quality metrics
- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning

## Philosophy

This workflow enforces **phased delegation** with the Comment Ledger as the shared contract
between phases. The orchestrator never touches GitHub, never edits code, never queries
SonarQube — it dispatches children who do, and it validates the artifacts they return.

**Key architectural insight:** The distance between ledger creation and ledger acknowledgement
is structurally too large for a single session. Splitting ensures each phase has a focused
mandate, clean context, and a concrete artifact boundary.
