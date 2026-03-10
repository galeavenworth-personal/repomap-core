---
description: Child-level workflow for PR review response. Supports standalone use (all phases) or phase-scoped invocation from respond-to-pr-review-orchestrate (Phase 0 only for ledger building, Phase 5 only for acknowledgement).
auto_execution_mode: 3
punch_card: respond-to-pr-review
---

# Respond to PR Review Workflow

Use this workflow when you are **responding to PR review feedback** (not performing the
review). It uses `gh` CLI to fetch review comments, guides you through context + planning,
ensures changes meet quality standards, and requires that **every comment is acknowledged**.

> **Former name:** `code-review` / `code-review.md` (deprecated). This workflow's purpose
> is to *respond to* reviews and address comments.

**Punch Card:** `respond-to-pr-review` (7 rows, 6 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Orchestration Context

This workflow can be invoked in two ways:

### Standalone (all phases)
When invoked directly (e.g., `/respond-to-pr-review`), execute all phases 0–6.

### Phase-scoped (child of orchestrator)
When invoked by [`/respond-to-pr-review-orchestrate`](./respond-to-pr-review-orchestrate.md),
you will be given a `workflow_instruction` that scopes you to specific phases:

- **"Phase 0 only"** → You are a **ledger builder**. Execute Phase 0, return the Comment
  Ledger, then stop. Do NOT fix code, do NOT reply to comments.
- **"Phase 5 only"** → You are an **acknowledger**. You will receive a Comment Ledger and
  a fix mapping. Execute Phase 5 only — reply to every comment on GitHub. Do NOT modify code.

Check your handoff packet for `workflow_instruction` to determine your scope.

## Core Principles

1. **All quality gates must pass** — via `gate quality` composite
2. **No workarounds** — prefer clean, idiomatic fixes over ignores
3. **No silent fixes** — every review comment must be acknowledged (even if declined/deferred)

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- PR number or branch name known
- Local branch checked out and up-to-date with remote

**Branch truth is mandatory:** branch name alone is not sufficient. Before making any claim
about PR state or completion, you must run `git fetch origin` and verify the checkout's
`HEAD` matches `origin/<headRefName>` or explain the exact divergence.

---

## Phase 0: Fetch + Normalize Review Feedback

### Step 0.1: Identify Repo + PR

> 📌 `fetch pr` → [`commands.fetch_pr`](../commands.toml)
> Resolves to: `gh pr view --json number,title,body,reviewDecision,reviews,comments`

```bash
# Repo identity (owner/repo)
gh repo view --json nameWithOwner
```

Record:
- `owner/repo`
- `pr_number`
- `headRefName` (branch to push)

### Step 0.2: Fetch Conversation-Level PR Comments (non-line-specific)

```bash
gh pr view <PR_NUMBER> --comments
```

### Step 0.3: Fetch Line-Specific Review Comments (with IDs)

> 📌 `list pr-comments` → [`commands.list_pr_comments`](../commands.toml)
> Resolves to: `gh pr view --json reviews,comments`

For detailed per-comment data:
```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/comments \
  --jq '.[] | {id, path, line, side, user: .user.login, body, created_at, updated_at}'
```

### Step 0.4 (MANDATORY): Build a "Comment Ledger"

Create a ledger that contains **every** piece of reviewer feedback you intend to respond to.

**Ledger invariants:**
- Every comment appears exactly once in the ledger.
- Each row has a **disposition** and a **reply plan**.
- No work is considered complete until all ledger rows are `acknowledged`.
- The ledger must be persisted in the task/session artifacts; transient in-model tracking is insufficient.

Suggested schema:

| ledger_id | type | comment_id | author | path:line | category | disposition | implementation | reply_body | status |
|---|---|---:|---|---|---|---|---|---|---|
| 001 | review | 123456789 | octocat | repomap/x.py:42 | blocking | fix | change X to Y | "Fixed in <SHA> …" | pending |
| 002 | review | 123456790 | octocat | repomap/y.py:17 | question | answer | none | "Good question: …" | pending |
| 003 | conversation | n/a | octocat | n/a | suggestion | defer | follow-up issue | "Created Beads issue …" | pending |

**Disposition values:**
- `fix` — implement change
- `answer` — respond without code change
- `defer` — create Beads issue / follow-up PR
- `decline` — explain why not (with rationale)

---

## Phase 1: Understand Context (Before Editing)

For each **blocking** / **suggestion** review comment:

### Step 1.1: Semantic Understanding

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Query for:
- What does the code at the comment location do?
- What are its callers and constraints?
- Why is it implemented this way?

### Step 1.2: Documentation Lookup (if needed)

If the comment touches an external library or best practice:

> 📌 `resolve library` → [`commands.resolve_library`](../commands.toml)
> 📌 `query docs` → [`commands.query_docs`](../commands.toml)

### Step 1.3: Blast Radius

Find all references and call sites before making changes:

```bash
# Use search_files for comprehensive reference search
```

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)

