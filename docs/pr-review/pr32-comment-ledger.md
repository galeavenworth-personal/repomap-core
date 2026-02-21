# PR #32 Comment Ledger — erganomics-retro

## Review Comments

| # | Source | File | Line | Summary | Resolution |
|---|--------|------|------|---------|------------|
| 1 | Augment | `.opencode/plugins/beads-sync.ts` | 58 | `output.args.command` risky in before hook — output not available yet | **Fixed.** Removed `output` param; access args via `(input as Record<string, unknown>).args` with optional chaining. |
| 2 | Augment | `.gitignore` | 63 | Verify `docs/infra/mtls-lockdown.md` gitignore is intentional | **Dismissed.** Intentional — infrastructure doc with environment-specific details. |
| 3 | Copilot | `.opencode/plugins/beads-sync.ts` | 17 | `@see` points to gitignored `docs/research/` doc — dead link on GitHub | **Fixed.** Added `(local-only; gitignored)` annotation to the `@see` reference. |
| 4 | Copilot | `.opencode/plugins/beads-sync.ts` | 47 | `beads_install.sh` referenced but gitignored / not in repo | **Fixed.** Updated warning message to point to `AGENTS.md` for setup instructions. |
| 5 | Copilot | `.kilocode/rules/beads.md` | 18 | Docs claim "session.idle and agent stop" but plugin only handles `session.idle` | **Fixed.** Removed "and agent stop" to match plugin implementation. |
| 6 | Copilot | `.kilocode/skills/sonarqube-ops/SKILL.md` | 22 | SonarQube MCP not in `.kilocode/mcp.json` | **Noted.** SonarQube MCP is global. Added "Prerequisites" section documenting this. |

## Files Changed

- `.opencode/plugins/beads-sync.ts` — Comments 1, 3, 4
- `.kilocode/rules/beads.md` — Comment 5
- `.kilocode/skills/sonarqube-ops/SKILL.md` — Comment 6
