#!/usr/bin/env python3
"""Kilo Code Session Self-Monitor.

Reads the Kilo Code session data from disk to provide real-time
self-monitoring capabilities for the running agent.

Usage:
    # Show current task timeline
    python3 .kilocode/tools/kilo_session_monitor.py timeline

    # Show current task cost summary
    python3 .kilocode/tools/kilo_session_monitor.py cost

    # Show current task tool usage
    python3 .kilocode/tools/kilo_session_monitor.py tools

    # Show the most recent N messages
    python3 .kilocode/tools/kilo_session_monitor.py tail [N]

    # Identify current task ID
    python3 .kilocode/tools/kilo_session_monitor.py whoami

    # Full receipt extraction for a specific task
    python3 .kilocode/tools/kilo_session_monitor.py receipts [TASK_ID]

    # Show subtask tree with cost rollup
    python3 .kilocode/tools/kilo_session_monitor.py children [TASK_ID]

NOTE: This script is gitignored. It reads from Kilo Code's internal
storage format (~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/).
This format is not a public API and may change between versions.
"""

import json
import datetime
import subprocess
import shutil
import sys
import uuid
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

KILO_STORAGE = Path.home() / ".config/Code/User/globalStorage/kilocode.kilo-code"
TASKS_DIR = KILO_STORAGE / "tasks"
DOLT_BIN = shutil.which("dolt")
DOLT_DATA_DIR = Path.home() / ".dolt-data/beads"


def _sql_quote(value: str) -> str:
    """Quote a SQL string literal using single-quote escaping."""
    return value.replace("'", "''")


def _parse_csv_rows(csv_text: str) -> list[list[str]]:
    """Parse simple CSV output into rows."""
    rows = [line.strip() for line in csv_text.strip().splitlines() if line.strip()]
    if not rows:
        return []
    return [row.split(",") for row in rows]


