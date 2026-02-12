---
name: context7-docs-ops
description: Retrieve up-to-date third-party library docs via Context7 (resolve-library-id then query-docs) before implementing integrations.
---

# Context7 Docs Ops

## When to use this skill

Use this skill when you need to:

- Implement or debug behavior that depends on a third-party library
- Confirm current API signatures and usage patterns
- Find authoritative examples without guessing

## Default tool order

1. `mcp1_resolve-library-id`
2. `mcp1_query-docs`
3. Implement using the verified APIs

## Constraints

- Don’t include secrets in documentation queries
- Don’t call Context7 more than 3 times per question
