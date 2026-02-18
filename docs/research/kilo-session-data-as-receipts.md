# Kilo Code Session Data as Agent Receipts

**Date:** 2026-02-17  
**Researcher:** plant-manager (anthropic/claude-opus-4.6)  
**Context:** Exploration of Kilo Code's persisted session data as a potential short-circuit for the agent-receipts problem described in [`command-dialect-exploration-review.md`](command-dialect-exploration-review.md)

---

## Executive Summary

**Kilo Code already persists comprehensive execution data for every task.** The data that powers the UI's token-cost bar chart and tool-call visualization is stored as plain JSON files under `~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/`. This data contains everything proposed in the agent-receipts design — tool calls, command executions with stdout, MCP invocations with arguments and responses, token counts, costs, timestamps, diffs applied, files read, and completion results — already captured without any additional tooling.

**The receipts problem may reduce to a querying problem.** Instead of building a Rust binary to wrap and instrument every command, we may be able to query Kilo's existing session store to reconstruct execution proofs after the fact. This doesn't eliminate all use cases for `ar`, but it dramatically changes the cost-benefit analysis.

---

## Data Location and Structure

### File System Layout

```
~/.config/Code/User/globalStorage/kilocode.kilo-code/
├── tasks/                          # 863 task directories, 1.1 GB total
│   └── {task-uuid}/
│       ├── api_conversation_history.json   # Raw API request/response pairs
│       ├── task_metadata.json              # Files in context, read/edit dates
│       ├── ui_messages.json                # ← THE GOLDMINE: all tool calls, costs, outputs
│       └── checkpoints/                    # Git-like checkpoints per task
├── sessions/                       # Session-to-task mappings
│   └── {session-hash}/
│       └── session.json            # { lastSession, taskSessionMap }
├── settings/
│   ├── custom_modes.yaml
│   └── mcp_settings.json
└── cache/                          # Model registry caches (not relevant)
```

### The Goldmine: `ui_messages.json`

Each task's `ui_messages.json` is a JSON array of timestamped events. Every event has:

| Field | Type | Description |
|---|---|---|
| `ts` | number | Unix timestamp in milliseconds |
| `type` | string | `"say"` (agent output) or `"ask"` (agent request needing approval) |
| `say` | string | Event subtype for `say` messages |
| `ask` | string | Event subtype for `ask` messages |
| `text` | string | Event payload (often JSON-encoded) |

### Event Types Captured

| Type/Subtype | What It Contains |
|---|---|
| `say/api_req_started` | `{ apiProtocol, tokensIn, tokensOut, cacheWrites, cacheReads, cost, usageMissing }` |
| `ask/tool` | `{ tool, path, diff, content, isOutsideWorkspace }` — covers readFile, appliedDiff, newTask, searchFiles, listFiles, editedExistingFile, deleteFile, switchMode, updateTodoList |
| `ask/command` | The command string (e.g., `"bd sync --no-push"`) |
| `ask/command_output` | Empty (approval gate) |
| `say/command_output` | The actual stdout/stderr output |
| `ask/use_mcp_server` | `{ type, serverName, toolName, arguments }` — full MCP tool invocation |
| `say/mcp_server_request_started` | MCP call initiated |
| `say/mcp_server_response` | Full MCP tool response JSON |
| `say/text` | Agent's natural language output |
| `say/completion_result` | Final task result (what gets returned to parent on subtask completion) |
| `say/checkpoint_saved` | Git checkpoint hash `{ from, to }` |

### What `api_conversation_history.json` Adds

