---
description: Fitter runbook for restoring deterministic, bounded quality-gate execution (line health).
auto_execution_mode: 3
punch_card: fitter-line-health
---

# Fitter Workflow: Line Health (Fit → Fault → Restoration)

**Purpose:** Fitter is the maintenance craftsperson for the fabrication line: it keeps
the *workflow/runner layer* healthy so gates complete **deterministically** and **within budgets**.

This workflow defines how a Fitter receives a **Line Fault Contract**, diagnoses the
failure mode, and produces a **Restoration Contract** that allows Orchestrator to retry
the blocked station **in a bounded way**.

**Punch Card:** `fitter-line-health` (5 rows, 4 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Scope and Constraints

Aligned with the authoritative plan in [`.beads/implementation-guides/fitter-line-health-implementation-plan.md`](../../.beads/implementation-guides/fitter-line-health-implementation-plan.md):

- **CI is the source of truth** for canonical gates and invocations.
- **Deterministic completion:** hangs/stalls must become explicit, bounded fault states.
- **Taste neutrality:** do not propose toolchain migrations.
- **Separation of concerns:** Fitter fixes runner/workflow alignment; feature agents fix product code.
- **Context isolation:** Orchestrator ↔ Fitter handoffs use small contracts (payloads) only.

## Inputs

### Required

1. **Line Fault Contract** (template):
   - [`.kilocode/contracts/line_health/line_fault_contract.md`](../contracts/line_health/line_fault_contract.md)

2. **Fit Profile** (or budgets) for the affected gate(s)
    - MVP: can be "budgets" pasted into the Fitter message.
    - Later phases: a persisted Fit Profile artifact.

#### Canonical Fit Profile (repomap-core default gates)

Use these as the **starting** budgets for repomap-core's offline quality gates.

| gate_id | command route | invocation | timeout_seconds | stall_seconds | tail_lines |
|---|---|---|---:|---:|---:|
| `ruff-format` | `format ruff` → [`commands.format_ruff`](../commands.toml) | `.venv/bin/python -m ruff format --check .` | 60 | 30 | 50 |
| `ruff-check` | `check ruff` → [`commands.check_ruff`](../commands.toml) | `.venv/bin/python -m ruff check .` | 90 | 30 | 50 |
| `mypy-src` | `check mypy` → [`commands.check_mypy`](../commands.toml) | `.venv/bin/python -m mypy src` | 120 | 30 | 50 |
| `pytest` | `test pytest` → [`commands.test_pytest`](../commands.toml) | `.venv/bin/python -m pytest -q` | 180 | 30 | 50 |

Notes:
- Prefer **stall_seconds=30** by default; if a gate is known to be output-sparse (e.g., `pytest -q`), mitigation can be to raise stall budget or increase verbosity.
- Prefer **small, explicit** budgets over large defaults. If budgets must increase, record rationale and keep within a strict maximum.

### Optional

- **Fit Manifest** evidence pointers (CI/config file paths) if available.
- Pointers to any captured logs/artifacts on disk (paths only; do not paste full logs).

## Actions (Fitter Procedure)

### Step 1: Triage the stop reason

Use `stop_reason` from the Line Fault Contract:

- `timeout`: wall-clock budget exceeded
- `stall`: no-output budget exceeded (command appears hung)
- `env_missing`: missing dependency, missing interpreter, missing env var, missing credentials
- `ambiguous`: couldn't classify within bounded evidence

### Step 2: Apply workflow-layer mitigation (no product code changes)

Mitigations MUST remain in the runner/workflow layer. Examples (choose only what is necessary):

- **Budget adjustment** (Fit Profile):
  - Increase wall-clock timeout or no-output/stall budget **within a strict maximum**.
  - Record rationale (e.g., first run on cold cache).

- **Invocation adjustment** (still CI-aligned):
  - Prefer verbosity options that surface progress (reduces false stall detection).
  - Narrow the scope only if it preserves the gate's meaning for the current workflow lane (e.g., targeted slice as part of calibration lanes).

- **Environment alignment** (non-secret):
  - Document required env vars and safe defaults.
  - If secrets are required, mark as **RED** (cannot fit safely) and stop.

### Step 3: Verify restoration (bounded)

Run the same gate invocation using the updated budgets/invocation.

> 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
> Composite: `format_ruff` → `check_ruff` → `check_mypy` → `test_pytest`
> All run through `bounded_gate.py` with receipt tracking.

Or run individual gates as needed:

> 📌 `format ruff` → [`commands.format_ruff`](../commands.toml)
> 📌 `check ruff` → [`commands.check_ruff`](../commands.toml)
> 📌 `check mypy` → [`commands.check_mypy`](../commands.toml)
> 📌 `test pytest` → [`commands.test_pytest`](../commands.toml)

Capture **only**:
  - whether it completed
  - elapsed time
  - last output lines (tail)

### Step 4: Produce a Restoration Contract

Fill the Restoration Contract template:
- [`.kilocode/contracts/line_health/restoration_contract.md`](../contracts/line_health/restoration_contract.md)

## Outputs

### Required

1. **Restoration Contract** (completed payload)
2. **Updated Fit Profile notes** (human-readable summary of what changed and why)

### Outcome states

Use the plan's outcome semantics:

- **GREEN:** fitted + verified; Orchestrator may proceed.
- **YELLOW:** partially fitted or ambiguous; requires operator decision; Orchestrator should not "power through."
- **RED:** cannot fit safely (e.g., requires secrets, interactive steps, missing hard deps).

## Bounded Retry Policy (Contract-Level)

- Orchestrator should attempt at most **1 retry** after the first Restoration Contract.
- A second retry is allowed only if the Restoration Contract materially changes the mitigation (e.g., budgets adjusted, invocation corrected).
- If the gate still faults after max retries: STOP with YELLOW/RED and escalate (operator decision or feature work).

## Context-Bloat Guardrails (Non-Negotiable)

**Fitter must operate on contracts and pointers, not raw logs.**

- `last_output_lines` MUST be a tail (recommended **<= 50 lines**).
- Prefer **file pointers** and **commands** over pasted content.
- If additional evidence is required:
  - request a *new* Line Fault Contract with a slightly larger tail (bounded), or
  - request a pointer to a log file path on disk.
- Do not paste:
  - full CI logs
  - full test output
  - entire `pip freeze` / environment dumps

## Orchestrator Interface (What Fitter Expects to Receive)

A Fitter subtask message should contain:

- Line Fault Contract payload (JSON)
- Fit Profile budgets (or "unknown")
- Any evidence pointers (file paths)
- Retry count so far (0, 1)

The Fitter is dispatched via:

> 📌 `dispatch fitter` → [`commands.dispatch_fitter`](../commands.toml)
> Resolves to: `new_task` with `target_mode=fitter`
> Contract: [`.kilocode/contracts/line_health/line_fault_contract.md`](../contracts/line_health/line_fault_contract.md)

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id} --bead-id {bead_id}`

> 🚪 `checkpoint punch-card {task_id} fitter-line-health` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} fitter-line-health`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the Restoration Contract.

---

## Related Workflows

- [`/start-task`](./start-task.md) — Task preparation phase
- [`/execute-task`](./execute-task.md) — Task execution phase
- [`/fix-ci`](./fix-ci.md) — Quality gate fixes (feature-agent side)

## Related Skills

- [`sequential-thinking-default`](../skills/sequential-thinking-default/SKILL.md) — Multi-step reasoning

## Philosophy

Fitter keeps the fabrication line healthy. Every gate invocation maps to a `commands.toml`
route. Every budget has a ceiling. Every restoration produces a contract. Structure
discipline: from fault receipt to mitigation to bounded verification — every step is
traceable and reproducible.
