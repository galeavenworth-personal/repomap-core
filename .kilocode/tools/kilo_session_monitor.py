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

NOTE: This script is gitignored. It reads from Kilo Code's internal
storage format (~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks/).
This format is not a public API and may change between versions.
"""

import json
import datetime
import sys
from collections import Counter
from pathlib import Path

KILO_STORAGE = Path.home() / ".config/Code/User/globalStorage/kilocode.kilo-code"
TASKS_DIR = KILO_STORAGE / "tasks"


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

    total_cost = 0.0
    total_in = 0
    total_out = 0
    total_cache_reads = 0
    total_cache_writes = 0
    api_calls = 0
    providers = Counter()

    for m in ui:
        if m.get("say") == "api_req_started":
            try:
                data = json.loads(m["text"])
                total_cost += data.get("cost", 0)
                total_in += data.get("tokensIn", 0)
                total_out += data.get("tokensOut", 0)
                total_cache_reads += data.get("cacheReads", 0)
                total_cache_writes += data.get("cacheWrites", 0)
                api_calls += 1
                provider = data.get("inferenceProvider", "unknown")
                providers[provider] += 1
            except (json.JSONDecodeError, KeyError):
                pass

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
    else:
        print(f"Unknown command: {cmd}")
        print("Commands: whoami, timeline, cost, tools, tail, receipts")


if __name__ == "__main__":
    main()
