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

Conditional keys:

- `error_code`: stable identifier for machine routing (e.g., `E_MISSING_INPUT`, `E_TOOL_FAILURE`)
- `retry_recommended`: `yes` | `no` (**required when `state: ERROR`**; optional otherwise)
- `retry_hint`: short instruction if retry is recommended

Guidance by state:

- `state: SUCCESS`: work completed; omit error-oriented keys unless needed for edge cases.
- `state: ERROR`: include failure details; `retry_recommended` is mandatory.
- `state: PARTIAL`: include completed subset plus explicit limitations and next-step guidance.

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
- `files_created`: list key followed by one repo-relative path per bullet line (`- path`)
- `files_modified`: list key followed by one repo-relative path per bullet line (`- path`)

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
- docs/examples/illustrative/nested-new-task-experiment.md — illustrative placeholder path (for format demonstration only)
- docs/examples/illustrative/orchestrator-composability-analysis.md — illustrative placeholder path (for format demonstration only)

## Runtime Attestation
runtime_model_reported: openai/gpt-5.2
runtime_mode_reported: architect
files_created:
- .kilocode/contracts/composability/handoff_packet.md
- .kilocode/contracts/composability/return_format.md
files_modified:
- .kilocode/contracts/composability/error_propagation.md
```

Notes:

- Paths in `## Evidence` examples are illustrative placeholders and may not exist in the current repository.
- Paths in runtime attestation lists MUST be repo-relative.

## Markdown Example (PARTIAL)

```markdown
## Status
state: PARTIAL
summary: Updated return-format schema and examples, but deferred depth-policy revisions due to pending review alignment.

## Deliverables
- .kilocode/contracts/composability/return_format.md — clarified status semantics and attestation serialization

## Evidence
- docs/examples/illustrative/review-ledger.md — illustrative placeholder path (for format demonstration only)

## Runtime Attestation
runtime_model_reported: openai/gpt-5.2
runtime_mode_reported: architect
files_created:
- (none)
files_modified:
- .kilocode/contracts/composability/return_format.md
limitations:
- Deferred dependent contract changes pending cross-file consistency pass.
```
