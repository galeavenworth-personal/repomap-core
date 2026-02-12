---
name: github-cli-code-review
description: Use GitHub CLI (gh) to fetch PR details, review comments, and threads for the current branch before addressing code review feedback.
---

# GitHub CLI Code Review

## Goal

When addressing code review comments, do not rely on user-provided summaries. Use `gh` to pull the authoritative review threads for the PR associated with the current branch.

Assume git authentication is available via SSH and does not block access.

## When to use this skill

Use this skill when you need to:

- Address PR review feedback
- Confirm what reviewers actually requested
- Avoid missing unresolved threads

## Default tool order

1. Identify the PR for the current branch using `gh`
2. Pull review threads/comments and extract actionable items
3. Implement fixes
4. Re-check PR thread state (optional)

## Recommended commands

```bash
# Confirm we’re in a git repo and on the expected branch
git status

# Find the PR associated with the current branch
gh pr view --json number,title,url,headRefName,baseRefName,author

# Get the full set of review threads (includes unresolved/resolved state)
gh pr view --json reviewThreads

# Quick human-readable view
gh pr view

# List PR comments (timeline entries)
gh pr view --comments
```

## Workflow tips

- Prefer `gh pr view --json ...` and then parse, because it includes thread resolution state.
- If multiple PRs exist, use `gh pr list --head <branch> --json number,title,url` and pick the one matching the current head branch.

## Critical invariants

- Don’t ask the user to paste review comments unless `gh` fails.
- Don’t assume the PR number; discover it.
- Avoid rewriting unrelated code—stick to the requested deltas.
