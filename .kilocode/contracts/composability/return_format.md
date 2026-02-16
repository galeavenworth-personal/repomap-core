# Composability Contract: Child → Parent Return Format (via `attempt_completion`)

## Purpose

`attempt_completion` returns a single plain-text `result` string.

This contract defines a **parseable markdown convention** so a parent can reliably:

- determine success/failure status
- extract deliverables and evidence pointers
- confirm runtime/model/mode attestation

## Minimum MVP Fields

The child MUST return markdown containing the following headers (exact spelling):

- `## Status`
- `## Deliverables`
- `## Evidence`
- `## Runtime Attestation`

### `## Status`

Required keys (one per line, `key: value`):

- `state`: `SUCCESS` | `ERROR` | `PARTIAL`
- `summary`: one sentence

Optional keys:

- `error_code`: stable identifier for machine routing (e.g., `E_MISSING_INPUT`, `E_TOOL_FAILURE`)
- `retry_recommended`: `yes` | `no`
- `retry_hint`: short instruction if retry is recommended

### `## Deliverables`

- Bullet list of created/modified files.
- For each file: path + one-line description.

### `## Evidence`

- Bullet list of evidence pointers used (paths, commands, or referenced contracts).
- Include any “proof-like” outputs (e.g., counts, checks, deterministic constraints).

### `## Runtime Attestation`

Required keys:

- `runtime_model_reported`: string
- `runtime_mode_reported`: string
- `files_created`: array-like bullet list (paths)

Optional keys:

- `limitations`: one bullet list

## Markdown Example (MVP)

```markdown
## Status
state: SUCCESS
summary: Created composability contracts and a summary document; formats include parseable examples.

## Deliverables
- .kilocode/contracts/composability/handoff_packet.md — parent→child message/todos schema + JSON example
- .kilocode/contracts/composability/return_format.md — child→parent parseable markdown return convention

## Evidence
- docs/research/nested-new-task-experiment-2026-02-15.md — nesting works, isolation, todos propagation, plain-text return
- docs/research/orchestrator-composability-analysis-2026-02-15.md — validated heuristic table + $/depth estimate

## Runtime Attestation
runtime_model_reported: openai/gpt-5.2
runtime_mode_reported: architect
files_created:
- .kilocode/contracts/composability/handoff_packet.md
- .kilocode/contracts/composability/return_format.md
```
