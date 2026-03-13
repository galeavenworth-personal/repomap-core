# OVM.6 — Temporal Consolidation Evaluation for `factory-dispatch`

## 1. Executive Summary

This spec evaluates whether Temporal SDK patterns already present in `daemon/src/temporal/` can replace the hand-rolled session lifecycle in `daemon/src/infra/factory-dispatch.ts`.

Recommendation: **Option B (Selective Extraction)**. Converge shared Kilo HTTP/session lifecycle logic first, keep CLI-facing behavior stable, then reassess full workflow-backed replacement once contract parity is explicit and tested.

## 2. Current State: `factory-dispatch.ts`

### Scope and entrypoints

- `daemon/src/infra/factory-dispatch.ts` is **866 lines** and acts as a CLI-oriented orchestrator.
- Single caller: `daemon/src/infra/factory-dispatch.cli.ts`, via `runDispatch(config: FactoryDispatchConfig): Promise<ExitCodeValue>` (`factory-dispatch.ts:622`).
- Shell bootstrap: `.kilocode/tools/factory_dispatch.sh` delegates to the TypeScript CLI.

### Hand-rolled lifecycle phases

The lifecycle implemented by `runDispatch` is:

1. **preflight** (`preflight`)
2. **build prompt** (`buildPromptPayload`)
3. **create session** (`createSession`)
4. **inject session/card context** (`injectSessionId`, `resolveCardExitPrompt`/`injectCardExitPrompt`)
5. **dispatch prompt** (`dispatchPrompt`)
6. **optional early exit** (`--no-monitor`)
7. **monitor** (`monitorSession`)
8. **extract result** (`extractResult`)
9. **optional audit** (`runPostSessionAudit`, best-effort)
10. **output** (plain text or `DispatchResult` JSON)

### HTTP contract used by dispatch path

- `GET /session` (health/list)
- `POST /session` (create)
- `POST /session/{id}/prompt_async` (dispatch)
- `GET /session/{id}/children` (child discovery)
- `GET /session/{id}/message` (monitor/result extraction)

### Exit code contract

`ExitCode` (`factory-dispatch.ts:157-164`):

- `0` = success
- `1` = usage
- `2` = health
- `3` = session creation
- `4` = prompt dispatch
- `5` = timeout
- `6` = no response

### Output contract

- `DispatchResult` (`factory-dispatch.ts:145`):
  `{ session_id, mode, title, children, elapsed_seconds, result, child_session_ids, audit? }`
- `AuditResult` (`factory-dispatch.ts:137`):
  `{ cardId, status: "pass"|"fail", missing, violations }`

### Monitoring and failure behavior

- Polling-based completion checks (`monitorSession`) with parent idle confirmations and child idle checks.
- Child handling is parent + direct children checks, not recursive active-leaf semantics.
- Timeout returns `ExitCode.TIMEOUT` and logs that the session may still be running; no explicit abort call is issued on timeout.
- Error handling is mixed:
  - hard failures map to explicit exit codes (preflight/create/dispatch/timeout/no-response)
  - some reads degrade silently (`fetchChildren`/`fetchMessages` return empty on failure)
  - post-session audit is best-effort and non-fatal.

### Shared utility surface currently exported

- `checkPort` (`factory-dispatch.ts:185`)
- `isPm2AppOnline` (`factory-dispatch.ts:208`)

Both are imported by `daemon/src/infra/stack-manager.ts` (`stack-manager.ts:24-26`).

## 3. Current State: Temporal Integration

### 3a. `agentTaskWorkflow` (`workflows.ts`, 414 lines)

`daemon/src/temporal/workflows.ts` defines a durable workflow with explicit orchestration phases:

- `initializing`
- `health_check`
- `creating_session`
- `sending_prompt`
- `agent_working`
- `budget_check`
- `validating`
- `completed`

Error/terminal variants include `failed`, `aborted`, `validation_failed`, and `budget_exceeded` in the status/result model.

Key Temporal patterns already implemented:

- **Signal/query model**
  - `abortSignal`
  - `progressSignal`
  - `statusQuery`
- **Cancellation-safe cleanup**
  - `abortSession` called in `CancellationScope.nonCancellable(...)` on cancellation/failure paths.
- **Post-completion governance**
  - budget check (`checkCostBudget`)
  - punch-card validation (`validateTaskPunchCard`)
  - session audit (`runSessionAudit`)
- **Typed contract**
  - `AgentTaskInput`
  - `AgentTaskStatus`
  - `AgentTaskResult`

### 3b. Activities (`activities.ts`, 771 lines)

`daemon/src/temporal/activities.ts` contains reusable I/O activities:

- `healthCheck`
- `createSession`
- `abortSession`
- `sendPrompt`
- `pollUntilDone`
- `checkCostBudget`
- `runSessionAudit`
- `validateTaskPunchCard`

