---
name: sonarqube-ops
description: Inspect SonarQube quality gates, issues, and source using the SonarQube MCP tools.
---

# SonarQube Ops

## When to use this skill

Use this skill when you need to:

- Investigate quality gate failures
- Review static analysis issues and prioritize fixes
- Pull source from SonarQube for a specific file key

## Default tool order

1. Discover accessible projects: `mcp--sonarqube--search_my_sonarqube_projects`
2. Check quality gate: `mcp--sonarqube--get_project_quality_gate_status`
3. List issues: `mcp--sonarqube--search_sonar_issues_in_projects`
4. Inspect rule details (if needed): `mcp--sonarqube--show_rule`
5. Inspect raw source (if needed): `mcp--sonarqube--get_raw_source`

## Critical invariants

- Don't guess project keys; look them up via `mcp--sonarqube--search_my_sonarqube_projects` first
- After fixing code locally, don't expect SonarQube to reflect updates until a new analysis runs
- SonarQube requires USER tokens (not project tokens) — if you see "Not authorized", verify token type
- If `analyze_file_list` or `toggle_automatic_analysis` tools exist, use them per the SonarQube MCP server instructions (disable auto-analysis at task start, re-enable + analyze at task end)
- Include branch parameter when user is working on a feature branch
- Snippet analysis doesn't replace full project scans — provide full file content for better results
