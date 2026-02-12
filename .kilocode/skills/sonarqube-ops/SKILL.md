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

1. Discover accessible projects: `mcp3_search_my_sonarqube_projects`
2. Check quality gate: `mcp3_get_project_quality_gate_status`
3. List issues: `mcp3_search_sonar_issues_in_projects`
4. Inspect rule details (if needed): `mcp3_show_rule`
5. Inspect raw source (if needed): `mcp3_get_raw_source`

## Critical invariants

- Don’t guess project keys; look them up first
- After fixing code locally, don’t expect SonarQube to reflect updates until a new analysis runs
