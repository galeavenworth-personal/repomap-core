---
name: github-cli-code-review
description: Use GitHub CLI (gh) and SonarQube MCP tools to fetch PR details, review comments, threads, and quality gate status for the current branch before addressing code review feedback.
---

# GitHub CLI Code Review

## Goal

When addressing code review comments, do not rely on user-provided summaries. Use `gh` to pull the authoritative review threads for the PR associated with the current branch. Additionally, check the SonarQube quality gate for the PR and address any issues causing it to fail.

Assume git authentication is available via SSH and does not block access.

## When to use this skill

Use this skill when you need to:

- Address PR review feedback
- Confirm what reviewers actually requested
- Avoid missing unresolved threads
- Check and address SonarQube quality gate failures on a PR
- Fix SonarQube-reported issues (bugs, code smells, vulnerabilities) introduced by the PR

## Default tool order

1. Identify the PR for the current branch using `gh`
2. Pull review threads/comments and extract actionable items
3. Check SonarQube quality gate status for the PR
4. List SonarQube issues on the PR (if gate is failing or issues exist)
5. Inspect rule details for any unfamiliar SonarQube rules
6. Implement fixes for both reviewer comments and SonarQube issues
7. Re-check PR thread state and quality gate (optional)

## Recommended commands

```bash
# Confirm we're in a git repo and on the expected branch
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

## SonarQube quality gate commands

Use the SonarQube MCP tools (not CLI) for quality gate inspection:

1. **Discover the project key:**
   `mcp--sonarqube--search_my_sonarqube_projects`

2. **Check quality gate status for this PR:**
   `mcp--sonarqube--get_project_quality_gate_status` with `projectKey=<key>` and `pullRequest=<PR_NUMBER>`

3. **List issues on this PR:**
   `mcp--sonarqube--search_sonar_issues_in_projects` with `projects=[<key>]` and `pullRequestId=<PR_NUMBER>`

4. **Understand a specific rule (if unfamiliar):**
   `mcp--sonarqube--show_rule` with `key=<rule_key>`

5. **View source context in SonarQube (if needed):**
   `mcp--sonarqube--get_raw_source` with `key=<file_key>` and `pullRequest=<PR_NUMBER>`

## Workflow tips

- Prefer `gh pr view --json ...` and then parse, because it includes thread resolution state.
- If multiple PRs exist, use `gh pr list --head <branch> --json number,title,url` and pick the one matching the current head branch.
- Always check SonarQube quality gate **after** fetching reviewer comments — some reviewer comments may overlap with SonarQube findings.
- When both a reviewer comment and a SonarQube issue target the same code, address them together in a single fix.
- SonarQube issues on a PR only show **new issues introduced by the PR** — not pre-existing issues on the target branch.
- After fixing SonarQube issues locally, the gate won't update until a new analysis runs (typically triggered by pushing).

## SonarQube unavailability — Line Fault

If the SonarQube MCP server is unavailable or unresponsive, this is a **line fault** — do NOT skip and continue. Emit a Line Fault Contract (see [`.kilocode/contracts/line_health/line_fault_contract.md`](../../contracts/line_health/line_fault_contract.md)) and dispatch the fitter via `dispatch fitter` ([`commands.dispatch_fitter`](../../commands.toml)).

Fault payload fields:
- `gate_id`: `"sonarqube-quality-gate"`
- `invocation`: the MCP tool call that failed
- `stop_reason`: `"env_missing"`
- `repro_hints`: SonarQube URL, project key, PR number

The fitter will attempt to restore the connection. If the fitter succeeds, retry the SonarQube steps. If the fitter cannot restore the line, it escalates to a human. Max 1 retry.

## Critical invariants

- Don't ask the user to paste review comments unless `gh` fails.
- Don't assume the PR number; discover it.
- Don't guess SonarQube project keys; look them up via `mcp--sonarqube--search_my_sonarqube_projects`.
- Avoid rewriting unrelated code—stick to the requested deltas.
- Treat SonarQube quality gate failures as blocking — they must be addressed before the PR can merge.
- Include `pullRequest` / `pullRequestId` parameters when querying SonarQube for PR-scoped results.
