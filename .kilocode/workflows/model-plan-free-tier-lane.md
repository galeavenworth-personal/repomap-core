---
description: Helper workflow to record an operator-selected Free-Tier Lane model plan (ChatGPT Account) into orchestrator handoff packets.
auto_execution_mode: 3
---

# Model Plan: Free-Tier Lane (ChatGPT Account)

**Purpose:** Make model/account selection a first-class, replayable artifact (even though the agent cannot switch models/accounts programmatically).

**When to use:**
- At the start of [`/orchestrate-start-task`](./orchestrate-start-task.md)
- Before spawning execution subtasks in [`/orchestrate-execute-task`](./orchestrate-execute-task.md)

**Why:** The agent cannot reliably inspect or change the UI provider/account dropdown (e.g., “ChatGPT Account”). The enforceable invariant is runtime reporting (`environment_details`). A Model Plan is optional and operator-declared.

---

## Step 0: Runtime report (MANDATORY)

At the start of the parent task and at the end of each subtask, include:

- `runtime_model_reported` (from `environment_details`)
- `runtime_mode_reported` (mode slug)

---

## Step 1: Operator selects the Free-Tier Lane model/account in the UI

Operator sets the UI account/model selections, then uses the default routing from [`FREE_TIER_LANE.md`](../../docs/reference/FREE_TIER_LANE.md) as the declared plan to paste into the handoff packet.

### Optional: Declared Model Plan (operator pastes into the handoff packet)

```json
{
  "model_plan_version": "v1",
  "billing_policy": "free-tier-lane-first",
  "accounts": {
    "openai_free": "ChatGPT Account",
    "paid_fallback": "<optional>"
  },
  "routing": {
    "orchestrator": {"account": "openai_free", "model": "gpt-5.2", "setting": "high"},
    "architect": {"account": "openai_free", "model": "gpt-5.2", "setting": "high"},
    "code": {"account": "openai_free", "model": "gpt-5.1-codex-max", "setting": "default"},
    "tool_strict": {"account": "openai_free", "model": "gpt-5.2", "setting": "default"}
  }
}
```

---

## Step 2: Operator attestation (MANDATORY)

Because the agent cannot read or change the UI dropdown, the operator must ensure:
- Account selector is set to `ChatGPT Account`
- Model selector matches the plan for the active mode/subtask

---

## Step 3: Runtime attestation (MANDATORY)

Each subtask MUST report:
- `runtime_model_reported`: value from `environment_details`
- `runtime_mode_reported`: mode slug (e.g., `code`, `architect`, `orchestrator`)
- `model_plan_match`: `MATCH`/`MISMATCH`

If `MISMATCH`: STOP and correct UI selection.

---

## References

- Contract: [`FREE_TIER_LANE.md`](../../docs/reference/FREE_TIER_LANE.md)
- Schema: [`MODEL_PLAN_SCHEMA.md`](../../docs/reference/MODEL_PLAN_SCHEMA.md)
