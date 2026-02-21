# Capabilities Registry

**Authoritative source:** [`.kilocode/commands.toml`](../../commands.toml) — verb+noun → skill binding + tool template.

## Orchestrator Selection Heuristic

- **process-orchestrator** → Complex tasks with distinct phases, isolated subtask contexts, long-running work
- **audit-orchestrator** → Adversarial pressure testing
- **Original workflows** (`/start-task`, `/execute-task`, etc.) → Straightforward single-agent tasks

## Thinking Plans

Composable delegation recipes under `.kilocode/contracts/thinking/plans/`:
- `design-subsystem.md` — Abstract → Systems → Adversarial → Concrete
- `debug-incident.md` — Concrete → Research → Adversarial → Concrete
- `evaluate-dependency.md` — Abstract → Systems → Adversarial → Concrete
- `strategic-decision.md` — Abstract → Epistemic → Adversarial → Concrete