Notable behavior differences versus factory-dispatch monitoring:

- Recursive active-leaf discovery (`findActiveLeaf`) and recursive tree aggregation (`getTreeStats`).
- Heartbeat-based progress reporting to Temporal (`heartbeat(...)`) with rich payload.
- Explicit timeout cleanup: `pollUntilDone` calls `abortSession` before throwing timeout error.
- Tree-aware metrics (cost/tokens/parts/tool calls/child count), not just parent/direct child checks.

### 3c. Foreman (`foreman.workflows.ts` 733 lines, `foreman.activities.ts` 619 lines)

The foreman layer demonstrates mature Temporal control-loop patterns:

- Long-lived control loop with `continueAsNew`.
- Child orchestration via `startChild(agentTaskWorkflow)`.
- Bounded retries with persistent retry ledger and backoff windows.
- Health gates as activities (`checkStackHealth`).
- Escalation behavior when retries are exhausted.

Note: Foreman also has a **different** `DispatchResult` union in `daemon/src/temporal/foreman.types.ts:200` (not the same type as `factory-dispatch` JSON output).

## 4. Gap Analysis: `factory-dispatch` vs Temporal

| Capability | `factory-dispatch` | Temporal (`agentTaskWorkflow`) |
|---|---|---|
| State durability | None (in-memory polling) | Workflow history |
| Cleanup on failure | None | Explicit abort in `nonCancellable` scope |
| Retry policy | Manual, limited | Configurable per-activity |
| Progress visibility | Console logs | Signals + queries |
| Child session tracking | Flat parent/children | Recursive tree traversal |
| Timeout handling | Returns error, session may still run | Abort + cleanup before error |
| Post-completion validation | Best-effort audit | First-class workflow steps |
| Prompt input | JSON payload or plain text | Plain text only (`AgentTaskInput.prompt`) |
| Result extraction | Heuristic assistant text extraction | Metrics/status-oriented result (`AgentTaskResult`) |
| CLI output formatting | `DispatchResult` JSON / console | Not present |

Interpretation:

- Temporal is stronger for durability, cleanup, observability, and post-run governance.
- `factory-dispatch` is stronger for current CLI UX contracts (exit codes + textual result extraction + JSON shape).
- Consolidation must reconcile **transport/output contract** differences, not only lifecycle mechanics.

## 5. Consolidation Options

### Option A: Full Replacement

Replace `runDispatch()` internals with Temporal invocation of `agentTaskWorkflow`; keep CLI as a thin client translating workflow result/status to existing `DispatchResult` and exit code semantics.

Pros:

- Maximum logic consolidation and durability.
- Eliminates duplicated lifecycle implementation.

Cons:

- Highest migration risk due to contract mismatch (prompt payload flexibility, result extraction behavior, exit code mapping details).
- Requires introducing Temporal client invocation path into CLI flow and robust translation layer.

### Option B: Selective Extraction

Extract shared concerns (Kilo HTTP client, session management, monitor semantics, result extraction helpers where valid) into common modules used by both `factory-dispatch` and Temporal activities.

Pros:

- Reduces drift while preserving current CLI behavior.
- Lower risk, incremental migration path.
- Supports ovm.7 decomposition goals naturally.

Cons:

- Leaves two orchestration surfaces for a period.
- Requires discipline to avoid re-divergence during transition.

### Option C: Status Quo with Shared Utilities

Minimal change: extract only `checkPort`/`isPm2AppOnline` to shared infra and otherwise keep dispatch paths separate.

Pros:

- Very low risk and effort.

Cons:

- Does not address lifecycle duplication or divergent semantics.
- Delays durability/cleanup gains where dispatch is still hand-rolled.

## 6. Recommendation

Recommend **Option B (Selective Extraction)**.

Rationale:

- It captures near-term value (shared clients/monitor/session abstractions) without breaking CLI contracts currently relied on by tooling and operators.
- It creates a controlled runway toward Option A, where full replacement can happen after explicit compatibility adapters are validated.
- It aligns with existing Temporal strength (durability + governance) while respecting current factory-dispatch user-facing behavior.

## 7. Migration Boundaries and Sequencing

### Relationship to ovm.7 (split `factory-dispatch` and isolate Kilo client)

- ovm.7 should happen **first** (or as part of this effort) because consolidation requires a stable shared Kilo client/session abstraction.
- Without this split, replacement/extraction work increases coupling and regression risk.

### Relationship to ovm.4 (PM2 migration — `checkPort`/`isPm2AppOnline`)

- Utility relocation from `factory-dispatch.ts` should be completed early to remove accidental infra coupling with dispatch orchestration.
- `stack-manager.ts` currently imports these helpers directly from factory-dispatch, creating an avoidable dependency edge.

