---
name: repomap-codebase-retrieval
description: Use Augment context engine codebase-retrieval for semantic code search and architecture understanding before editing or refactoring.
---

# Repomap Codebase Retrieval

## When to use this skill

Use this skill when you need to:

- Understand where a behavior lives before making a change
- Find the real entry points, call graph, and invariants for a feature
- Locate the authoritative implementation when file locations are unclear

## Default tool order

1. Use `mcp0_codebase-retrieval` for semantic codebase search and symbol mapping
2. Use exact search (`grep_search`) only after you know the likely files/symbols
3. Read the relevant files end-to-end before editing core abstractions

## Critical invariants

- Prefer semantic retrieval before editing
- Identify all call sites/consumers before changing an interface
- Avoid partial refactors; pull all code forward to the new pattern
