---
description: Workflow for responding to PR review feedback: fetch comments, plan fixes, implement changes, run quality gates, and acknowledge every review thread.
---

# Respond to PR Review Workflow

Use this workflow when you are **responding to PR review feedback** (not performing the review). It uses `gh` CLI to fetch review comments, guides you through context + planning, ensures changes meet quality standards, and requires that **every comment is acknowledged**.

> **Former name:** `code-review` / `code-review.md` (deprecated). This workflow’s purpose is to *respond to* reviews and address comments.

## Core Principles

1. **All quality gates must pass**: `ruff format`, `ruff check`, `mypy`, `pytest`
2. **No workarounds**: prefer clean, idiomatic fixes over ignores
3. **Refactoring patterns are always on the table**: see `REFACTORING_PLAYBOOK.md`
4. **No silent fixes**: every review comment must be acknowledged (even if declined/deferred)

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- PR number or branch name known
- Local branch checked out and up-to-date with remote

---

## Phase 0: Fetch + Normalize Review Feedback

### Step 0.1: Identify Repo + PR

```bash
# Repo identity (owner/repo)
gh repo view --json nameWithOwner

# PR overview
gh pr view <PR_NUMBER> --json number,title,state,reviewDecision,headRefName,baseRefName
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

```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/comments \
  --jq '.[] | {id, path, line, side, user: .user.login, body, created_at, updated_at}'
```

### Step 0.4 (MANDATORY): Build a “Comment Ledger”

Create a ledger that contains **every** piece of reviewer feedback you intend to respond to.

**Ledger invariants:**
- Every comment appears exactly once in the ledger.
- Each row has a **disposition** and a **reply plan**.
- No work is considered complete until all ledger rows are `acknowledged`.

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

Use semantic search to answer:
- What does the code at the comment location do?
- What are its callers and constraints?
- Why is it implemented this way?

### Step 1.2: Documentation Lookup (if needed)

If the comment touches an external library or best practice:
- Resolve library ID
- Query documentation for the specific topic

### Step 1.3: Blast Radius

Find all references and call sites before making changes:

```bash
# If you have ripgrep
rg "<symbol>" -n
```

---

## Phase 2: Plan Responses (Ledger → Action)

### Step 2.1: Use Sequential Thinking for Non-Trivial Comments

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
1. implement changes
2. run targeted tests
3. update ledger rows to include commit SHA and mark `status=ready_to_ack`

---

## Phase 4: Verify Quality (All Gates Must Pass)

**CRITICAL:** Do not push until these pass.

```bash
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
.venv/bin/python -m pytest -q
```

Optional (if PR is scanned in SonarQube):
- Query SonarQube PR issues: `mcp--sonarqube--search_sonar_issues_in_projects` with `pullRequestId=<PR_NUMBER>`
- Query quality gate status: `mcp--sonarqube--get_project_quality_gate_status` with `pullRequest=<PR_NUMBER>`

---

## Phase 5 (MANDATORY): Acknowledge Every Ledger Row

### Step 5.1: Reply to Each Line-Specific Review Comment

For each ledger row where `type=review`, post the row’s `reply_body` as a reply:

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

Conversation-level PR comments are not threaded. Use one or more PR comments that reference the original feedback explicitly (quote or paraphrase) and map it to your ledger dispositions.

```bash
# Post a PR-level acknowledgement (can cover multiple ledger rows)
gh pr comment <PR_NUMBER> --body "<ledger acknowledgement summary>"
```

### Step 5.3: Mark Ledger Complete

All ledger rows must be `acknowledged` before pushing.

---

## Phase 6: Push + (Optional) Request Re-Review

```bash
git push origin <headRefName>

gh pr edit <PR_NUMBER> --add-reviewer <reviewer>
```

---

## Anti-Patterns

- Implementing without understanding context
- Silent fixes without acknowledging comments
- Adding `# noqa` / `# type: ignore` instead of clean fixes
- Scope creep: create Beads issues for discovered work
