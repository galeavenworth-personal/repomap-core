# Composability Contract: Parent → Child Handoff Packet (via `new_task`)

## Purpose

Define a **minimal, human+agent readable** handoff schema for spawning a child task using `new_task`.

This contract standardizes the **only two structured input channels** the parent controls at spawn time:

1. `new_task.message` — an arbitrary string (recommended: embed a JSON handoff packet)
2. `new_task.todos` — a checklist that becomes the child’s reminders table

### Notation

- Dotted names such as `new_task.message` and `new_task.todos` refer to **tool parameter names**, not nested JSON fields inside `handoff_packet`.
- Inside the JSON handoff object, use the explicit keys shown below (for example: `task_id`, `objective`, `evidence`).

This contract is intended to make orchestration **composable**: parents can spawn children (including sub-orchestrators) with bounded, explicit context.

## Minimum MVP Fields

### A) `new_task.message` (string)

The message SHOULD contain a fenced JSON object (`handoff_packet`) as the first block of the message.

#### Required fields (MVP)

- `task_id` (string)
  - Stable identifier for traceability (e.g., bead id, or `repomap-core-3wo.execute.architect-1`).
- `objective` (string)
  - One-sentence mission statement.
- `evidence` (array[object])
  - Evidence pointers the child must read. Each entry:
    - `path` (string) — repo-relative path
    - `purpose` (string) — why it matters
    - `required` (boolean) — true if must read
- `success_criteria` (array[string])
  - Concrete, verifiable outcomes.
- `risks` (array[object])
  - Risks the child should watch for. Each entry:
    - `risk` (string)
    - `mitigation` (string)

#### Optional fields

- `handoff_schema` (string)
  - Version tag, recommended: `composability.handoff_packet.v1`.
- `constraints` (array[string])
  - Hard constraints (e.g., “markdown-only outputs”, “no code edits”).
- `deliverables` (array[object])
  - Expected files/artifacts. Each entry:
    - `path` (string)
    - `description` (string)
    - `must_create` (boolean)
- `dependencies` (array[string])
  - Other tasks/contracts the child must align with.
- `notes` (array[string])
  - Compact context not covered above.

### B) `new_task.todos` (string)

The `todos` string SHOULD be a structured markdown checklist.

#### Required characteristics

- Every line is a single atomic action.
- Use canonical statuses: `- [ ]` pending, `- [-]` in progress, `- [x]` done.
- Keep ordering as execution order.

#### Recommended conventions

- Prefix with phase tag when useful (e.g., `DISCOVER:`, `DRAFT:`, `VERIFY:`).
- If a todo produces a file, name it explicitly.

## JSON Example (MVP)

Parent passes the following as the FIRST block in `new_task.message`:

> Note: evidence `path` values in this example are illustrative placeholders for schema demonstration and may not exist in the current repository.

```json
{
  "handoff_schema": "composability.handoff_packet.v1",
  "task_id": "repomap-core-3wo.execute.architect-1",
  "objective": "Draft composability pattern contracts and summary documentation.",
  "evidence": [
    {
      "path": "docs/examples/illustrative/nested-new-task-experiment.md",
      "purpose": "Empirical evidence: nested new_task works; isolation; todos propagation; plain-text returns; cost.",
      "required": true
    },
    {
      "path": "docs/examples/illustrative/orchestrator-composability-analysis.md",
      "purpose": "Architecture analysis + validated heuristic table + cost estimate per nesting level.",
      "required": true
    },
    {
      "path": "docs/examples/illustrative/line-fault-contract-reference.md",
      "purpose": "Reference contract template style (Purpose → Minimum MVP Fields → Example).",
      "required": true
    }
  ],
  "success_criteria": [
    "Create five composability contracts under .kilocode/contracts/composability/",
    "Create a summary research doc tying the contracts together",
    "Include parseable examples for handoff and return formats"
  ],
  "risks": [
    {
      "risk": "Child returns unparseable free-form prose",
      "mitigation": "Require fixed markdown headers and a runtime attestation section"
    },
    {
      "risk": "Nesting multiplies system-prompt overhead cost",
      "mitigation": "Adopt a depth budget and justify escalation"
    }
  ],
  "constraints": [
    "Use fenced code blocks for examples",
    "Cross-reference other contracts where relevant"
  ]
}
```

Example `new_task.todos`:

```markdown
- [ ] Read evidence docs
- [ ] Draft contract: handoff_packet.md
- [ ] Draft contract: return_format.md
- [ ] Draft contract: nesting_depth_policy.md
- [ ] Draft contract: error_propagation.md
- [ ] Draft contract: mode_interaction_heuristic.md
- [ ] Write summary doc: composability-patterns-repomap-core-3wo.md
- [ ] Self-check acceptance criteria coverage
- [ ] Return completion report with runtime attestation
```
