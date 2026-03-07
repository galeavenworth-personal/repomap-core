#!/usr/bin/env python3
"""Punch card engine for task verification."""

import argparse
import csv
import datetime
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

KILO_STORAGE = Path.home() / ".config/Code/User/globalStorage/kilocode.kilo-code"
TASKS_DIR = KILO_STORAGE / "tasks"
DOLT_BIN = shutil.which("dolt")
DOLT_DATA_DIR = Path.home() / ".dolt-data/beads"
GATE_RUNS_JSONL = Path(".kilocode/gate_runs.jsonl")
BATCH_SIZE = 1000
KILO_SERVE_BASE_URL = "http://127.0.0.1:4096"
KILO_SERVE_TIMEOUT = 5  # seconds


def _sql_escape_literal(value: str) -> str:
    """Escape single quotes in a SQL string literal; no surrounding quotes."""
    return value.replace("'", "''")


def _parse_csv_rows(csv_text: str) -> list[list[str]]:
    """Parse CSV output into rows using Python's csv module."""
    if not csv_text or not csv_text.strip():
        return []
    return list(csv.reader(io.StringIO(csv_text)))


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
    """Get the most recently modified task directory (likely the current task).

    Uses filesystem mtime heuristic — same approach as kilo_session_monitor.py.
    """
    if not TASKS_DIR.exists():
        return None
    task_dirs = sorted(
        TASKS_DIR.iterdir(),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return task_dirs[0].name if task_dirs else None


def _is_uuid(value: str) -> bool:
    """Return True when value parses as an RFC4122 UUID string."""
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def resolve_child_from_session_api(
    parent_session_id: str,
    child_index: int = 0,
    base_url: str = KILO_SERVE_BASE_URL,
    timeout: int = KILO_SERVE_TIMEOUT,
) -> str | None:
    """Query kilo serve session API to resolve a child task UUID deterministically.

    Calls GET ``{base_url}/session/{parent_session_id}/children`` and returns
    the child task ID at *child_index*, or ``None`` when the API is unreachable
    or the child does not exist.
    """
    url = f"{base_url}/session/{parent_session_id}/children"
    req = Request(url, method="GET")
    req.add_header("Accept", "application/json")
    try:
        with urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (URLError, OSError, json.JSONDecodeError, ValueError) as exc:
        print(
            f"WARNING: kilo serve session API unreachable ({url}): {exc}",
            file=sys.stderr,
        )
        return None

    if not isinstance(data, list):
        print(
            f"WARNING: unexpected response from {url}: expected JSON array",
            file=sys.stderr,
        )
        return None

    if child_index < 0 or child_index >= len(data):
        return None

    child = data[child_index]
    child_id = child.get("id") if isinstance(child, dict) else None
    if isinstance(child_id, str) and _is_uuid(child_id):
        return child_id
    return None


def resolve_task_id(
    raw_task_id: str,
    parent_session: str | None = None,
    child_index: int = 0,
) -> str:
    """Resolve a task ID using a 3-tier strategy.

    Resolution order:
    1. **Explicit UUID** — if *raw_task_id* parses as a UUID, return it directly.
    2. **Kilo serve session API** — if *parent_session* is provided and
       *raw_task_id* is ``"auto"``, query the kilo serve children endpoint.
    3. **Filesystem mtime heuristic** — fall back to the most-recently-modified
       task directory, emitting a WARNING to stderr.

    Raises ``SystemExit`` with a clear message when all methods fail.
    """
    # Tier 1: explicit UUID passthrough
    if _is_uuid(raw_task_id):
        return raw_task_id

    if raw_task_id.lower() != "auto":
        # Non-UUID, non-auto sentinel — pass through as-is
        return raw_task_id

    # Tier 2: kilo serve session API
    if parent_session:
        child_id = resolve_child_from_session_api(
            parent_session, child_index=child_index
        )
        if child_id is not None:
            print(
                f"Resolved task_id from kilo serve session API "
                f"(parent={parent_session}, index={child_index}): {child_id}",
                file=sys.stderr,
            )
            return child_id
        print(
            f"WARNING: kilo serve session API did not return a child "
            f"(parent={parent_session}, index={child_index}), "
            "falling back to mtime heuristic",
            file=sys.stderr,
        )

    # Tier 3: filesystem mtime heuristic (with warning)
    discovered = get_current_task_id()
    if discovered is not None:
        if not parent_session:
            print(
                "WARNING: falling back to mtime heuristic "
                "(no --parent-session provided)",
                file=sys.stderr,
            )
        print(
            f"Auto-discovered task_id from VS Code tasks dir: {discovered}",
            file=sys.stderr,
        )
        return discovered

    print(
        "ERROR: task_id 'auto' requested but all resolution methods failed. "
        f"No task directories found in {TASKS_DIR}",
        file=sys.stderr,
    )
    sys.exit(1)


def load_ui_messages(task_id: str) -> list[dict]:
    """Load ui_messages.json for a given task."""
    path = TASKS_DIR / task_id / "ui_messages.json"
    try:
        path.resolve().relative_to(TASKS_DIR.resolve())
    except ValueError:
        print(f"WARNING: task_id traversal blocked: {task_id}", file=sys.stderr)
        return []
    if not path.exists():
        task_dir = TASKS_DIR / task_id
        if not task_dir.exists():
            print(
                f"WARNING: task directory not found: {task_dir} — "
                "is this a valid Kilo Code task UUID? "
                "(hint: use 'auto' as task_id for auto-discovery)",
                file=sys.stderr,
            )
        else:
            print(
                f"WARNING: ui_messages.json not found in {task_dir}",
                file=sys.stderr,
            )
        return []
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        print(
            f"WARNING: corrupt ui_messages.json for task {task_id}: {exc}",
            file=sys.stderr,
        )
        return []


def _observed_at_from_ts(ts_ms: int | float) -> tuple[str, str]:
    """Build ISO + SQL datetime strings from millisecond epoch timestamp."""
    dt = datetime.datetime.fromtimestamp(ts_ms / 1000, tz=datetime.timezone.utc)
    observed_iso = dt.isoformat()
    observed_sql = dt.strftime("%Y-%m-%d %H:%M:%S")
    return observed_iso, observed_sql


def _build_source_hash(
    task_id: str,
    punch_type: str,
    punch_key: str,
    observed_at_iso: str,
) -> str:
    """Compute deterministic source hash for punch deduplication."""
    raw = f"{task_id}:{punch_type}:{punch_key}:{observed_at_iso}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _to_int_timestamp(value: object) -> int | None:
    """Normalize timestamp-like values to int milliseconds when possible."""
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def _parse_json_text(text: object) -> dict | None:
    """Parse message text JSON safely and return dict payload if present."""
    if not isinstance(text, str):
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def _normalize_tool_name(name: str) -> str:
    """Convert camelCase tool names to snake_case for punch-card matching.

    Kilo Code UI emits camelCase (editFile, applyDiff, writeToFile, readFile,
    newTask).  Punch cards use snake_case patterns (edit_file%, apply_diff%,
    write_to_file%).
    """
    # Insert underscore before uppercase letters, then lowercase
    s1 = re.sub(r"([A-Z])", r"_\1", name)
    return s1.lower().lstrip("_")


def _emit_punch(
    punches: list[tuple[str, str, str, str]],
    task_id: str,
    punch_type: str,
    punch_key: str,
    ts_ms: int,
) -> None:
    """Append one normalized punch tuple for later SQL insert batching."""
    observed_iso, observed_sql = _observed_at_from_ts(ts_ms)
    source_hash = _build_source_hash(task_id, punch_type, punch_key, observed_iso)
    punches.append((punch_type, punch_key, observed_sql, source_hash))


def _extract_ui_punches(
    task_id: str, ui_messages: list[dict]
) -> list[tuple[str, str, str, str]]:
    """Extract punch tuples from ui_messages according to event mapping rules."""
    punches: list[tuple[str, str, str, str]] = []

    for msg in ui_messages:
        ts_ms = _to_int_timestamp(msg.get("ts"))
        if ts_ms is None:
            continue

        ask = msg.get("ask")
        say = msg.get("say")

        if ask == "tool":
            data = _parse_json_text(msg.get("text"))
            if not data:
                continue

            tool_name = data.get("tool")
            if tool_name == "newTask":
                mode = data.get("mode")
                if isinstance(mode, str) and mode:
                    _emit_punch(
                        punches,
                        task_id,
                        "child_spawn",
                        _normalize_tool_name(mode),
                        ts_ms,
                    )
                continue

            if isinstance(tool_name, str) and tool_name:
                _emit_punch(
                    punches,
                    task_id,
                    "tool_call",
                    _normalize_tool_name(tool_name),
                    ts_ms,
                )
            continue

        if ask == "command":
            text = str(msg.get("text", ""))
            cmd_text = text[:197] + "..." if len(text) > 200 else text
            _emit_punch(punches, task_id, "command_exec", cmd_text, ts_ms)
            continue

        if ask == "use_mcp_server":
            data = _parse_json_text(msg.get("text"))
            if not data:
                continue
            server = data.get("serverName")
            tool = data.get("toolName")
            if isinstance(server, str) and isinstance(tool, str):
                _emit_punch(punches, task_id, "mcp_call", f"{server}:{tool}", ts_ms)
            continue

        if say == "completion_result":
            _emit_punch(punches, task_id, "step_complete", "task_exit", ts_ms)
            continue

        if say == "subtask_result":
            _emit_punch(punches, task_id, "child_complete", "child_return", ts_ms)
            continue

    return punches


def _extract_gate_punches(
    task_id: str, bead_id: str | None
) -> list[tuple[str, str, str, str]]:
    """Extract gate pass/fail punches from gate_runs JSONL matching bead_id."""
    punches: list[tuple[str, str, str, str]] = []
    if bead_id is None:
        return punches
    if not GATE_RUNS_JSONL.exists():
        return punches

    try:
        lines = GATE_RUNS_JSONL.read_text().splitlines()
    except OSError as exc:
        print(f"WARNING: cannot read {GATE_RUNS_JSONL}: {exc}", file=sys.stderr)
        return punches

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        if rec.get("bead_id") != bead_id:
            continue

        gate_id = rec.get("gate_id")
        if not isinstance(gate_id, str) or not gate_id:
            continue

        run_ts = rec.get("run_timestamp")
        ts_ms = _to_int_timestamp(run_ts)
        if ts_ms is None and isinstance(run_ts, str):
            try:
                dt = datetime.datetime.fromisoformat(run_ts.replace("Z", "+00:00"))
                ts_ms = int(dt.timestamp() * 1000)
            except ValueError:
                pass
        if ts_ms is None:
            continue

        exit_code = rec.get("exit_code")
        if not isinstance(exit_code, int):
            continue

        punch_type = "gate_pass" if exit_code == 0 else "gate_fail"
        _emit_punch(punches, task_id, punch_type, gate_id, ts_ms)

    return punches


def _insert_punches(
    task_id: str,
    punches: list[tuple[str, str, str, str]],
) -> int:
    """Insert punches using INSERT IGNORE batch SQL and return inserted count."""
    if not punches:
        return 0

    task_q = _sql_escape_literal(task_id)

    before_out = dolt_sql(
        f"SELECT COUNT(*) FROM punch_cards.punches WHERE task_id = '{task_q}'"
    )
    before_count = 0
    if before_out:
        rows = _parse_csv_rows(before_out)
        if len(rows) >= 2 and rows[1]:
            try:
                before_count = int(rows[1][0])
            except ValueError:
                pass

    value_parts: list[str] = []
    for punch_type, punch_key, observed_at, source_hash in punches:
        punch_type_q = _sql_escape_literal(punch_type)
        punch_key_q = _sql_escape_literal(punch_key)
        observed_at_q = _sql_escape_literal(observed_at)
        source_hash_q = _sql_escape_literal(source_hash)
        value_parts.append(
            "("
            f"'{task_q}', '{punch_type_q}', '{punch_key_q}', "
            f"'{observed_at_q}', '{source_hash_q}'"
            ")"
        )

    for i in range(0, len(value_parts), BATCH_SIZE):
        batch = value_parts[i : i + BATCH_SIZE]
        insert_query = (
            "INSERT IGNORE INTO punch_cards.punches "
            "(task_id, punch_type, punch_key, observed_at, source_hash) VALUES "
            + ", ".join(batch)
        )
        out = dolt_sql(insert_query)
        if out is None:
            return 0

    after_out = dolt_sql(
        f"SELECT COUNT(*) FROM punch_cards.punches WHERE task_id = '{task_q}'"
    )
    after_count = 0
    if after_out:
        rows = _parse_csv_rows(after_out)
        if len(rows) >= 2 and rows[1]:
            try:
                after_count = int(rows[1][0])
            except ValueError:
                pass

    return after_count - before_count


def cmd_mint(task_id: str, bead_id: str | None = None) -> int:
    """Mint punches from task ui_messages.json and optional gate_runs.jsonl."""
    ui_messages = load_ui_messages(task_id)
    ui_punches = _extract_ui_punches(task_id, ui_messages)
    gate_punches = _extract_gate_punches(task_id, bead_id)
    all_punches = ui_punches + gate_punches
    inserted_count = _insert_punches(task_id, all_punches)
    print(f"Minted punches: {inserted_count}")
    return inserted_count


def _fetch_card_requirements(card_id: str) -> list[dict[str, object]]:
    """Load punch card requirement rows for the provided card_id."""
    card_q = _sql_escape_literal(card_id)
    query = (
        "SELECT punch_type, punch_key_pattern, required, forbidden, description "
        "FROM punch_cards.punch_cards "
        f"WHERE card_id = '{card_q}'"
    )
    out = dolt_sql(query)
    if out is None:
        return []

    rows = _parse_csv_rows(out)
    if len(rows) <= 1:
        return []

    reqs: list[dict[str, object]] = []
    for row in rows[1:]:
        if len(row) < 5:
            continue
        required_value = row[2].strip().lower()
        required = required_value in {"1", "true", "t", "yes", "y"}
        forbidden_value = row[3].strip().lower()
        forbidden = forbidden_value in {"1", "true", "t", "yes", "y"}
        reqs.append(
            {
                "punch_type": row[0],
                "punch_key_pattern": row[1],
                "required": required,
                "forbidden": forbidden,
                "description": row[4],
            }
        )
    return reqs


def _count_matching_punches(
    task_id: str, punch_type: str, punch_key_pattern: str
) -> int:
    """Count matching punches for a task, type, and LIKE key pattern."""
    task_q = _sql_escape_literal(task_id)
    type_q = _sql_escape_literal(punch_type)
    pattern_q = _sql_escape_literal(punch_key_pattern)
    query = (
        "SELECT COUNT(*) "
        "FROM punch_cards.punches "
        f"WHERE task_id = '{task_q}' AND punch_type = '{type_q}' "
        f"AND punch_key LIKE '{pattern_q}'"
    )
    out = dolt_sql(query)
    if out is None:
        return 0
    rows = _parse_csv_rows(out)
    if len(rows) < 2 or not rows[1]:
        return 0
    try:
        return int(rows[1][0])
    except ValueError:
        return 0


def cmd_evaluate(
    task_id: str, card_id: str
) -> tuple[str, list[dict[str, str]], list[dict[str, str]]]:
    """Evaluate whether required punches exist for task/card requirements.

    Handles two enforcement modes per row:
    - required=TRUE, forbidden=FALSE → punch must exist (count == 0 → fail)
    - required=TRUE, forbidden=TRUE  → punch must NOT exist (count > 0 → fail)
    - required=FALSE → skip (informational/optional row)
    """
    requirements = _fetch_card_requirements(card_id)
    if not requirements:
        print(f"FAIL: no requirements found for card_id '{card_id}'", file=sys.stderr)
        return "fail", [], []

    missing: list[dict[str, str]] = []
    violations: list[dict[str, str]] = []

    for req in requirements:
        required = bool(req.get("required"))
        if not required:
            continue
        forbidden = bool(req.get("forbidden"))
        punch_type = str(req.get("punch_type", ""))
        punch_key_pattern = str(req.get("punch_key_pattern", ""))
        description = str(req.get("description", ""))
        count = _count_matching_punches(task_id, punch_type, punch_key_pattern)

        if forbidden and count > 0:
            violations.append(
                {
                    "punch_type": punch_type,
                    "punch_key_pattern": punch_key_pattern,
                    "description": description,
                    "count": str(count),
                }
            )
        elif not forbidden and count == 0:
            missing.append(
                {
                    "punch_type": punch_type,
                    "punch_key_pattern": punch_key_pattern,
                    "description": description,
                }
            )

    has_failures = bool(missing) or bool(violations)
    status = "pass" if not has_failures else "fail"
    print(f"Status: {status}")
    if missing:
        print("Missing required punches:")
        for item in missing:
            print(
                "- "
                f"{item['punch_type']} key LIKE {item['punch_key_pattern']} "
                f"({item['description']})"
            )
    if violations:
        print("Forbidden punch violations (anti-delegation):")
        for item in violations:
            print(
                "- "
                f"{item['punch_type']} key LIKE {item['punch_key_pattern']} "
                f"found {item['count']}x ({item['description']})"
            )
    return status, missing, violations


def _insert_checkpoint(
    task_id: str,
    card_id: str,
    status: str,
    validated_at: str,
    missing: list[dict[str, str]],
    violations: list[dict[str, str]],
) -> int | None:
    """Insert checkpoint row and return checkpoint_id from LAST_INSERT_ID."""
    task_q = _sql_escape_literal(task_id)
    card_q = _sql_escape_literal(card_id)
    status_q = _sql_escape_literal(status)
    validated_q = _sql_escape_literal(validated_at)

    if missing:
        missing_json = json.dumps(missing, separators=(",", ":"))
        missing_clause = f"'{_sql_escape_literal(missing_json)}'"
    else:
        missing_clause = "NULL"

    if violations:
        violations_json = json.dumps(violations, separators=(",", ":"))
        violations_clause = f"'{_sql_escape_literal(violations_json)}'"
    else:
        violations_clause = "NULL"

    insert_query = (
        "INSERT INTO punch_cards.checkpoints "
        "(task_id, card_id, status, validated_at, missing_punches, violations) "
        "VALUES "
        f"('{task_q}', '{card_q}', '{status_q}', '{validated_q}', "
        f"{missing_clause}, {violations_clause})"
    )
    out = dolt_sql(insert_query)
    if out is None:
        return None

    # Re-query by unique constraint — LAST_INSERT_ID() is session-scoped
    # and each dolt_sql() call spawns a new process.
    id_query = (
        "SELECT checkpoint_id FROM punch_cards.checkpoints "
        f"WHERE task_id = '{task_q}' AND card_id = '{card_q}' "
        f"AND validated_at = '{validated_q}' "
        "ORDER BY checkpoint_id DESC LIMIT 1"
    )
    id_out = dolt_sql(id_query)
    if id_out is None:
        return None
    rows = _parse_csv_rows(id_out)
    if len(rows) < 2 or not rows[1]:
        return None
    try:
        return int(rows[1][0])
    except ValueError:
        return None


def _commit_if_pass(task_id: str, card_id: str) -> str | None:
    """Create Dolt commit for passing checkpoint and return HEAD hash."""
    commit_msg = f"checkpoint: {card_id} pass for {task_id}"
    commit_msg_q = _sql_escape_literal(commit_msg)
    add_out = dolt_sql("CALL DOLT_ADD('.')")
    if add_out is None:
        return None
    commit_out = dolt_sql(f"CALL DOLT_COMMIT('-m', '{commit_msg_q}')")
    if commit_out is None:
        return None
    hash_out = dolt_sql("SELECT HASHOF('HEAD')")
    if hash_out is None:
        return None
    rows = _parse_csv_rows(hash_out)
    if len(rows) < 2 or not rows[1]:
        return None
    return rows[1][0]


def _update_checkpoint_commit_hash(checkpoint_id: int, commit_hash: str) -> bool:
    """Update checkpoint row with Dolt commit hash and report success."""
    commit_q = _sql_escape_literal(commit_hash)
    query = (
        "UPDATE punch_cards.checkpoints "
        f"SET dolt_commit_hash = '{commit_q}' "
        f"WHERE checkpoint_id = {checkpoint_id}"
    )
    out = dolt_sql(query)
    return out is not None


def cmd_checkpoint(task_id: str, card_id: str) -> tuple[int | None, str | None, str]:
    """Evaluate card, persist checkpoint, and optionally commit on pass."""
    status, missing, violations = cmd_evaluate(task_id, card_id)
    validated_at = datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    checkpoint_id = _insert_checkpoint(
        task_id, card_id, status, validated_at, missing, violations
    )
    if checkpoint_id is None:
        print("checkpoint_id: n/a")
        print("dolt_commit_hash: n/a")
        return None, None, status

    dolt_commit_hash: str | None = None
    if status == "pass":
        dolt_commit_hash = _commit_if_pass(task_id, card_id)
        if dolt_commit_hash:
            if not _update_checkpoint_commit_hash(checkpoint_id, dolt_commit_hash):
                print(
                    f"WARNING: failed to update checkpoint {checkpoint_id} with commit hash",
                    file=sys.stderr,
                )

    print(f"checkpoint_id: {checkpoint_id}")
    print(f"dolt_commit_hash: {dolt_commit_hash or 'n/a'}")
    print(
        "checkpoint_record: "
        + json.dumps(
            {
                "missing_punches": missing,
                "violations": violations,
            },
            separators=(",", ":"),
        )
    )
    return checkpoint_id, dolt_commit_hash, status


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser for punch_engine subcommands.

    Extracted so that tests can validate argument parsing without
    reconstructing the parser manually.
    """
    parser = argparse.ArgumentParser(
        prog="punch_engine",
        description="Punch card engine for task verification",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── Shared optional arguments for deterministic ID resolution ──
    def _add_session_args(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument(
            "--parent-session",
            default=None,
            help=(
                "Parent kilo serve session UUID.  When task_id is 'auto', "
                "the engine queries the kilo serve /session/{id}/children "
                "endpoint to resolve the child task ID deterministically."
            ),
        )
        subparser.add_argument(
            "--child-index",
            type=int,
            default=0,
            help=(
                "Zero-based index into the children array returned by the "
                "session API (default: 0)."
            ),
        )

    mint_p = sub.add_parser("mint", help="Mint punches from task events")
    mint_p.add_argument(
        "task_id",
        help="Kilo Code task UUID, or 'auto' to discover the current task",
    )
    mint_p.add_argument(
        "--bead-id",
        default=None,
        help="Beads issue ID for gate_runs.jsonl matching",
    )
    _add_session_args(mint_p)

    eval_p = sub.add_parser("evaluate", help="Evaluate a punch card for a task")
    eval_p.add_argument(
        "task_id",
        help="Kilo Code task UUID, or 'auto' to discover the current task",
    )
    eval_p.add_argument("card_id")
    _add_session_args(eval_p)

    cp_p = sub.add_parser(
        "checkpoint",
        help="Create a checkpoint from evaluation",
    )
    cp_p.add_argument(
        "task_id",
        help="Kilo Code task UUID, or 'auto' to discover the current task",
    )
    cp_p.add_argument("card_id")
    _add_session_args(cp_p)

    return parser


def main() -> int:
    """CLI entry point for mint/evaluate/checkpoint commands."""
    parser = build_parser()
    args = parser.parse_args()

    # Resolve 'auto' sentinel to the actual current task UUID
    task_id = resolve_task_id(
        args.task_id,
        parent_session=args.parent_session,
        child_index=args.child_index,
    )

    if args.command == "mint":
        cmd_mint(task_id, bead_id=args.bead_id)
        return 0
    elif args.command == "evaluate":
        status, _missing, _violations = cmd_evaluate(task_id, args.card_id)
        return 0 if status == "pass" else 1
    elif args.command == "checkpoint":
        _cp_id, _hash, status = cmd_checkpoint(task_id, args.card_id)
        return 0 if status == "pass" else 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
