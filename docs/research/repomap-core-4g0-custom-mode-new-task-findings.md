# Research Findings: Custom Mode `new_task` Access

## Task
repomap-core-4g0 — Research gate for specialized orchestrator modes plan

## Date
2026-02-15

## Runtime Attestation (empirical run)
- `runtime_model_reported`: anthropic/claude-opus-4.6
- `runtime_mode_reported`: orchestrator

## Empirical Results

Three tests were conducted from Orchestrator mode.

| Test | Tool | Target Mode | Result |
|------|------|-------------|--------|
| 1 | `switch_mode` | `spike-full-grants` (newly added custom) | **Invalid mode** |
| 2 | `new_task` | `spike-full-grants` (newly added custom) | **Invalid mode** |
| 3 | `switch_mode` | `docs-specialist` (pre-existing custom) | **Invalid mode** |

**Key finding:** Both `switch_mode` and `new_task` only accept built-in mode slugs (`architect`, `code`, `ask`, `debug`, `orchestrator`, `review`). Custom modes defined in `.kilocodemodes` are not recognized by these programmatic APIs.

## Updated Evidence Matrix

| Question | Prior Confidence | New Confidence | Status | Updated conclusion |
|----------|------------------|----------------|--------|--------------------|
| Q1: Can custom modes access `new_task`? | Low | High | **Answered** | **No**. Custom mode slugs are rejected at API validation with `Invalid mode`. |
| Q2: Which tool group contains `new_task`? | Medium/Low | High | **Moot** | Group mapping is not the gate. Rejection occurs before tool-group entitlements are relevant. |
| Q3: Context isolation parity with built-in Orchestrator? | Medium | Low | **Untestable in this spike** | Could not create custom-mode subtasks due to slug rejection. |
| Q4: Summary-only return for custom-mode caller? | Medium-Low (custom caller) | Low | **Untestable in this spike** | Could not observe return contract for custom-mode parent due to slug rejection. |

## Core Questions & Conclusions

### Q1: Can custom modes access `new_task`?
**Current confidence:** High

**Conclusion:** DISPROVEN. Custom modes cannot be spawned as subtasks via `new_task`, and cannot be switched to via `switch_mode`.

**Evidence:**
- `new_task(mode="spike-full-grants", ...)` returned `Invalid mode`.
- `switch_mode(mode_slug="spike-full-grants", ...)` returned `Invalid mode`.
- `switch_mode(mode_slug="docs-specialist", ...)` also returned `Invalid mode`, showing this is not limited to newly-added spike entries.

---

### Q2: Which tool group contains `new_task`?
**Current confidence:** High

**Conclusion:** MOOT for this decision gate. Tool groups are not the blocking mechanism.

**Evidence:**
- Mode slug validation failed before any observable differentiation by `groups:` configuration.

---

### Q3: Context isolation parity with built-in Orchestrator?
**Current confidence:** Low

**Conclusion:** UNTESTABLE from this spike.

**Evidence:**
- No custom-mode subtask could be created due to `Invalid mode`, so no isolation behavior could be measured.

---

### Q4: Summary-only return for custom-mode caller?
**Current confidence:** Low

**Conclusion:** UNTESTABLE from this spike.

**Evidence:**
- No successful custom-mode parent→child execution path was available to inspect return semantics.

## Remaining Open Questions

Secondary question (not covered by this spike):

- If a user manually activates a custom mode via the Kilo UI mode switcher (not via API), can that custom mode call `new_task` targeting built-in modes?

If yes, custom modes may still be viable as manual “entry points” that fan out to built-in-mode subtasks.

## Implication for Parent Plan

The “specialized orchestrator modes” approach that assumes programmatic spawning/switching into custom modes is not feasible with current APIs. Planning should pivot to enhancing the single built-in Orchestrator workflow model.

## Spike Test Reference
See: [`docs/research/repomap-core-4g0-spike-spec.md`](docs/research/repomap-core-4g0-spike-spec.md:1)
