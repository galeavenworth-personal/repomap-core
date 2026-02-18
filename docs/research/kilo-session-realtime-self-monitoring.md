# Kilo Code Real-Time Session Self-Monitoring

**Date:** 2026-02-17  
**Researcher:** plant-manager (anthropic/claude-opus-4.6)  
**Task ID:** `019c6cad-ab04-729d-8d06-0713cb1977c8`  
**Predecessor:** [`kilo-session-data-as-receipts.md`](kilo-session-data-as-receipts.md)

---

## Executive Summary

**Kilo Code's session data is written to disk synchronously after each UI event, and the running agent can read its own session data mid-execution.** This enables real-time self-monitoring: the agent can query its own tool calls, cost accumulation, command outputs, and full execution timeline while the session is still in progress.

This is not post-hoc analysis. This is **live introspection**.

---

## Experiment Design

### Hypothesis

If `ui_messages.json` is flushed to disk after each tool call or response (not batched at session end), then the running agent can:

1. Identify its own task ID (most recently modified task directory)
2. Read its own session data via `execute_command`
3. See events from earlier in the same session, including tool calls, costs, and outputs
4. Observe the message count growing with each successive read

### Method

1. Start a new task in `plant-manager` mode
2. Execute `ls -1t` on the tasks directory → identify the most recent task ID
3. Read `ui_messages.json` for that task ID → check if it contains events from this session
4. Execute a second read → verify the message count has increased
5. Parse the full timeline with timestamps → verify chronological ordering and event completeness

---

## Results

### Finding 1: Session Data Is Written Synchronously

| Read # | Messages | Elapsed | Notes |
|--------|----------|---------|-------|
| 1st read (after 2 tool calls) | 17 | ~16s | Contains `updateTodoList` and `ls` command |
| 2nd read (after 3 tool calls) | 23 | ~25s | Contains the 1st read's Python script and its output |
| 3rd read (script `whoami`) | 57 | ~143s | Contains file creation and all subsequent commands |

**Conclusion:** Data is flushed after every event. Not batched, not deferred. The 2nd read contained the 1st read's command, proving synchronous disk writes.

### Finding 2: Agent Can Identify Its Own Task

The most recently modified directory in `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/` is the current task. Verified by content inspection: the session contained the user's initial prompt text from this task.

**Method:** `ls -1t ~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/ | head -1`

### Finding 3: Full Event Timeline Is Available

Every event type was visible in real-time:

| Event Type | Example from This Session |
|---|---|
| `say/api_req_started` | `{tokensIn: 34187, cost: $0.2211, inferenceProvider: "Amazon Bedrock"}` |
| `ask/tool` (updateTodoList) | Todo list creation at 12:37:34 |
| `ask/command` | `ls -1t ...` at 12:37:41 |
| `say/command_output` | Task ID list at 12:37:42 |
| `say/text` | Agent's natural language response |
| `say/reasoning` | Chain-of-thought excerpt (!) |
| `say/checkpoint_saved` | Git checkpoint hash at each tool approval |
| `ask/tool` (newFileCreated) | Script creation at 12:39:45 |

### Finding 4: Cost Tracking Is Accurate and Real-Time

| Metric | Self-Monitoring Report | Environment_Details | Match? |
|--------|----------------------|---------------------|--------|
| Total cost | $0.7489 | $0.75 | ✅ |
| API calls | 11 | — | ✅ (verified by count) |
| Inference provider | Amazon Bedrock | — | ✅ |

### Finding 5: Reasoning Content Is Leaked Into Session Data

At message index `[3]`, `say=reasoning` contains a preview of the model's chain-of-thought:

> *"The user wants me to run an experiment to determine: 1. Whether Kilo Code sessi..."*

This is significant — it means the agent's **internal reasoning** is persisted and queryable post-hoc. This was not expected from the initial receipts research.

---

## What This Enables

### 1. Self-Monitoring Skills