---

## Phase 2: Plan Responses (Ledger → Action)

### Step 2.1: Use Sequential Thinking for Non-Trivial Comments

> 📌 `decompose task` → [`commands.decompose_task`](../commands.toml)
> Resolves to: `mcp--sequentialthinking--process_thought`

Use sequential thinking when:
- multiple valid approaches exist
- reviewer suggests an architectural change
- you disagree (track assumptions explicitly)

### Step 2.2: Convert Each Ledger Row into One of These Plans

**Option A: Implement as suggested**
- Update `disposition=fix`, fill `implementation` and `reply_body`

**Option B: Implement alternative**
- `disposition=fix`, with rationale in `reply_body`

**Option C: Push back**
- `disposition=decline`, include technical justification + evidence

**Option D: Ask for clarification**
- `disposition=answer`, include a direct question in `reply_body`

### Step 2.3: Batch Related Ledger Rows

Cluster rows that:
- touch the same file
- represent the same underlying concern

---

## Phase 3: Execute Changes (Cluster-by-Cluster)

For each cluster:
1. Implement changes
2. Run targeted tests
3. Update ledger rows to include commit SHA and mark `status=ready_to_ack`

---

## Phase 4: Verify Quality (All Gates Must Pass)

**CRITICAL:** Do not push until these pass.

### Step 4.1: Local Quality Gates

> 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
> Composite: `format_ruff` → `check_ruff` → `check_mypy` → `test_pytest`
> All run through `bounded_gate.py` with receipt tracking.

### Step 4.2: SonarQube Quality Gate (Full — Conditions + Issues)

**You must check BOTH the quality gate conditions AND the issue list.**

Quality gate conditions include **metrics** (e.g., duplication density, coverage) that are
NOT surfaced as issues. If you only check issues, you will miss metric-based failures.

#### Step 4.2a: Check Quality Gate Status (conditions)

> 📌 `inspect quality-gate` → [`commands.inspect_quality_gate`](../commands.toml)
> Resolves to: `mcp--sonarqube--get_project_quality_gate_status` with `projectKey=<key>` and `pullRequest=<PR_NUMBER>`

This returns the overall gate status and **each condition** with its threshold and actual
value. For each condition with `status=ERROR`, add a ledger row with `type=sonarqube-gate`
and the metric details.

#### Step 4.2b: Check Quality Gate Issues (rule violations)

> 📌 `search issues` → [`commands.search_issues`](../commands.toml)
> Resolves to: `mcp--sonarqube--search_sonar_issues_in_projects` with `projects=[<key>]` and `pullRequestId=<PR_NUMBER>`

For each issue, add a ledger row with `type=sonarqube`.

#### Step 4.2c: Inspect Measures (if metric conditions fail)

> 📌 `inspect measures` → [`commands.inspect_measures`](../commands.toml)
> Resolves to: `mcp--sonarqube--get_component_measures` with `projectKey=<key>` and `pullRequest=<PR_NUMBER>`

Use this to get detailed metric values (e.g., `new_duplicated_lines_density`) when a
metric condition fails. This tells you the exact scope of duplication or coverage gaps.

If the quality gate is **failing** or issues exist:

1. List all issues on the PR using `search issues`
2. List all failing conditions using `inspect quality-gate`
3. For metric failures (duplication, coverage), use `inspect measures` to get specifics
4. For each issue, inspect the rule if unfamiliar: `mcp--sonarqube--show_rule` with `key=<rule_key>`
5. Add SonarQube issues to the **Comment Ledger** (Phase 0.4) with `type=sonarqube`
6. Add SonarQube metric failures to the **Comment Ledger** with `type=sonarqube-gate`
7. Implement fixes alongside reviewer-requested changes
8. After pushing, the gate will re-evaluate on the next SonarQube analysis run

