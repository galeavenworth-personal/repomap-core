# Chain of Custody — SSE Ground Truth

## The Rule

Every claim about factory or plant status — session state, punch card
compliance, cost, health, agent behavior — **MUST** include a verifiable
chain of custody back to the kilo SSE event log.

A status claim without stated provenance is **untrusted by default**.

This rule applies to **Cascade**, **all factory agents**, and **any tooling
that reports factory state to a human operator**.

## Why This Exists

The factory's event log lives in kilo serve. The Dolt tables (punches,
sessions, messages, tool_calls) are **materialized views** — derived state
projected from that log by the oc-daemon. They are useful caches, not
sources of truth.

Before the event-sourced validation architecture (repomap-core-lzn), models
could write directly to Dolt (punch forgery), and status reports could be
derived from model memory or stale caches. This created an epistemological
gap: you couldn't tell whether a status claim was grounded in reality or
hallucinated from convention.

This rule closes that gap permanently.

## Trust Levels

### Verified (highest)

Derived directly from the kilo serve API:
- `client.session.messages(sessionId)` — replay the event log for a session
- `client.event.subscribe()` — real-time SSE stream

**Example:**
```
Session ses_XXX completed with 3 children.
Source: client.session.messages('ses_XXX') — 47 messages,
  last step-finish reason='end_turn', 0 running tools.
  Children: client.session.list() filtered by parentID=ses_XXX.
```

### Projected (acceptable)

Derived from Dolt materialized views that were written **exclusively by the
daemon projector** (enforced by lzn.2 — single-writer invariant).

After lzn.2 lands, Dolt reads are acceptable because the write path is
sealed — only the daemon can write to derived tables, and the daemon
projects from the SSE event log.

**Example:**
```
Session ses_XXX has 14 tool_call punches.
Source: Dolt factory.punches WHERE task_id='ses_XXX' AND punch_type='tool_call'.
Projector: oc-daemon (single-writer, sealed by lzn.2).
```

### Untrusted (rejected)

Any claim derived from:
- Model memory or inference without querying the event log or materialized views
- Dolt tables that may have been written to by the model (pre-lzn.2, or any
  table not covered by the single-writer invariant)
- Summaries or aggregations without citing the underlying query
- "I remember from earlier" or "based on the previous session"

**These claims are hot garbage. Do not present them as fact.**

## How to Comply

### Cascade

When reporting factory status to the operator:
1. Query kilo serve API or Dolt materialized views
2. State the source in the response (session ID, query, message count)
3. If you cannot query (e.g., stack is down), say so explicitly — do not
   guess from memory

### Factory Agents (via card-exit prompts)

When a dispatched agent reports session outcomes, punch card status, or
cost data:
1. The agent must have obtained the data from `check_punch_card.sh` (which
   uses the kilo-verified validator) or from a Dolt read query
2. The agent must not fabricate punch counts or session states
3. Card-exit compiled prompts for status-reporting modes will include this
   requirement (DSPy-compilable)

### Validator Output (kilo-verified-validator.ts)

Every validation result MUST include:
- `sessionId` — the task/session under validation
- `sourceSessionId` — the source session the validator replayed
- `messageCount` — how many messages were replayed from the log
- `derivationPath` — exact derivation flow (for example, `kilo-sse:/event -> session.messages -> classifier -> validation`)
- `trustLevel` — `verified` | `projected` | `untrusted`

This metadata IS the chain of custody. Without it, a PASS/FAIL is
meaningless.

## DSPy Prompt Constraint (Compilable)

This rule must be representable in card-exit prompts as a strict machine-checkable
constraint.

```text
Constraint ID: chain_of_custody_required
Applies to: any claim about session state, punch card compliance, cost, health, or agent behavior
Rule: Output MUST include {sourceSessionId, messageCount, derivationPath, trustLevel}
Pass condition: trustLevel in {verified, projected} AND derivationPath traces to kilo SSE /event
Fail condition: missing provenance fields OR trustLevel == untrusted
```

DSPy compilation should reinforce this exact structure so provenance is learned,
scored, and retained over time.

## Scope

This rule is **not proportional** — it is absolute. There is no "small
status report" exemption. If you claim something about the factory's state,
you cite the source. Period.

The rule does NOT apply to:
- Design discussions or architecture proposals (opinions, not state claims)
- Code review feedback (analysis, not state claims)
- Beads metadata (owned by bd CLI, separate chain of custody)

## Enforcement

This is a **hard rule**, not a soft discipline.

After lzn.6 lands:
- Cascade's operating instructions include this constraint
- The kilo-verified validator embeds provenance in every result
- DSPy compilation reinforces the behavior via card-exit prompts
- Any factory status report without provenance is flagged as untrusted

## Relationship to Event Sourcing (lzn)

This rule is the **policy complement** to the technical architecture:

| lzn bead | Technical mechanism | This rule's requirement |
|----------|-------------------|----------------------|
| lzn.1 | Log-based validator | Validator output includes chain of custody |
| lzn.2 | Single-writer invariant | Dolt reads become "projected" trust level |
| lzn.3 | SSE reconnect hardening | Minimizes gaps in the event log |
| lzn.5 | Full replay capability | Can rebuild and verify any claim |
| **lzn.6** | **This rule** | **All claims must cite their source** |
