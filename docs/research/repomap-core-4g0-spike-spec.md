# Spike Spec: Custom Mode `new_task` Entitlement + Isolation

## Task
repomap-core-4g0 — Spike specification to empirically validate whether custom modes can spawn subtasks via [`functions.new_task()`](functions.new_task:1) with Orchestrator-style isolation.

## Date
2026-02-15

## Runtime Attestation (spec authoring run)
- `runtime_model_reported`: openai/gpt-5.2
- `runtime_mode_reported`: architect

## Scope / Non-Scope

### In scope
- Define custom mode variants for `.kilocodemodes` that will be used later to test [`functions.new_task()`](functions.new_task:1).
- Define manual procedures, observations, and pass/fail criteria for:
  - Q1: custom-mode access to `new_task`
  - Q2: which tool group gates `new_task`
  - Q3: context isolation parity
  - Q4: summary-only return parity

### Out of scope (explicit)
- Do **not** modify [`.kilocodemodes`](.kilocodemodes:1) in this task.
- Do **not** execute the spike in this task.

## Background / Why this spike exists
The specialized orchestrator plan treats custom-mode access to [`functions.new_task()`](functions.new_task:1) as a **critical gate** that blocks the entire plan if false. See Phase 0 and the CRITICAL assumption: [`plans/specialized-orchestrator-modes.md`](plans/specialized-orchestrator-modes.md:91), [`plans/specialized-orchestrator-modes.md`](plans/specialized-orchestrator-modes.md:211).

## High-level hypotheses
- **H1 (grantable):** `new_task` is available to custom modes when an appropriate tool group is present.
- **H2 (reserved):** `new_task` is reserved for the built-in Orchestrator and cannot be granted via custom mode groups.
- **H3 (isolation parity):** If custom modes can invoke `new_task`, the subtasks will be isolated and return summary-only (same semantics asserted in [`orchestrate-start-task.md`](.kilocode/workflows/orchestrate-start-task.md:120)).

## Canary tokens (for isolation / leakage detection)
- Allowed token: `CANARY_ALLOWED_4g0`
- Forbidden token: `CANARY_FORBIDDEN_4g0`

### Intended meaning
- The child subtask is instructed to **emit** `CANARY_ALLOWED_4g0` in its final completion payload.
- The child subtask is instructed to **emit** `CANARY_FORBIDDEN_4g0` *only* in a non-final, non-completion message (an “intermediate scratch note”), and to ensure it does not appear in its completion output.
- If the parent receives anything beyond a summary-only completion payload, the forbidden token is more likely to leak into parent-visible output.

### Notes / limitations
- If the platform suppresses intermediate child messages by design, the forbidden-token leakage check may produce a false negative (i.e., leak exists but intermediate messages are still hidden).
- This is acceptable: the primary goal is to detect *practical* isolation degradation (parent context pollution), not to prove theoretical properties.

## Custom mode variants (to be added to `.kilocodemodes` later)

### Formatting note
- [`.kilocodemodes`](.kilocodemodes:1) is YAML-like. This spec provides **JSON-form** “exact entries” (as requested) that should be translated into the YAML list under `customModes:` for the actual spike execution.

---

### Variant A: Full grants (control for maximum entitlement)
**Purpose:** Maximize chance that `new_task` is available under some existing group.

**Hypothesis:** If `new_task` is grantable via any of (`read`, `edit`, `command`, `browser`, `mcp`), Variant A should succeed.

**Proposed `.kilocodemodes` JSON entry:**
```json
{
  "slug": "spike-orchestrator-a",
  "name": "Spike Orchestrator A (All Grants)",
  "roleDefinition": "Spike harness. Your only job is to test whether this mode can call new_task, and whether subtasks are isolated + summary-only.",
  "groups": ["read", "edit", "command", "browser", "mcp"],
  "fileRegex": "\\.(md|txt|json)$",
  "customInstructions": "Run the spike procedure in the spec at docs/research/repomap-core-4g0-spike-spec.md. First, attempt a new_task to architect mode using the child payload verbatim. Record whether tool call is permitted and what returns. Do not edit files other than the spike variants during the spike run.",
  "source": "project"
}
```

**Test procedure (manual):**
1. Add the entry above into [`.kilocodemodes`](.kilocodemodes:1) under `customModes:`.
2. Reload Kilo/VSCode so the new mode appears.
3. Switch to `spike-orchestrator-a`.
4. In the parent (this custom mode), issue a tool call to [`functions.new_task()`](functions.new_task:1) with:
   - `mode="architect"`
   - `message` = the child task payload in the “Child payload (verbatim)” section below.
   - `todos=null`
5. Observe what happens:
   - Does tool invocation fail immediately (tool not present / permission denied)?
   - Does a child task start?
   - What does the parent receive when the child completes?

**Pass/fail criteria:**
- **PASS (Q1):** parent successfully invokes [`functions.new_task()`](functions.new_task:1) and a child task starts.
- **FAIL (Q1):** tool is unavailable OR permission denied OR child task cannot be created.

**What to record:**
- Exact error text (if any)
- Whether the UI indicates a child task was created
- Parent-visible child output shape: summary-only vs full transcript
- Presence/absence of canary tokens in parent-visible output

---

### Variant B: Minimal grants (negative control)
**Purpose:** Control variant to demonstrate whether entitlement is group-coupled.