**Line Fault:** If the SonarQube MCP server is unavailable or unresponsive, this is a
**line fault**. Do NOT skip and proceed — emit a Line Fault Contract and dispatch the fitter:

> 📌 `dispatch fitter` → [`commands.dispatch_fitter`](../commands.toml)
> Contract: [`.kilocode/contracts/line_health/line_fault_contract.md`](../contracts/line_health/line_fault_contract.md)

Emit a fault payload with:
- `gate_id`: `"sonarqube-quality-gate"`
- `invocation`: the MCP tool call that failed (e.g., `mcp--sonarqube--get_project_quality_gate_status`)
- `stop_reason`: `"env_missing"` (server down/unreachable)
- `repro_hints`: SonarQube URL, project key, PR number

The fitter will attempt to restore the SonarQube connection. If the fitter succeeds,
retry Step 4.2. If the fitter cannot restore the line, the fitter escalates to a human.
Max 1 retry — do not thrash.

---

## Phase 5 (MANDATORY): Acknowledge Every Ledger Row

### Step 5.1: Reply to Each Line-Specific Review Comment

For each ledger row where `type=review`, post the row's `reply_body` as a reply:

```bash
# Reply to a review comment thread
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/comments/<COMMENT_ID>/replies \
  -f body="<reply_body>"
```

Guidance for `reply_body`:
- If fixed: include commit SHA + what changed
- If declined: include reason + alternatives
- If answered: include explanation + any follow-up you did

### Step 5.2: Acknowledge Conversation-Level Comments

Conversation-level PR comments are not threaded. Use one or more PR comments that
reference the original feedback explicitly (quote or paraphrase) and map it to your
ledger dispositions.

```bash
# Post a PR-level acknowledgement (can cover multiple ledger rows)
gh pr comment <PR_NUMBER> --body "<ledger acknowledgement summary>"
```

### Step 5.3: Mark Ledger Complete

All ledger rows must be `acknowledged` before pushing.

Do not treat "I know what I would reply" as acknowledgement. The replies must be actually
posted to GitHub, and the ledger must record that they were posted.

---

## Phase 6: Push + (Optional) Request Re-Review

```bash
git push origin <headRefName>

gh pr edit <PR_NUMBER> --add-reviewer <reviewer>
```

Completion is not allowed at "ready to push" or "changes prepared". If code changed, you must:

1. commit the changes
2. push the branch to `origin/<headRefName>`
3. run `git fetch origin`
4. verify:
   - `git rev-parse HEAD`
   - `git rev-parse origin/<headRefName>`
   - ahead/behind is `0/0`

Only then may you claim the PR branch contains the fix.

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id} --bead-id {bead_id}`

> 🚪 `checkpoint punch-card {task_id} respond-to-pr-review` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} respond-to-pr-review`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If code changed but commit/push/remote verification did not happen:** Do NOT call
`attempt_completion`, even if tests pass.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the response summary.

---

## Anti-Patterns

- Implementing without understanding context
- Silent fixes without acknowledging comments
- Adding `# noqa` / `# type: ignore` instead of clean fixes
- Scope creep: create Beads issues for discovered work

---

## Related Workflows

- [`/respond-to-pr-review-orchestrate`](./respond-to-pr-review-orchestrate.md) — Orchestrator that delegates ledger → fix → acknowledge as phased children
- [`/start-task`](./start-task.md) — Task preparation phase
- [`/execute-task`](./execute-task.md) — Task execution phase
- [`/fix-ci`](./fix-ci.md) — Quality gate fixes

## Related Skills

- [`github-cli-code-review`](../skills/github-cli-code-review/SKILL.md) — PR comment fetching
- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning
- [`context7-docs-ops`](../skills/context7-docs-ops/SKILL.md) — Library documentation
- [`sonarqube-ops`](../skills/sonarqube-ops/SKILL.md) — Code quality metrics

## Philosophy

This workflow enforces **every comment acknowledged** before exit, with quality gates
routed through `commands.toml` composites. Structure discipline: from review fetch to
ledger management to quality verification — every step has a commands.toml route.