### Recommended sequencing

1. Complete ovm.7 boundary extraction (Kilo client + session APIs + monitor primitives).
2. Complete ovm.4 utility extraction (`checkPort`, `isPm2AppOnline`) into infra utility module.
3. Refactor Temporal activities and `factory-dispatch` to consume shared modules.
4. Add contract tests to lock CLI output/exit-code parity.
5. Re-evaluate Option A full replacement once parity is proven.

### Preconditions before deeper consolidation

- Shared interface definitions for result extraction/output translation.
- Explicit mapping from `AgentTaskResult.status` to factory exit codes.
- Decision on prompt payload compatibility (`PromptPayload` JSON vs plain prompt string).

## 8. Risks and Non-Goals

### Risks

- Behavioral drift in completion semantics (idle detection differs today).
- Loss of operator-visible output compatibility if translation is incomplete.
- Coupling Temporal workflow result model to CLI requirements without a stable adapter layer.
- Regressions in long-running sessions if timeout/abort behavior changes unexpectedly for existing users.

### Non-goals

- This spec does **not** recommend immediate deletion of `factory-dispatch`.
- This spec does **not** propose changing dependency graph/packages.
- This spec does **not** redefine foreman dispatch result types; foreman `DispatchResult` remains a distinct contract.

### Behavioral differences requiring explicit resolution

- Prompt input shape parity (`PromptPayload` with custom parts vs plain text input).
- Final result text extraction expectations for CLI users.
- Exit code parity across all failure categories.
- Child tracking semantics (direct children vs recursive active leaf).

## 9. Affected Files

If consolidation proceeds, likely affected files include:

- `daemon/src/infra/factory-dispatch.ts`
- `daemon/src/infra/factory-dispatch.cli.ts`
- `.kilocode/tools/factory_dispatch.sh`
- `daemon/src/infra/stack-manager.ts` (imports currently tied to factory-dispatch)
- `daemon/src/temporal/workflows.ts`
- `daemon/src/temporal/activities.ts`
- `daemon/src/temporal/foreman.workflows.ts`
- `daemon/src/temporal/foreman.activities.ts`
- `daemon/src/temporal/foreman.types.ts`
- New shared infra modules for Kilo client/session/monitor utilities (path TBD under `daemon/src/infra/` or `daemon/src/temporal/` extraction target)

## 10. Open Questions

1. Should CLI dispatch always remain synchronous-from-user-perspective, even if backed by Temporal workflow handles?
2. What is the canonical mapping from `AgentTaskResult.status` to `ExitCode` 0-6, especially for `validation_failed` and `budget_exceeded`?
3. Should `PromptPayload` JSON mode be preserved, emulated, or deprecated in favor of plain prompt strings?
4. What is the source of truth for final result text if Temporal remains metrics/status-oriented?
5. Should timeout behavior standardize on explicit abort semantics for all dispatch paths?
6. How should foreman and CLI `DispatchResult` naming/type collision be clarified to avoid misuse?

---

## Interface Appendix

Verified identifiers used by this spec:

- `runDispatch(config: FactoryDispatchConfig, fetchFn?: typeof fetch): Promise<ExitCodeValue>` at `daemon/src/infra/factory-dispatch.ts:622`
- `DispatchResult` at `daemon/src/infra/factory-dispatch.ts:145`: `{ session_id, mode, title, children, elapsed_seconds, result, child_session_ids, audit? }`
- `AuditResult` at `daemon/src/infra/factory-dispatch.ts:137`: `{ cardId, status: "pass"|"fail", missing, violations }`
- `ExitCode` at `daemon/src/infra/factory-dispatch.ts:157-164`: `0-6`
- HTTP endpoints: `GET /session`, `POST /session`, `POST /session/{id}/prompt_async`, `GET /session/{id}/children`, `GET /session/{id}/message`
- `agentTaskWorkflow` at `daemon/src/temporal/workflows.ts`
- `AgentTaskInput`, `AgentTaskStatus`, `AgentTaskResult` at `daemon/src/temporal/workflows.ts`
- `abortSignal`, `progressSignal`, `statusQuery` at `daemon/src/temporal/workflows.ts`
- `healthCheck`, `createSession`, `abortSession`, `sendPrompt`, `pollUntilDone` at `daemon/src/temporal/activities.ts`
- `foremanWorkflow` at `daemon/src/temporal/foreman.workflows.ts`
- Foreman `DispatchResult` (different type) at `daemon/src/temporal/foreman.types.ts:200`
- `checkPort` at `daemon/src/infra/factory-dispatch.ts:185`, imported by `daemon/src/infra/stack-manager.ts:24`
- `isPm2AppOnline` at `daemon/src/infra/factory-dispatch.ts:208`, imported by `daemon/src/infra/stack-manager.ts:25`