**Hypothesis:** If `new_task` requires a non-`read` group, Variant B should fail.

**Proposed `.kilocodemodes` JSON entry:**
```json
{
  "slug": "spike-orchestrator-b",
  "name": "Spike Orchestrator B (Read Only)",
  "roleDefinition": "Spike harness (negative control). Attempt to call new_task and record the outcome.",
  "groups": ["read"],
  "fileRegex": "\\.(md|txt|json)$",
  "customInstructions": "Attempt the exact same new_task call as Variant A. Record whether the tool exists and is permitted.",
  "source": "project"
}
```

**Pass/fail criteria:**
- **Expected outcome:** FAIL (tool unavailable or permission denied).
- **If PASS:** suggests `new_task` may be in `read` or universally granted (unexpected; update findings).

---

### Variant C: Read + command (intermediate narrowing)
**Purpose:** Distinguish whether entitlement may be gated by `command` rather than `read`.

**Hypothesis:** If Variant A succeeds and Variant B fails:
- Variant C **PASS** implies `new_task` is likely gated by `command` (not `read`).
- Variant C **FAIL** implies `new_task` is gated by a different group (e.g., `mcp`, `browser`, or `edit`) or is reserved.

**Proposed `.kilocodemodes` JSON entry:**
```json
{
  "slug": "spike-orchestrator-c",
  "name": "Spike Orchestrator C (Read + Command)",
  "roleDefinition": "Spike harness (group narrowing). Attempt to call new_task and record the outcome.",
  "groups": ["read", "command"],
  "fileRegex": "\\.(md|txt|json)$",
  "customInstructions": "Attempt the exact same new_task call as Variant A. Record whether it succeeds.",
  "source": "project"
}
```

## Child payload (verbatim)
Use this `message` content when calling [`functions.new_task()`](functions.new_task:1). The child should be spawned in `architect` mode.

```markdown
# Child Spike Task: Verify Isolation + Summary-Only Return

## Required canary behavior
- In one **intermediate** (non-final) message, output exactly: CANARY_FORBIDDEN_4g0
  - This is the deliberate leak-sentinel. It must NOT appear in attempt_completion.
- In your final attempt_completion output, include exactly: CANARY_ALLOWED_4g0
- Your attempt_completion output must NOT contain: CANARY_FORBIDDEN_4g0

## Work
1. Immediately output an intermediate note containing: CANARY_FORBIDDEN_4g0
2. Then finish the task via attempt_completion with a *short* structured summary that includes CANARY_ALLOWED_4g0.

## Output format (attempt_completion)
- runtime_model_reported: <from environment_details>
- runtime_mode_reported: <mode slug>
- canary_allowed_present: YES
- canary_forbidden_present: NO
- notes: <1-3 bullets>
```

## Observations and checks (performed in the parent)

### Tool access checks (Q1)
- Does the parent custom mode have access to [`functions.new_task()`](functions.new_task:1)?
  - Evidence: tool call either executes or errors.

### Group→tool coupling checks (Q2)
Record results for A/B/C then use the inference table below.

**Inference table:**
| A (all) | B (read) | C (read+command) | Most likely interpretation |
|---:|---:|---:|---|
| FAIL | (n/a) | (n/a) | `new_task` not grantable to custom modes via these groups, or reserved for built-in Orchestrator |
| PASS | PASS | PASS | `new_task` is in `read` or universally available to custom modes |
| PASS | FAIL | PASS | `new_task` is gated by `command` (not `read`) |
| PASS | FAIL | FAIL | `new_task` gated by one of (`edit`, `browser`, `mcp`) or reserved; run follow-on bisection |

### Isolation checks (Q3)
- Does the parent see only a completion summary, or does it receive intermediate child messages / full transcript?
- Does the parent-visible output contain `CANARY_FORBIDDEN_4g0`?
  - **Isolation PASS (practical):** forbidden token absent; only summary visible.
  - **Isolation FAIL:** forbidden token appears in parent-visible output or full transcript appears.

### Summary-only return checks (Q4)
- Does the platform return:
  - only the child’s `attempt_completion` payload, or
  - the child’s full conversation / intermediate messages?
- Compare against the intended workflow semantics (“Parent receives summary only”) asserted in [`orchestrate-start-task.md`](.kilocode/workflows/orchestrate-start-task.md:120).

## Follow-on (optional) bisection plan if Q2 remains ambiguous
If Variant A passes but Variant C fails, add additional variants to isolate the gating group:
- `read + mcp`
- `read + browser`
- `read + edit`

Run the same parent→child payload and apply the same inference logic.

## Reporting template (to be filled during execution)
When the spike is executed later, record results in a single block (copy/paste):

```markdown
# Spike Run Report — repomap-core-4g0

## Parent runtime attestation
- runtime_model_reported: <...>
- runtime_mode_reported: <...>

## Results by variant
- Variant A (all): PASS|FAIL — <error or evidence>
- Variant B (read): PASS|FAIL — <error or evidence>
- Variant C (read+command): PASS|FAIL — <error or evidence>

## Inference
- Q1 (custom mode can call new_task): PASS|FAIL
- Q2 (gating group): <best inference + confidence>
- Q3 (isolation parity): PASS|FAIL|INCONCLUSIVE
- Q4 (summary-only return): PASS|FAIL|INCONCLUSIVE

## Notes
- <unexpected behavior>
- <screenshots/log pointers>
```