- Full conversation messages with `role`, `content`, `id`, `ts`
- The system prompt (which contains `<slug>mode-name</slug>`, enabling mode extraction)
- Encrypted reasoning content (model's chain-of-thought)
- No direct token/cost data (that's in `ui_messages.json`)

### What `task_metadata.json` Adds

- `files_in_context` array: every file touched, with `record_state`, `record_source`, `roo_read_date`, `roo_edit_date`, `user_edit_date`

---

## Aggregate Statistics (This Installation)

| Metric | Value |
|---|---|
| Total task directories | 863 |
| Date range | 2026-01-16 to 2026-02-17 |
| Total API calls | 14,721 |
| Total tokens in | 855,225,330 |
| Total tokens out | 7,943,336 |
| Total cache reads | 749,554,860 |
| Total cost | $546.22 |
| Total tool calls | 6,315 |
| Total MCP calls | 3,365 |
| Total commands executed | 3,628 |
| Total disk usage | 1.1 GB |

### Tool Call Distribution

| Tool | Count |
|---|---|
| readFile | 1,919 |
| appliedDiff | 1,454 |
| updateTodoList | 1,438 |
| newTask | 577 |
| searchFiles | 477 |
| listFilesTopLevel | 168 |
| listFilesRecursive | 102 |
| newFileCreated | 90 |
| switchMode | 65 |
| editedExistingFile | 19 |
| deleteFile | 4 |

### MCP Tool Distribution

| Server:Tool | Count |
|---|---|
| sequentialthinking:process_thought | 2,306 |
| sequentialthinking:generate_summary | 400 |
| augment-context-engine:codebase-retrieval | 314 |
| sequentialthinking:import_session | 132 |
| sequentialthinking:export_session | 126 |
| sonarqube:search_sonar_issues_in_projects | 11 |
| sonarqube:search_my_sonarqube_projects | 7 |
| context7:resolve-library-id | 2 |
| context7:query-docs | 2 |

---

## What This Data Can Answer (Receipt Equivalents)

### ✅ Already Answerable by Querying Session Data

1. **"Did command X run and what was its exit output?"**
   - `ask/command` → `say/command_output` pairs with timestamps

2. **"What files did this task read/modify/create?"**
   - `ask/tool` with `tool=readFile|appliedDiff|newFileCreated|editedExistingFile|deleteFile`
   - `task_metadata.json` `files_in_context` array

3. **"What was the token cost of this task?"**
   - Sum all `say/api_req_started` entries' `tokensIn`, `tokensOut`, `cost`

4. **"What MCP tools were called with what arguments?"**
   - `ask/use_mcp_server` has `serverName`, `toolName`, `arguments`
   - `say/mcp_server_response` has full response

5. **"What subtasks were spawned?"**
   - `ask/tool` with `tool=newTask` contains `mode`, `content`, `todos`

6. **"What mode was this task running in?"**
   - Extractable from `api_conversation_history.json` system prompt `<slug>` tag

7. **"What was the task's final result?"**
   - `say/completion_result` text field

8. **"What diffs were applied to what files?"**
   - `ask/tool` with `tool=appliedDiff` contains `path` and `diff` (unified diff format)

9. **"What git checkpoints were created?"**
   - `say/checkpoint_saved` with `{ from, to }` hashes

10. **"When did each action happen?"**
    - Every event has millisecond-precision `ts` field

### ❌ NOT Answerable from Session Data Alone

1. **Exit codes** — Command output is captured but exit codes are not explicitly stored (they're inferred by Kilo internally)
2. **Content hashing** — No SHA-256 of stdout/stderr (but output text is stored, so hashing is trivial post-hoc)
3. **One-time consumption semantics** — No `consumed`/`consumed_by`/`consumed_at` (this is a receipt-specific workflow concept)
4. **Parent-child task linkage** — `newTask` spawns are visible from the parent, but there's no explicit cross-reference from child back to parent in the stored data
5. **Timeout/stall detection** — No wall-clock budget or stall detection metadata (this is what `bounded_gate.py` adds)

---

## Strategic Implications

### The "Epic Short-Circuit"

The agent-receipts design document proposed building a Rust binary (`ar`) to:
1. Wrap CLI commands and capture exit codes + output ✅ **Already captured**
2. Hash outputs for integrity ❌ **Not captured but trivially derivable**
3. Log audit records ✅ **Already logged (ui_messages.json IS the audit log)**
4. Wrap MCP tool calls ✅ **Already captured with full arguments and responses**
5. Provide one-time consumption semantics ❌ **Not captured (workflow-layer concept)**
6. Create a receipt DB ✅ **Already exists (it's the tasks/ directory)**

**4 of 6 requirements are already met.** The remaining 2 (content hashing, consumption semantics) are overlay concerns that can be implemented as a query/post-processing layer rather than an interception layer.

### What Changes

| Original Plan | Revised Plan |
|---|---|
| Build `ar` Rust binary to wrap all commands | Build a **query tool** that reads Kilo session data |
| Produce receipts at execution time | **Reconstruct receipts from session data** post-hoc |
| Maintain a separate receipt SQLite DB | **Query the existing JSON files** (or ETL into SQLite for speed) |
| Intercept all execute_command calls | **Not needed** — Kilo already captures everything |
| Two surfaces (CLI + MCP) | **One surface** — read from `tasks/*/ui_messages.json` |

### What `ar` Still Does (Reduced Scope)

The Rust binary's role shrinks dramatically:

1. **Query interface** — `ar query --task <id> --type command` to extract receipts from session data
2. **ETL/indexing** — Load tasks/*.json into SQLite for fast cross-task queries
3. **Content hashing** — Post-hoc SHA-256 of captured outputs for integrity verification
4. **Aggregation** — Cross-task cost rollups, tool usage analytics, mode distribution
5. **Export** — Structured receipt format from raw session data

What it does NOT need to do:
- Wrap command execution (Kilo does this)
- Capture MCP tool calls (Kilo does this)
- Log timestamps (Kilo does this)
- Store diffs (Kilo does this)

### Bounded Gate Migration

The `bounded_gate.py` → `ar` migration story also changes:

- `bounded_gate.py` adds timeout/stall detection and exit code classification that Kilo doesn't capture
- These remain valuable for **real-time gate enforcement** (stopping runaway commands)
- But the **audit/proof function** of bounded_gate is redundant with Kilo's session data
- Migration path: keep bounded_gate for real-time control, retire its audit logging in favor of querying session data

---

## Proof of Concept: What a Query Tool Looks Like

A minimal receipt query against this data:

```python
import json, os, sys
from pathlib import Path

TASKS = Path.home() / ".config/Code/User/globalStorage/kilocode.kilo-code/tasks"

def get_task_receipts(task_dir: str) -> dict:
    """Extract receipt-equivalent data from a Kilo task."""
    ui = json.loads((TASKS / task_dir / "ui_messages.json").read_text())
    
    receipts = {
        "task_id": task_dir,
        "commands": [],
        "tool_calls": [],
        "mcp_calls": [],
        "api_costs": [],
        "files_modified": [],
        "completion": None,
    }
    
    pending_cmd = None
    for m in ui:
        if m.get("ask") == "command":
            pending_cmd = {"command": m["text"], "ts": m["ts"], "output": None}
        elif m.get("say") == "command_output" and pending_cmd:
            pending_cmd["output"] = m["text"]
            receipts["commands"].append(pending_cmd)
            pending_cmd = None
        elif m.get("ask") == "tool":
            data = json.loads(m["text"])
            receipts["tool_calls"].append({
                "tool": data.get("tool"),
                "path": data.get("path"),
                "ts": m["ts"],
            })
        elif m.get("ask") == "use_mcp_server":
            data = json.loads(m["text"])
            receipts["mcp_calls"].append({
                "server": data.get("serverName"),
                "tool": data.get("toolName"),
                "ts": m["ts"],
            })
        elif m.get("say") == "api_req_started":
            data = json.loads(m["text"])
            receipts["api_costs"].append(data)
        elif m.get("say") == "completion_result":
            receipts["completion"] = m["text"][:500]
    
    return receipts
```

This is ~40 lines of Python. The entire "receipt system" for querying existing data.

---

## Risks and Limitations

### 1. Data Stability
Kilo Code's internal storage format is not a public API. It could change between versions without notice. Any query tool must be version-aware or resilient to schema changes.

### 2. Cross-Workspace Scope
The `tasks/` directory contains tasks from ALL workspaces, not just the current project. A query tool would need to filter by workspace (extractable from the system prompt or file paths in tool calls).

### 3. No Real-Time Interception
Session data is written after the fact. You cannot use it for **real-time gate enforcement** (e.g., "don't proceed unless the previous command succeeded"). For that, `bounded_gate.py` or `ar exec` is still needed.

### 4. Parent-Child Linkage Gap
While you can see `newTask` spawns from the parent, reconstructing the full task tree requires correlating by content/timing since there's no explicit parent-child ID linkage in the stored data.

### 5. Privacy/Sensitivity
The session data contains full command outputs, file contents, and conversation history. Any query tool that exports or aggregates this data must consider what gets exposed.

---

## Recommendations

### 1. Build a Lightweight Query Tool First (Days, Not Weeks)
A Python script or small Rust CLI that reads `tasks/*/ui_messages.json` and produces structured receipt summaries. This proves the concept immediately with zero infrastructure changes.

### 2. Add SQLite ETL for Cross-Task Queries
Periodically load the JSON files into a SQLite database for fast aggregation queries (cost by mode, tool usage trends, command frequency analysis).

### 3. Keep `bounded_gate.py` for Real-Time Control
Don't retire bounded_gate's timeout/stall detection. That's a real-time control-plane function that session data can't replace. But redirect its audit function to read from session data instead of maintaining `gate_runs.jsonl` separately.

### 4. Reduce `ar` Scope to Query + ETL + Hash
The Rust binary becomes a **query tool**, not an execution wrapper:
- `ar receipts <task-id>` — Extract structured receipts from session data
- `ar index` — ETL all tasks into SQLite
- `ar cost --since 2026-02-01` — Aggregate cost analysis
- `ar verify <task-id>` — Post-hoc content hashing of outputs for integrity

### 5. Investigate Kilo Code Source for Schema Stability
Read the Kilo Code extension source (it's open source) to understand the `ui_messages.json` schema guarantees and version stability.

---

## Decision: Internal Tool, Not Public Project

**Date:** 2026-02-17  
**Decision:** Build the query tool as an internal `.kilocode/tools/` script, not in the public `agent-receipts` Rust project.

**Rationale:** If we build this in the public Rust project, that project becomes Kilo-specific — it's querying Kilo Code's internal storage format. That's the wrong abstraction boundary. The public `agent-receipts` project (if built later) should remain tool-agnostic. The Kilo session data querying is an internal fabrication plant concern.

**Implementation path:**
1. Add `.kilocode/tools/kilo_receipts.py` — Python script that reads `tasks/*/ui_messages.json`
2. Enhance `bounded_gate.py` or add a sibling to correlate gate runs with session data
3. No external Rust binary needed for this use case
4. `bounded_gate.py` keeps its real-time timeout/stall enforcement role
5. The query tool adds the post-hoc audit/receipts/analytics layer

**What this tool provides:**
- `kilo_receipts.py receipts <task-id>` — structured receipt extraction
- `kilo_receipts.py cost [--since DATE]` — cost aggregation across tasks
- `kilo_receipts.py commands <task-id>` — command + output audit trail
- `kilo_receipts.py tools [--task <id>]` — tool usage analytics
- `kilo_receipts.py index` — optional SQLite ETL for fast cross-task queries

**What the public agent-receipts project becomes (deferred):**
- A tool-agnostic execution wrapper for non-Kilo contexts
- Only built if/when there's a need outside of Kilo Code workflows
- The Kilo session data discovery means this is not urgent

---

## Verdict

**This is the short-circuit.** The data we proposed to generate with a new Rust binary already exists in Kilo's session storage. The job changes from *production* (instrument every command) to *querying* (read what Kilo already recorded). No public Rust project needed — an internal Python tool under `.kilocode/tools/` reads the goldmine that's already on disk.

The 863 tasks, 14,721 API calls, 13,308 tool/MCP/command invocations, and $546 in cost data sitting in 1.1 GB of queryable JSON files is the receipt database. It already exists. We just need to read it.