An agent can periodically query its own session to:
- **Track cost burn rate** — alert if spending exceeds budget
- **Audit tool usage** — verify expected tools were called
- **Detect stalls** — identify gaps in the timestamp sequence
- **Review own reasoning** — re-read earlier chain-of-thought

### 2. Cross-Session Correlation

A new session can read previous sessions' data to:
- **Resume context** — reconstruct what happened without checkpoints
- **Audit trails** — verify what a previous agent actually did
- **Cost accounting** — aggregate spend across sessions

### 3. Parent-Child Task Monitoring

An orchestrator can read subtask session data to:
- **Verify subtask completion** — check for `completion_result` events
- **Monitor subtask cost** — track spend per subtask in real-time
- **Detect subtask failures** — identify error patterns in command output

### 4. Live Dashboarding (External)

An external tool could watch `tasks/*/ui_messages.json` with `inotify` to build real-time dashboards of agent activity without any Kilo Code integration needed.

---

## Limitations

### 1. Task ID Discovery Is Heuristic

Using the most recently modified task directory works for the current task, but could fail if:
- Multiple Kilo Code instances are running simultaneously
- Background tasks update concurrently
- The task directory is not the most recently modified (edge case)

### 2. No Explicit Session-to-Task Mapping from Inside

The agent has no direct way to know its own task ID. It infers it from filesystem modification time. A more robust approach would be for Kilo Code to expose the task ID as an environment variable or in the system prompt.

### 3. Schema Stability

The `ui_messages.json` format is internal to Kilo Code and could change. Any self-monitoring tooling must be resilient to schema evolution.

### 4. No Write Access

The agent can read but should not write to the session data files. This is a read-only introspection capability.

---

## Preserved Tooling

### `.kilocode/tools/kilo_session_monitor.py`

A Python script providing CLI commands for session self-monitoring:

| Command | Description |
|---|---|
| `whoami` | Current task ID, message count, elapsed time |
| `timeline [TASK_ID]` | Full session event timeline |
| `cost [TASK_ID]` | Cost summary (tokens, cache, cost, provider) |
| `tools [TASK_ID]` | Tool and MCP call distribution |
| `tail [N]` | Last N messages |
| `receipts [TASK_ID]` | Structured receipt extraction (JSON) |

**Note:** This script is gitignored (`.kilocode/tools/kilo_session_monitor.py` in `.gitignore`) because it reads from Kilo Code's internal storage format. It exists on-disk for agent use but is not tracked in the public repo.

---

## Sharpness Assessment

The edge is **very sharp**:

| Capability | Sharpness | Notes |
|---|---|---|
| Real-time event streaming to disk | 🔪🔪🔪 | Synchronous, millisecond precision |
| Self-identification (task ID) | 🔪🔪 | Heuristic but reliable for single-instance |
| Cost tracking accuracy | 🔪🔪🔪 | Matches environment_details exactly |
| Full event taxonomy | 🔪🔪🔪 | Commands, tools, MCP, checkpoints, reasoning(!) |
| Reasoning access | 🔪🔪🔪 | Unexpected bonus — chain-of-thought is persisted |
| Cross-session querying | 🔪🔪🔪 | 863 tasks, 1.1GB, full history |
| Schema stability | 🔪 | Internal format, no guarantees |

**Overall:** This is a production-quality introspection capability that requires zero additional infrastructure. The agent already has real-time read access to a comprehensive audit log of its own execution. The only infra work needed is query tooling (now preserved in `kilo_session_monitor.py`).

---

## Next Steps

1. **Integrate `whoami` into session start** — Agent rules could mandate running `kilo_session_monitor.py whoami` at session start for task ID awareness
2. **Add cost budget alerting** — A `cost --budget 2.00` flag that returns a warning if spend exceeds threshold
3. **Investigate `reasoning` event completeness** — Is the full chain-of-thought or just a snippet persisted?
4. **Build parent-child correlation** — Match `newTask` spawns to child task directories by timing
5. **Watch for Kilo Code schema changes** — Monitor across versions for breaking format changes
