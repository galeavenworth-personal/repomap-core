# Composability Contract: Error Propagation Across Nested Tasks

## Purpose

Define how failures propagate across nesting levels when using `new_task`.

Core pattern:

> child fails → returns error status → parent decides retry / abort / escalate

Because children return only plain text, error propagation must be expressed through a **parseable return format**.

## Minimum MVP Fields

- `error_return_format` (string): required parseable headers and keys
- `retry_policy` (object): bounded retries per level
- `escalation_rules` (array[string]): when to switch strategy or terminate

## Error Return Format (MVP)

Child MUST follow the return-format contract and set:

- `## Status`
  - `state: ERROR`
  - `error_code: ...` (recommended)
  - `retry_recommended: yes|no` (**required when `state: ERROR`**)
  - `retry_hint: ...` (recommended when `retry_recommended: yes`)

For non-`ERROR` states (`SUCCESS`, `PARTIAL`), `retry_recommended` is optional and may be omitted.

## Retry Policy (MVP)

Definitions:

- **attempt**: one execution of the child task.
- **retry**: an additional attempt after an initial failed attempt.
- Formula: `total_attempts = 1 + max_retries`.

- Child retries: **0 by default**
  - Rationale: the parent owns orchestration and should decide whether to rerun.

- Parent retries a child: **max_retries = 1** by default (so `total_attempts = 2`) unless:
  - the parent has applied a material mitigation (e.g., changed inputs, reduced scope, corrected constraints)
  - then allow **max_retries = 2** (so `total_attempts = 3`)

- Escalation after retries:
  - escalate to a different mode (e.g., fitter for line faults)
  - or abort the chain with a final error report to the human

## Escalation Patterns

### Pattern: Specialist failure

- Specialist returns `state: ERROR`.
- Parent evaluates:
  - is the error due to missing input?
  - is it deterministic and fixable by changing the handoff?
- Parent chooses:
  - retry (once) with amended handoff
  - abort and report

### Pattern: Line fault / non-deterministic gate

- Parent routes to fitter with the line-fault contract.
- Fitter returns restoration contract.
- Parent retries the blocked station once.

## Markdown Example (Error)

```markdown
## Status
state: ERROR
summary: Could not complete deliverables due to missing required evidence files.
error_code: E_MISSING_EVIDENCE
retry_recommended: yes
retry_hint: Include paths to evidence docs in the handoff packet and ensure they exist in workspace.

## Deliverables
- (none)

## Evidence
- (none)

## Runtime Attestation
runtime_model_reported: openai/gpt-5.2
runtime_mode_reported: architect
files_created:
- (none)
files_modified:
- (none)
```