def dolt_sql(query: str) -> str | None:
    """Run a Dolt SQL query and return CSV stdout, or None on failure."""
    if not DOLT_BIN:
        print("WARNING: Dolt not available (binary not found in PATH)", file=sys.stderr)
        return None
    if not DOLT_DATA_DIR.exists():
        print(f"WARNING: Dolt data directory missing: {DOLT_DATA_DIR}", file=sys.stderr)
        return None

    try:
        result = subprocess.run(
            [DOLT_BIN, "sql", "-q", query, "--result-format", "csv"],
            cwd=DOLT_DATA_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        print(f"WARNING: Dolt invocation failed: {exc}", file=sys.stderr)
        return None

    if result.returncode != 0:
        err = (result.stderr or "").strip()
        print(f"WARNING: Dolt query failed: {err}", file=sys.stderr)
        return None

    return result.stdout


def get_current_task_id() -> str | None:
    """Get the most recently modified task directory (likely the current task)."""
    if not TASKS_DIR.exists():
        return None
    task_dirs = sorted(
        TASKS_DIR.iterdir(),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return task_dirs[0].name if task_dirs else None


def load_ui_messages(task_id: str) -> list[dict]:
    """Load ui_messages.json for a given task."""
    path = TASKS_DIR / task_id / "ui_messages.json"
    if not path.exists():
        return []
    return json.loads(path.read_text())


def fmt_ts(ts: int | float) -> str:
    """Format millisecond timestamp to readable time."""
    return datetime.datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S.%f")[:-3]


def _safe_float(val: float | int | str | None, default: float = 0.0) -> float:
    """Defensively coerce a numeric-like value to float."""
    if val is None:
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _safe_int(val: float | int | str | None, default: int = 0) -> int:
    """Defensively coerce a numeric-like value to int."""
    if val is None:
        return default
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return default


def _aggregate_costs(
    ui: list[dict],
) -> tuple[float, int, int, int, int, int, Counter[str]]:
    """Aggregate cost/token/provider metrics from api_req_started messages."""
    total_cost = 0.0
    total_in = 0
    total_out = 0
    total_cache_reads = 0
    total_cache_writes = 0
    api_calls = 0
    providers: Counter[str] = Counter()

    for m in ui:
        if m.get("say") != "api_req_started":
            continue
        try:
            data = json.loads(m["text"])
        except (json.JSONDecodeError, KeyError):
            continue

        total_cost += _safe_float(data.get("cost"), 0.0)
        total_in += _safe_int(data.get("tokensIn"), 0)
        total_out += _safe_int(data.get("tokensOut"), 0)
        total_cache_reads += _safe_int(data.get("cacheReads"), 0)
        total_cache_writes += _safe_int(data.get("cacheWrites"), 0)
        api_calls += 1
        provider = data.get("inferenceProvider", "unknown")
        providers[str(provider) if provider is not None else "unknown"] += 1

    return (
        total_cost,
        total_in,
        total_out,
        total_cache_reads,
        total_cache_writes,
        api_calls,
        providers,
    )


def cmd_whoami() -> None:
    """Print the current task ID and basic session info."""
    task_id = get_current_task_id()
    if not task_id:
        print("ERROR: No tasks found")
        return
    ui = load_ui_messages(task_id)
    print(f"Task ID:  {task_id}")
    print(f"Messages: {len(ui)}")
    if ui:
        first_ts = ui[0].get("ts", 0)
        last_ts = ui[-1].get("ts", 0)
        print(f"Started:  {fmt_ts(first_ts)}")
        print(f"Latest:   {fmt_ts(last_ts)}")
        elapsed = (last_ts - first_ts) / 1000
        print(f"Elapsed:  {elapsed:.1f}s")


def cmd_timeline(task_id: str | None = None) -> None:
    """Print full session timeline."""
    task_id = task_id or get_current_task_id()
    if not task_id:
        print("ERROR: No tasks found")
        return
    ui = load_ui_messages(task_id)
    print(f"Task: {task_id}")
    print(f"Total messages: {len(ui)}")
    print("=" * 80)

    for i, m in enumerate(ui):
        ts = m.get("ts", 0)
        say = m.get("say", "")
        ask = m.get("ask", "")
        text = str(m.get("text", ""))

        label = _classify_message(say, ask, text)
        print(f"  [{i:3d}] {fmt_ts(ts)} | {label}")


def cmd_cost(task_id: str | None = None) -> None:
    """Print cost summary for the task."""
    task_id = task_id or get_current_task_id()
    if not task_id:
        print("ERROR: No tasks found")
        return
    ui = load_ui_messages(task_id)

    (
        total_cost,
        total_in,
        total_out,
        total_cache_reads,
        total_cache_writes,
        api_calls,
        providers,
    ) = _aggregate_costs(ui)

    print(f"Task: {task_id}")
    print(f"API Calls:    {api_calls}")
    print(f"Total Cost:   ${total_cost:.4f}")
    print(f"Tokens In:    {total_in:,}")
    print(f"Tokens Out:   {total_out:,}")
    print(f"Cache Reads:  {total_cache_reads:,}")
    print(f"Cache Writes: {total_cache_writes:,}")
    print(f"Providers:    {dict(providers)}")


def cmd_tools(task_id: str | None = None) -> None:
    """Print tool usage for the task."""
    task_id = task_id or get_current_task_id()
    if not task_id:
        print("ERROR: No tasks found")
        return
    ui = load_ui_messages(task_id)

    tool_counts = Counter()
    mcp_counts = Counter()
    cmd_count = 0

    for m in ui:
        ask = m.get("ask", "")
        text = str(m.get("text", ""))

        if ask == "tool":
            try:
                data = json.loads(text)
                tool_counts[data.get("tool", "unknown")] += 1
            except (json.JSONDecodeError, KeyError):
                pass
        elif ask == "use_mcp_server":
            try:
                data = json.loads(text)
                key = f"{data.get('serverName', '?')}:{data.get('toolName', '?')}"
                mcp_counts[key] += 1
            except (json.JSONDecodeError, KeyError):
                pass
        elif ask == "command":
            cmd_count += 1

    print(f"Task: {task_id}")
    print(f"\nTool Calls ({sum(tool_counts.values())}):")
    for tool, count in tool_counts.most_common():
        print(f"  {tool}: {count}")

    print(f"\nMCP Calls ({sum(mcp_counts.values())}):")
    for tool, count in mcp_counts.most_common():
        print(f"  {tool}: {count}")

    print(f"\nCommands: {cmd_count}")


def cmd_tail(task_id: str | None = None, n: int = 5) -> None:
    """Show the last N messages."""
    task_id = task_id or get_current_task_id()
    if not task_id:
        print("ERROR: No tasks found")
        return
    ui = load_ui_messages(task_id)

    print(f"Task: {task_id} (showing last {n} of {len(ui)} messages)")
    print("=" * 80)

    for i, m in enumerate(ui[-n:], start=max(0, len(ui) - n)):
        ts = m.get("ts", 0)
        say = m.get("say", "")
        ask = m.get("ask", "")
        text = str(m.get("text", ""))

        label = _classify_message(say, ask, text)
        print(f"  [{i:3d}] {fmt_ts(ts)} | {label}")


def cmd_receipts(task_id: str | None = None) -> None:
    """Extract structured receipts from a task."""
    task_id = task_id or get_current_task_id()
    if not task_id:
        print("ERROR: No tasks found")
        return
    ui = load_ui_messages(task_id)

    receipts = {
        "task_id": task_id,
        "commands": [],
        "tool_calls": [],
        "mcp_calls": [],
        "api_costs": [],
        "files_modified": [],
        "completion": None,
    }

    pending_cmd = None
    for m in ui:
        ask = m.get("ask", "")
        say = m.get("say", "")
        text = str(m.get("text", ""))

        if ask == "command":
            pending_cmd = {"command": text, "ts": m["ts"], "output": None}
        elif say == "command_output" and pending_cmd:
            pending_cmd["output"] = text
            receipts["commands"].append(pending_cmd)
            pending_cmd = None
        elif ask == "tool":
            try:
                data = json.loads(text)
                receipts["tool_calls"].append(
                    {
                        "tool": data.get("tool"),
                        "path": data.get("path"),
                        "ts": m["ts"],
                    }
                )
                if data.get("tool") in (
                    "appliedDiff",
                    "newFileCreated",
                    "editedExistingFile",
                    "deleteFile",
                ):
                    receipts["files_modified"].append(data.get("path"))
            except (json.JSONDecodeError, KeyError):
                pass
        elif ask == "use_mcp_server":
            try:
                data = json.loads(text)
                receipts["mcp_calls"].append(
                    {
                        "server": data.get("serverName"),
                        "tool": data.get("toolName"),
                        "ts": m["ts"],
                    }
                )
            except (json.JSONDecodeError, KeyError):
                pass
        elif say == "api_req_started":
            try:
                data = json.loads(text)
                receipts["api_costs"].append(data)
            except (json.JSONDecodeError, KeyError):
                pass
        elif say == "completion_result":
            receipts["completion"] = text[:500]

    print(json.dumps(receipts, indent=2))


@dataclass
class SpawnEvent:
    """A newTask tool call in a parent task."""

    index: int
    new_task_ts: int
    result_ts: int | None
    mode: str
    label: str  # first line of message content


@dataclass
class TaskCost:
    """Aggregated cost info for a task."""

    task_id: str
    total_cost: float
    tokens_in: int
    tokens_out: int
    api_calls: int


@dataclass
class ChildMatch:
    """A matched child task with its spawn context."""

    spawn: SpawnEvent
    child_task_id: str
    cost: TaskCost | None


def uuid7_timestamp_ms(task_id: str) -> int | None:
    """Extract millisecond timestamp from a UUID v7 task directory name."""
    try:
        u = uuid.UUID(task_id)
        if u.variant != uuid.RFC_4122 or u.version != 7:
            return None
        int_val: int = u.int  # type: ignore[assignment]
        return int_val >> 80
    except (ValueError, AttributeError):
        return None


def extract_spawns(task_id: str) -> list[SpawnEvent]:
    """Find newTask tool calls and their corresponding subtask_result messages."""
    ui = load_ui_messages(task_id)
    spawns: list[SpawnEvent] = []
    result_indices = [i for i, m in enumerate(ui) if m.get("say") == "subtask_result"]
    consumed_result_indices: set[int] = set()

    for i, m in enumerate(ui):
        if m.get("ask") != "tool":
            continue
        try:
            data = json.loads(m["text"])
        except (json.JSONDecodeError, KeyError):
            continue
        if data.get("tool") != "newTask":
            continue

        # Extract label from message content (first non-empty line)
        content = data.get("content", data.get("message", ""))
        label = ""
        for line in str(content).splitlines():
            stripped = line.strip().lstrip("#").strip()
            if stripped:
                label = stripped[:80]
                break

        # Find next unused subtask_result after this spawn
        result_ts = None
        spawn_ts = int(m.get("ts", 0))
        for j in result_indices:
            if j in consumed_result_indices or j <= i:
                continue
            candidate_ts = ui[j].get("ts")
            if not isinstance(candidate_ts, int | float):
                continue
            if candidate_ts < spawn_ts:
                continue
            result_ts = int(candidate_ts)
            consumed_result_indices.add(j)
            break

        spawns.append(
            SpawnEvent(
                index=len(spawns),
                new_task_ts=spawn_ts,
                result_ts=result_ts,
                mode=data.get("mode", "?"),
                label=label,
            )
        )

    return spawns


def correlate_children(spawns: list[SpawnEvent]) -> list[ChildMatch]:
    """Match each spawn to a child task directory by UUID v7 timing."""
    if not spawns:
        return []

    # Build index of all task dirs with their UUID v7 timestamps
    all_tasks: list[tuple[str, int]] = []
    if TASKS_DIR.exists():
        for d in TASKS_DIR.iterdir():
            ts = uuid7_timestamp_ms(d.name)
            if ts is not None:
                all_tasks.append((d.name, ts))
    all_tasks.sort(key=lambda x: x[1])

    matches: list[ChildMatch] = []
    used_child_ids: set[str] = set()
    for spawn in spawns:
        # Child must be created after newTask call, before subtask_result
        lower = spawn.new_task_ts
        upper = spawn.result_ts if spawn.result_ts else spawn.new_task_ts + 120_000
        candidates = [
            (name, ts)
            for name, ts in all_tasks
            if lower <= ts <= upper and name not in used_child_ids
        ]

        if len(candidates) == 1:
            child_id = candidates[0][0]
            cost = get_task_cost(child_id)
            used_child_ids.add(child_id)
            matches.append(ChildMatch(spawn=spawn, child_task_id=child_id, cost=cost))
        elif len(candidates) > 1:
            # Pick closest to spawn time
            candidates.sort(key=lambda x: x[1] - lower)
            child_id = candidates[0][0]
            cost = get_task_cost(child_id)
            used_child_ids.add(child_id)
            matches.append(ChildMatch(spawn=spawn, child_task_id=child_id, cost=cost))
        else:
            # No match found
            matches.append(
                ChildMatch(spawn=spawn, child_task_id="(unresolved)", cost=None)
            )

    return matches


def get_task_cost(task_id: str) -> TaskCost:
    """Extract cost info from a task's ui_messages."""
    ui = load_ui_messages(task_id)
    total_cost, total_in, total_out, _, _, api_calls, _ = _aggregate_costs(ui)

    return TaskCost(
        task_id=task_id,
        total_cost=total_cost,
        tokens_in=total_in,
        tokens_out=total_out,
        api_calls=api_calls,
    )


def persist_child_relationships(parent_task_id: str, matches: list[ChildMatch]) -> int:
    """Persist resolved parent->child relationships into punch_cards.child_relationships."""
    rows_written = 0
    parent_q = _sql_quote(parent_task_id)

    for match in matches:
        child_id = match.child_task_id
        if not child_id or child_id == "(unresolved)":
            continue

        child_q = _sql_quote(child_id)
        query = (
            "INSERT IGNORE INTO punch_cards.child_relationships "
            "(parent_task_id, child_task_id, spawned_at) "
            f"VALUES ('{parent_q}', '{child_q}', "
            f"FROM_UNIXTIME({match.spawn.new_task_ts}/1000))"
        )
        out = dolt_sql(query)
        if out is None:
            return 0

        rows = _parse_csv_rows(out)
        if len(rows) > 1 and rows[1]:
            try:
                rows_written += int(rows[1][0])
            except ValueError:
                pass

    return rows_written


def verify_child_punch_card(child_task_id: str) -> tuple[bool, str | None]:
    """Verify child has a passing checkpoint and persist delegation proof state."""
    child_q = _sql_quote(child_task_id)
    check_query = (
        "SELECT dolt_commit_hash "
        "FROM punch_cards.checkpoints "
        f"WHERE task_id = '{child_q}' AND status = 'pass' "
        "ORDER BY validated_at DESC LIMIT 1"
    )
    out = dolt_sql(check_query)
    if out is None:
        return (False, None)

    rows = _parse_csv_rows(out)
    if len(rows) <= 1:
        return (False, None)

    checkpoint_hash = rows[1][0].strip() if rows[1] else ""
    checkpoint_hash = checkpoint_hash if checkpoint_hash else None

    if checkpoint_hash is None:
        update_query = (
            "UPDATE punch_cards.child_relationships "
            "SET child_card_valid = TRUE, child_checkpoint_hash = NULL "
            f"WHERE child_task_id = '{child_q}'"
        )
    else:
        hash_q = _sql_quote(checkpoint_hash)
        update_query = (
            "UPDATE punch_cards.child_relationships "
            f"SET child_card_valid = TRUE, child_checkpoint_hash = '{hash_q}' "
            f"WHERE child_task_id = '{child_q}'"
        )

    _ = dolt_sql(update_query)
    return (True, checkpoint_hash)


def cmd_children(task_id: str | None = None) -> None:
    """Show subtask tree with cost rollup for a parent task."""
    task_id = task_id or get_current_task_id()
    if not task_id:
        print("ERROR: No tasks found")
        return

    spawns = extract_spawns(task_id)
    if not spawns:
        print(f"Task: {task_id}")
        print("No subtask spawns found (no newTask calls in this task).")
        return

    matches = correlate_children(spawns)
    persisted = persist_child_relationships(task_id, matches)
    parent_cost = get_task_cost(task_id)

    # Calculate rollup
    child_total = sum(m.cost.total_cost for m in matches if m.cost is not None)
    rollup = parent_cost.total_cost + child_total

    print(f"Task: {task_id} ({len(spawns)} subtasks)")
    print(f"Total Cost (parent + children): ${rollup:.4f}")
    print(f"Persisted child relationships: {persisted}")
    print()
    print(
        f"  Parent: ${parent_cost.total_cost:.4f}"
        f"  (tokens: {parent_cost.tokens_in:,} in, {parent_cost.tokens_out:,} out,"
        f" {parent_cost.api_calls} API calls)"
    )
    print()
    print("  Children:")
    for m in matches:
        child_short = (
            m.child_task_id[:13] + "..."
            if len(m.child_task_id) > 16
            else m.child_task_id
        )
        cost_str = f"${m.cost.total_cost:.4f}" if m.cost else "   n/a "
        tok_str = (
            f"({m.cost.tokens_in:,} in, {m.cost.tokens_out:,} out)" if m.cost else ""
        )
        print(
            f"  #{m.spawn.index + 1:<2} {child_short:<16} [{m.spawn.mode:<12}]"
            f" {cost_str}  {tok_str}"
        )
        print(f"       {m.spawn.label}")


def cmd_verify_delegation(task_id: str | None = None) -> None:
    """Verify parent->child delegation proofs from child checkpoints."""
    task_id = task_id or get_current_task_id()
    if not task_id:
        print("ERROR: No tasks found")
        return

    parent_q = _sql_quote(task_id)
    query = (
        "SELECT child_task_id, child_card_valid, child_checkpoint_hash "
        "FROM punch_cards.child_relationships "
        f"WHERE parent_task_id = '{parent_q}' "
        "ORDER BY spawned_at"
    )
    out = dolt_sql(query)
    if out is None:
        print("Dolt not available")
        return

    rows = _parse_csv_rows(out)
    if len(rows) <= 1:
        print(f"Task: {task_id}")
        print("No child relationships found.")
        return

    print(f"Delegation proof report for parent: {task_id}")
    print()
    verified = 0
    for row in rows[1:]:
        if not row:
            continue
        child_task_id = row[0].strip()
        valid, checkpoint_hash = verify_child_punch_card(child_task_id)
        status = "valid" if valid else "missing"
        hash_str = checkpoint_hash if checkpoint_hash else "-"
        print(f"  {child_task_id}: {status} checkpoint_hash={hash_str}")
        if valid:
            verified += 1

    print()
    print(f"Verified child punch cards: {verified}")


def _classify_message(say: str, ask: str, text: str) -> str:
    """Classify a message into a human-readable label."""
    if ask == "tool":
        try:
            data = json.loads(text)
            tool = data.get("tool", "?")
            path = data.get("path", "")
            return f"TOOL: {tool} path={path}"
        except (json.JSONDecodeError, KeyError):
            return "TOOL: (parse error)"
    elif ask == "command":
        return f"CMD: {text[:80]}"
    elif say == "command_output":
        return f"CMD_OUT: {text[:80]}"
    elif say == "api_req_started":
        try:
            data = json.loads(text)
            cost = data.get("cost", 0)
            tokens_in = data.get("tokensIn", 0)
            tokens_out = data.get("tokensOut", 0)
            return f"API: in={tokens_in} out={tokens_out} cost=${cost:.4f}"
        except (json.JSONDecodeError, KeyError):
            return "API: (parse error)"
    elif say == "text":
        return f"TEXT: {text[:100]}"
    elif say == "completion_result":
        return f"COMPLETION: {text[:100]}"
    elif say == "checkpoint_saved":
        return f"CHECKPOINT: {text[:60]}"
    elif ask == "use_mcp_server":
        try:
            data = json.loads(text)
            return f"MCP: {data.get('serverName', '?')}:{data.get('toolName', '?')}"
        except (json.JSONDecodeError, KeyError):
            return "MCP: (parse error)"
    elif say == "mcp_server_response":
        return f"MCP_RESP: {text[:80]}"
    elif say == "mcp_server_request_started":
        return "MCP_REQ_START"
    elif say == "reasoning":
        return f"REASONING: {text[:80]}"
    else:
        return f"{say or ask}: {text[:80]}"


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return

    cmd = args[0]
    task_id = None

    if cmd == "whoami":
        cmd_whoami()
    elif cmd == "timeline":
        task_id = args[1] if len(args) > 1 else None
        cmd_timeline(task_id)
    elif cmd == "cost":
        task_id = args[1] if len(args) > 1 else None
        cmd_cost(task_id)
    elif cmd == "tools":
        task_id = args[1] if len(args) > 1 else None
        cmd_tools(task_id)
    elif cmd == "tail":
        n = int(args[1]) if len(args) > 1 else 5
        cmd_tail(n=n)
    elif cmd == "receipts":
        task_id = args[1] if len(args) > 1 else None
        cmd_receipts(task_id)
    elif cmd == "children":
        task_id = args[1] if len(args) > 1 else None
        cmd_children(task_id)
    elif cmd == "verify-delegation":
        task_id = args[1] if len(args) > 1 else None
        cmd_verify_delegation(task_id)
    else:
        print(f"Unknown command: {cmd}")
        print(
            "Commands: whoami, timeline, cost, tools, tail, receipts, children,"
            " verify-delegation"
        )


if __name__ == "__main__":
    main()
