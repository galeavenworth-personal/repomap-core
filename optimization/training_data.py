from __future__ import annotations

import fnmatch
import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from typing import Any, Literal, cast

import dspy  # type: ignore[import-untyped]
import pymysql
from pymysql.cursors import DictCursor

from optimization import dolt_bus


DiagnosisCategory = Literal[
    "stuck_on_approval",
    "infinite_retry",
    "scope_creep",
    "context_exhaustion",
    "model_confusion",
]

CardStatus = Literal["pass", "fail"]


class SessionOutcome(str, Enum):
    """Coarse session/task outcome label for DSPy optimization datasets."""

    SUCCESS = "success"
    FAILURE = "failure"
    PARTIAL = "partial"


@dataclass(frozen=True)
class TaskProfile:
    """Aggregated signals for one task/session derived from Dolt telemetry.

    Heuristic notes:
    - Successful session: generally completes with no failure markers, moderate cost,
      and healthy completion ratio.
    - Failed session: explicit gate/checkpoint failure, or runaway signatures such as
      high cost, very long duration, or very high punch volume.
    - Partial session: completed some work but confidence is mixed.
    """

    task_id: str
    total_punches: int
    tool_calls: int
    step_start_count: int
    step_finished_count: int
    gate_pass_count: int
    gate_fail_count: int
    child_spawn_count: int
    child_complete_count: int
    total_cost: float
    duration_minutes: int
    distinct_tools: int
    read_count: int
    edit_count: int
    bash_count: int
    card_id: str | None = None
    card_status: CardStatus | None = None
    missing_punches: str | None = None
    mode: str | None = None
    checkpoint_status: Literal["pass", "fail"] | None = None
    child_modes: str | None = None
    parent_forbidden_tool_violations: str | None = None
    workflow_id: str | None = None
    bead_id: str | None = None
    bead_type: str | None = None
    hierarchy_depth: int | None = None
    parent_bead_id: str | None = None
    formula_id: str | None = None
    epic_outcome: str | None = None

    @property
    def completion_ratio(self) -> float:
        if self.step_start_count <= 0:
            return 1.0 if self.step_finished_count > 0 else 0.0
        return self.step_finished_count / self.step_start_count


@dataclass(frozen=True)
class LabeledTaskProfile:
    profile: TaskProfile
    outcome: SessionOutcome
    diagnosis_category: DiagnosisCategory


@dataclass(frozen=True)
class KillRecoveryPair:
    failed_task_id: str
    recovery_task_id: str


def _to_int(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    return int(str(value))


def _to_float(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, Decimal):
        return float(value)
    return float(str(value))


def _existing_tables(conn: Any) -> set[str]:
    with conn.cursor() as cursor:
        cursor.execute("SHOW TABLES")
        rows = cursor.fetchall()
    tables: set[str] = set()
    for row in cast(list[dict[str, Any]], rows):
        tables.update(str(v) for v in row.values())
    return tables


_PUNCH_AGGREGATE_SQL = """
    SELECT
        task_id,
        COUNT(*) AS total_punches,
        SUM(CASE WHEN punch_type = 'tool_call' THEN 1 ELSE 0 END) AS tool_calls,
        SUM(CASE WHEN punch_type = 'step_complete' AND punch_key = 'step_start_observed' THEN 1 ELSE 0 END) AS step_start_count,
        SUM(CASE WHEN punch_type = 'step_complete' AND punch_key = 'step_finished' THEN 1 ELSE 0 END) AS step_finished_count,
        SUM(CASE WHEN punch_type = 'gate_pass' THEN 1 ELSE 0 END) AS gate_pass_count,
        SUM(CASE WHEN punch_type = 'gate_fail' THEN 1 ELSE 0 END) AS gate_fail_count,
        SUM(CASE WHEN punch_type = 'child_spawn' THEN 1 ELSE 0 END) AS child_spawn_count,
        SUM(CASE WHEN punch_type = 'child_complete' THEN 1 ELSE 0 END) AS child_complete_count,
        SUM(COALESCE(cost, 0)) AS total_cost,
        COALESCE(TIMESTAMPDIFF(MINUTE, MIN(observed_at), MAX(observed_at)), 0) AS duration_minutes,
        COUNT(DISTINCT CASE WHEN punch_type = 'tool_call' THEN punch_key ELSE NULL END) AS distinct_tools,
        SUM(CASE WHEN punch_type = 'tool_call' AND LOWER(punch_key) IN ('read', 'read_file', 'readfile') THEN 1 ELSE 0 END) AS read_count,
        SUM(CASE WHEN punch_type = 'tool_call' AND LOWER(punch_key) IN ('edit', 'edit_file', 'applieddiff', 'write') THEN 1 ELSE 0 END) AS edit_count,
        SUM(CASE WHEN punch_type = 'tool_call' AND LOWER(punch_key) = 'bash' THEN 1 ELSE 0 END) AS bash_count
    FROM punches
    GROUP BY task_id
    ORDER BY task_id
"""


def _fetch_punch_rows(conn: Any, limit: int | None) -> list[dict[str, Any]]:
    """Execute the punch aggregate query and return rows."""
    sql = _PUNCH_AGGREGATE_SQL
    if limit is not None:
        sql = f"{sql} LIMIT %s"

    with conn.cursor() as cursor:
        if limit is None:
            cursor.execute(sql)
        else:
            cursor.execute(sql, (limit,))
        return cast(list[dict[str, Any]], cursor.fetchall())


@dataclass
class _CheckpointEnrichment:
    checkpoint_by_task: dict[str, CardStatus]
    card_id_by_task: dict[str, str]
    card_status_by_task: dict[str, CardStatus]
    missing_punches_by_task: dict[str, str]


@dataclass(frozen=True)
class BeadsEnrichment:
    """Per-bead metadata from the beads_repomap-core database."""

    bead_id: str
    bead_type: str | None = None
    hierarchy_depth: int | None = None
    parent_bead_id: str | None = None
    formula_id: str | None = None
    epic_outcome: str | None = None


def _load_checkpoint_enrichment(conn: Any) -> _CheckpointEnrichment:
    """Load latest checkpoint data per task from the checkpoints table."""
    enrichment = _CheckpointEnrichment(
        checkpoint_by_task={},
        card_id_by_task={},
        card_status_by_task={},
        missing_punches_by_task={},
    )
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT c.task_id, c.card_id, c.status, c.missing_punches
            FROM checkpoints c
            JOIN (
                SELECT task_id, MAX(validated_at) AS max_validated_at
                FROM checkpoints
                GROUP BY task_id
            ) latest
                ON latest.task_id = c.task_id
               AND latest.max_validated_at = c.validated_at
            """
        )
        c_rows = cast(list[dict[str, Any]], cursor.fetchall())

    for row in c_rows:
        task_id = str(row["task_id"])
        status = str(row.get("status", "")).lower()
        if status in {"pass", "fail"}:
            status_value = cast(CardStatus, status)
            enrichment.checkpoint_by_task[task_id] = status_value
            enrichment.card_status_by_task[task_id] = status_value

        card_id = row.get("card_id")
        if card_id is not None and str(card_id) != "":
            enrichment.card_id_by_task[task_id] = str(card_id)

        missing = row.get("missing_punches")
        if missing is not None and str(missing) != "":
            enrichment.missing_punches_by_task[task_id] = str(missing)

    return enrichment


def _load_task_enrichment(
    conn: Any, card_id_by_task: dict[str, str]
) -> tuple[dict[str, str], dict[str, str]]:
    """Load mode and card_id data from the tasks table.

    Returns (mode_by_task, updated card_id_by_task).
    """
    mode_by_task: dict[str, str] = {}
    with conn.cursor() as cursor:
        cursor.execute("SELECT task_id, mode, punch_card_id FROM tasks")
        t_rows = cast(list[dict[str, Any]], cursor.fetchall())

    for row in t_rows:
        task_id = str(row["task_id"])
        mode = row.get("mode")
        if mode is not None and str(mode) != "":
            mode_by_task[task_id] = str(mode)
        if task_id not in card_id_by_task:
            card_id = row.get("punch_card_id")
            if card_id is not None and str(card_id) != "":
                card_id_by_task[task_id] = str(card_id)

    return mode_by_task, card_id_by_task


def _load_bead_ids_from_tasks(conn: Any) -> dict[str, str]:
    """Load task_id -> bead_id mapping from the factory tasks table."""
    bead_id_by_task: dict[str, str] = {}
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT task_id, bead_id FROM tasks WHERE bead_id IS NOT NULL AND bead_id != ''"
        )
        rows = cast(list[dict[str, Any]], cursor.fetchall())
    for row in rows:
        bead_id_by_task[str(row["task_id"])] = str(row["bead_id"])
    return bead_id_by_task


_BEADS_ENRICHMENT_SQL = """
    SELECT
        i.id AS bead_id,
        i.issue_type AS bead_type,
        i.status AS bead_status,
        JSON_UNQUOTE(JSON_EXTRACT(i.metadata, '$.formula_id')) AS formula_id,
        d1.depends_on_id AS parent_bead_id,
        p.status AS parent_status,
        CASE
            WHEN d1.depends_on_id IS NULL THEN 1
            WHEN d2.depends_on_id IS NULL THEN 2
            ELSE 3
        END AS hierarchy_depth
    FROM issues i
    LEFT JOIN dependencies d1
        ON d1.issue_id = i.id AND d1.type = 'parent-child'
    LEFT JOIN issues p
        ON p.id = d1.depends_on_id
    LEFT JOIN dependencies d2
        ON d2.issue_id = d1.depends_on_id AND d2.type = 'parent-child'
    WHERE i.id IN ({placeholders})
"""

_logger = logging.getLogger(__name__)


def _load_beads_enrichment(bead_ids: list[str]) -> dict[str, BeadsEnrichment]:
    """Batch-load bead metadata from beads_repomap-core (read-only).

    Opens a dedicated connection to the beads database, runs a single
    query for all requested bead_ids, and returns enrichment keyed by
    bead_id. Gracefully returns an empty dict on connection failure.
    """
    if not bead_ids:
        return {}

    try:
        conn = pymysql.connect(
            host="127.0.0.1",
            port=3307,
            user="root",
            database="beads_repomap-core",
            cursorclass=DictCursor,
            autocommit=False,
        )
    except Exception:
        _logger.warning("Failed to connect to beads_repomap-core; skipping enrichment")
        return {}

    try:
        placeholders = ", ".join(["%s"] * len(bead_ids))
        sql = _BEADS_ENRICHMENT_SQL.format(placeholders=placeholders)
        with conn.cursor() as cursor:
            cursor.execute(sql, bead_ids)
            rows = cast(list[dict[str, Any]], cursor.fetchall())
    except Exception:
        _logger.warning("Beads enrichment query failed; skipping", exc_info=True)
        return {}
    finally:
        conn.close()

    result: dict[str, BeadsEnrichment] = {}
    for row in rows:
        bid = str(row["bead_id"])
        bead_type = row.get("bead_type")
        formula_id = row.get("formula_id")
        parent_bead_id = row.get("parent_bead_id")
        parent_status = row.get("parent_status")
        depth = row.get("hierarchy_depth")

        epic_outcome: str | None = None
        if parent_status is not None and str(parent_status) != "":
            epic_outcome = str(parent_status)

        result[bid] = BeadsEnrichment(
            bead_id=bid,
            bead_type=str(bead_type) if bead_type else None,
            hierarchy_depth=int(depth) if depth is not None else None,
            parent_bead_id=str(parent_bead_id) if parent_bead_id else None,
            formula_id=(
                str(formula_id) if formula_id and str(formula_id) != "null" else None
            ),
            epic_outcome=epic_outcome,
        )
    return result


def _query_child_modes_child_relationships(conn: Any) -> dict[str, str]:
    """Query child modes from the child_relationships table.

    Uses spawned_at ordering for deterministic GROUP_CONCAT results.
    """
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT cr.parent_task_id,
                   GROUP_CONCAT(t.mode ORDER BY cr.spawned_at, cr.child_task_id) AS modes
            FROM child_relationships cr
            JOIN tasks t ON t.task_id = cr.child_task_id
            WHERE t.mode IS NOT NULL AND t.mode != ''
            GROUP BY cr.parent_task_id
            """
        )
        rows = cast(list[dict[str, Any]], cursor.fetchall())
    result: dict[str, str] = {}
    for row in rows:
        parent_id = str(row["parent_task_id"])
        modes = row.get("modes")
        if modes is not None and str(modes) != "":
            result[parent_id] = str(modes)
    return result


def _query_child_modes_child_rels(conn: Any) -> dict[str, str]:
    """Query child modes from the legacy child_rels table.

    Uses task_id ordering (child_rels lacks a spawned_at column).
    """
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT cr.parent_id,
                   GROUP_CONCAT(t.mode ORDER BY t.task_id) AS modes
            FROM child_rels cr
            JOIN tasks t ON t.task_id = cr.child_id
            WHERE t.mode IS NOT NULL AND t.mode != ''
            GROUP BY cr.parent_id
            """
        )
        rows = cast(list[dict[str, Any]], cursor.fetchall())
    result: dict[str, str] = {}
    for row in rows:
        parent_id = str(row["parent_id"])
        modes = row.get("modes")
        if modes is not None and str(modes) != "":
            result[parent_id] = str(modes)
    return result


def _load_child_modes_enrichment(conn: Any, tables: set[str]) -> dict[str, str]:
    """Load child agent modes grouped by parent task.

    Returns a dict mapping parent_task_id -> comma-separated child modes
    (e.g. "code,explore,code").
    """
    if "tasks" not in tables:
        return {}
    result: dict[str, str] = {}
    if "child_relationships" in tables:
        result = _query_child_modes_child_relationships(conn)
    if "child_rels" in tables:
        fallback = _query_child_modes_child_rels(conn)
        for k, v in fallback.items():
            if k not in result:
                result[k] = v
    return result


def _sql_like_to_glob(pattern: str) -> str:
    """Convert a SQL LIKE pattern (% and _) to a fnmatch glob pattern (* and ?).

    Note: SQL LIKE treats other characters as literals, while fnmatch treats
    '*', '?', and '[' as special. We escape those so their semantics remain
    literal when coming from a LIKE pattern.
    """
    result_parts: list[str] = []
    for ch in pattern:
        if ch == "%":
            result_parts.append("*")
        elif ch == "_":
            result_parts.append("?")
        elif ch == "*":
            result_parts.append("[*]")
        elif ch == "?":
            result_parts.append("[?]")
        elif ch == "[":
            result_parts.append("[[]")
        else:
            result_parts.append(ch)
    return "".join(result_parts)


def _load_forbidden_patterns_by_card(conn: Any) -> dict[str, list[str]]:
    """Load forbidden tool_call patterns from punch_cards, grouped by card_id."""
    forbidden_patterns: dict[str, list[str]] = {}
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT card_id, punch_key_pattern
            FROM punch_cards
            WHERE forbidden = TRUE AND punch_type = 'tool_call'
            """
        )
        rows = cast(list[dict[str, Any]], cursor.fetchall())
    for row in rows:
        card_id = str(row["card_id"])
        pattern = str(row["punch_key_pattern"])
        forbidden_patterns.setdefault(card_id, []).append(pattern)
    return forbidden_patterns


def _load_task_card_mapping(conn: Any) -> dict[str, str]:
    """Load task_id -> punch_card_id mapping from the tasks table."""
    task_card: dict[str, str] = {}
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT task_id, punch_card_id FROM tasks WHERE punch_card_id IS NOT NULL"
        )
        rows = cast(list[dict[str, Any]], cursor.fetchall())
    for row in rows:
        task_card[str(row["task_id"])] = str(row["punch_card_id"])
    return task_card


def _load_tool_calls_by_task(conn: Any) -> dict[str, set[str]]:
    """Load tool_call punch_keys per task from the punches table."""
    task_tools: dict[str, set[str]] = {}
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT task_id, punch_key
            FROM punches
            WHERE punch_type = 'tool_call'
            """
        )
        rows = cast(list[dict[str, Any]], cursor.fetchall())
    for row in rows:
        tid = str(row["task_id"])
        task_tools.setdefault(tid, set()).add(str(row["punch_key"]))
    return task_tools


def _compile_forbidden_globs(
    patterns_by_card: dict[str, list[str]],
) -> dict[str, list[str]]:
    """Precompute glob patterns from SQL LIKE patterns for each card_id."""
    return {
        card_id: [_sql_like_to_glob(pat) for pat in pats]
        for card_id, pats in patterns_by_card.items()
    }


def _load_forbidden_tool_violations(conn: Any, tables: set[str]) -> dict[str, str]:
    """Detect forbidden tool violations per task.

    Cross-references each task's tool_call punches against its punch card's
    forbidden patterns.  Returns a dict mapping task_id -> comma-separated
    list of forbidden tools that were actually called.
    """
    if not ({"punches", "punch_cards", "tasks"} <= tables):
        return {}

    forbidden_patterns = _load_forbidden_patterns_by_card(conn)
    if not forbidden_patterns:
        return {}

    task_card = _load_task_card_mapping(conn)
    task_tools = _load_tool_calls_by_task(conn)
    globs_by_card = _compile_forbidden_globs(forbidden_patterns)

    violations: dict[str, str] = {}
    for task_id, card_id in task_card.items():
        glob_pats = globs_by_card.get(card_id)
        if not glob_pats:
            continue
        tools = task_tools.get(task_id)
        if not tools:
            continue
        violated: list[str] = []
        for tool in sorted(tools):
            for glob_pat in glob_pats:
                if fnmatch.fnmatchcase(tool, glob_pat):
                    violated.append(tool)
                    break
        if violated:
            violations[task_id] = ",".join(violated)

    return violations


def _load_workflow_ids(conn: Any, tables: set[str]) -> dict[str, str]:
    """Load workflow identifiers per task.

    The workflow_id is derived from the punch card's workflow_name column
    via a join from tasks.punch_card_id to punch_cards.card_id.
    """
    if not ({"tasks", "punch_cards"} <= tables):
        return {}

    workflow_ids: dict[str, str] = {}
    with conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT t.task_id, pc.workflow_name
            FROM tasks t
            JOIN punch_cards pc ON pc.card_id = t.punch_card_id
            WHERE t.punch_card_id IS NOT NULL
              AND pc.workflow_name IS NOT NULL
              AND pc.workflow_name != ''
            """
        )
        rows = cast(list[dict[str, Any]], cursor.fetchall())
    for row in rows:
        workflow_ids[str(row["task_id"])] = str(row["workflow_name"])
    return workflow_ids


def _row_to_task_profile(
    row: dict[str, Any],
    card_id_by_task: dict[str, str],
    card_status_by_task: dict[str, CardStatus],
    missing_punches_by_task: dict[str, str],
    mode_by_task: dict[str, str],
    checkpoint_by_task: dict[str, CardStatus],
    child_modes_by_task: dict[str, str] | None = None,
    forbidden_violations_by_task: dict[str, str] | None = None,
    workflow_id_by_task: dict[str, str] | None = None,
    beads_by_task: dict[str, BeadsEnrichment] | None = None,
) -> TaskProfile:
    """Convert a single punch-aggregate row into a TaskProfile."""
    task_id = str(row["task_id"])
    bead = (beads_by_task or {}).get(task_id)
    return TaskProfile(
        task_id=task_id,
        total_punches=_to_int(row.get("total_punches")),
        tool_calls=_to_int(row.get("tool_calls")),
        step_start_count=_to_int(row.get("step_start_count")),
        step_finished_count=_to_int(row.get("step_finished_count")),
        gate_pass_count=_to_int(row.get("gate_pass_count")),
        gate_fail_count=_to_int(row.get("gate_fail_count")),
        child_spawn_count=_to_int(row.get("child_spawn_count")),
        child_complete_count=_to_int(row.get("child_complete_count")),
        total_cost=_to_float(row.get("total_cost")),
        duration_minutes=_to_int(row.get("duration_minutes")),
        distinct_tools=_to_int(row.get("distinct_tools")),
        read_count=_to_int(row.get("read_count")),
        edit_count=_to_int(row.get("edit_count")),
        bash_count=_to_int(row.get("bash_count")),
        card_id=card_id_by_task.get(task_id),
        card_status=card_status_by_task.get(task_id),
        missing_punches=missing_punches_by_task.get(task_id),
        mode=mode_by_task.get(task_id),
        checkpoint_status=checkpoint_by_task.get(task_id),
        child_modes=(child_modes_by_task or {}).get(task_id),
        parent_forbidden_tool_violations=(forbidden_violations_by_task or {}).get(
            task_id
        ),
        workflow_id=(workflow_id_by_task or {}).get(task_id),
        bead_id=bead.bead_id if bead else None,
        bead_type=bead.bead_type if bead else None,
        hierarchy_depth=bead.hierarchy_depth if bead else None,
        parent_bead_id=bead.parent_bead_id if bead else None,
        formula_id=bead.formula_id if bead else None,
        epic_outcome=bead.epic_outcome if bead else None,
    )


def extract_task_profiles(limit: int | None = None) -> list[TaskProfile]:
    """Extract task/session profiles from Dolt telemetry tables.

    Read-only access pattern:
    - primary source: punches
    - optional enrichments: checkpoints
    - gracefully handles missing/empty tables
    """
    with dolt_bus._connection() as conn:  # noqa: SLF001 - internal reuse within package
        tables = _existing_tables(conn)
        if "punches" not in tables:
            return []

        rows = _fetch_punch_rows(conn, limit)

        enrichment = _CheckpointEnrichment(
            checkpoint_by_task={},
            card_id_by_task={},
            card_status_by_task={},
            missing_punches_by_task={},
        )
        if "checkpoints" in tables:
            enrichment = _load_checkpoint_enrichment(conn)

        mode_by_task: dict[str, str] = {}
        bead_id_by_task: dict[str, str] = {}
        if "tasks" in tables:
            mode_by_task, enrichment.card_id_by_task = _load_task_enrichment(
                conn, enrichment.card_id_by_task
            )
            bead_id_by_task = _load_bead_ids_from_tasks(conn)

        child_modes_by_task = _load_child_modes_enrichment(conn, tables)
        forbidden_violations_by_task = _load_forbidden_tool_violations(conn, tables)
        workflow_id_by_task = _load_workflow_ids(conn, tables)

    unique_bead_ids = list(set(bead_id_by_task.values()))
    beads_enrichment = _load_beads_enrichment(unique_bead_ids)

    beads_by_task: dict[str, BeadsEnrichment] = {}
    for task_id, bead_id in bead_id_by_task.items():
        if bead_id in beads_enrichment:
            beads_by_task[task_id] = beads_enrichment[bead_id]

    return [
        _row_to_task_profile(
            row,
            enrichment.card_id_by_task,
            enrichment.card_status_by_task,
            enrichment.missing_punches_by_task,
            mode_by_task,
            enrichment.checkpoint_by_task,
            child_modes_by_task,
            forbidden_violations_by_task,
            workflow_id_by_task,
            beads_by_task,
        )
        for row in rows
    ]


def label_task_outcome(profile: TaskProfile) -> SessionOutcome:
    """Label session outcome using deterministic, documented heuristics."""
    if profile.card_status == "fail":
        return SessionOutcome.FAILURE

    if profile.card_status == "pass":
        return SessionOutcome.SUCCESS

    if profile.checkpoint_status == "fail" or profile.gate_fail_count > 0:
        return SessionOutcome.FAILURE

    if profile.checkpoint_status == "pass":
        return SessionOutcome.SUCCESS

    if profile.total_cost >= 8.0:
        return SessionOutcome.FAILURE
    if profile.duration_minutes >= 45 and profile.total_punches >= 100:
        return SessionOutcome.FAILURE
    if profile.total_punches >= 500:
        return SessionOutcome.FAILURE

    if profile.step_start_count > 0 and profile.step_finished_count == 0:
        return SessionOutcome.FAILURE

    if (
        profile.step_finished_count > 0
        and profile.completion_ratio >= 0.7
        and profile.total_cost < 5.0
        and profile.duration_minutes <= 30
        and profile.gate_fail_count == 0
    ):
        return SessionOutcome.SUCCESS

    return SessionOutcome.PARTIAL


def _diagnose_from_card_failure(missing_punches: str) -> DiagnosisCategory | None:
    """Diagnose category from punch card missing_punches text, or None if no match."""
    missing = missing_punches.lower()
    if "forbidden" in missing:
        return "scope_creep"
    if "process_thought" in missing or "codebase___retrieval" in missing:
        return "context_exhaustion"
    if "gate_pass" in missing or "ruff" in missing or "mypy" in missing:
        return "infinite_retry"
    return None


def _diagnose_from_heuristics(profile: TaskProfile) -> DiagnosisCategory:
    """Diagnose category from telemetry heuristics (when card failure data is absent)."""
    if profile.tool_calls >= 10 and profile.step_finished_count == 0:
        return "stuck_on_approval"

    if profile.bash_count >= 12 and profile.duration_minutes <= 15:
        return "infinite_retry"

    if (
        profile.read_count >= max(20, profile.edit_count * 4)
        and profile.duration_minutes >= 20
    ):
        return "context_exhaustion"

    if profile.distinct_tools >= 8 and profile.total_punches >= 120:
        return "scope_creep"

    if profile.edit_count >= 8 and profile.read_count >= profile.edit_count:
        return "model_confusion"

    return "model_confusion"


def infer_diagnosis_category(profile: TaskProfile) -> DiagnosisCategory:
    """Map telemetry patterns to fitter diagnosis categories."""
    if profile.card_status == "fail" and profile.missing_punches:
        card_diagnosis = _diagnose_from_card_failure(profile.missing_punches)
        if card_diagnosis is not None:
            return card_diagnosis

    return _diagnose_from_heuristics(profile)


def label_profiles(profiles: Iterable[TaskProfile]) -> list[LabeledTaskProfile]:
    labeled: list[LabeledTaskProfile] = []
    for profile in profiles:
        outcome = label_task_outcome(profile)
        diagnosis = infer_diagnosis_category(profile)
        labeled.append(
            LabeledTaskProfile(
                profile=profile,
                outcome=outcome,
                diagnosis_category=diagnosis,
            )
        )
    return labeled


def extract_child_relationships() -> list[tuple[str, str]]:
    """Extract parent/child task relationships from available Dolt tables."""
    with dolt_bus._connection() as conn:  # noqa: SLF001 - internal reuse within package
        tables = _existing_tables(conn)
        relationships: list[tuple[str, str]] = []

        if "child_relationships" in tables:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT parent_task_id, child_task_id FROM child_relationships"
                )
                rows = cast(list[dict[str, Any]], cursor.fetchall())
            for row in rows:
                relationships.append(
                    (str(row["parent_task_id"]), str(row["child_task_id"]))
                )

        if "child_rels" in tables:
            with conn.cursor() as cursor:
                cursor.execute("SELECT parent_id, child_id FROM child_rels")
                rows = cast(list[dict[str, Any]], cursor.fetchall())
            for row in rows:
                relationships.append((str(row["parent_id"]), str(row["child_id"])))

    # Stable deterministic order + de-dupe
    return sorted(set(relationships))


def identify_kill_recovery_pairs(
    labeled_profiles: Iterable[LabeledTaskProfile],
    relationships: Iterable[tuple[str, str]],
) -> list[KillRecoveryPair]:
    """Identify failure->success parent/child recovery pairs."""
    outcome_by_task: dict[str, SessionOutcome] = {
        lp.profile.task_id: lp.outcome for lp in labeled_profiles
    }
    pairs: list[KillRecoveryPair] = []
    for parent, child in relationships:
        parent_outcome = outcome_by_task.get(parent)
        child_outcome = outcome_by_task.get(child)
        if (
            parent_outcome == SessionOutcome.FAILURE
            and child_outcome == SessionOutcome.SUCCESS
        ):
            pairs.append(
                KillRecoveryPair(failed_task_id=parent, recovery_task_id=child)
            )
    return sorted(pairs, key=lambda pair: (pair.failed_task_id, pair.recovery_task_id))


def _tool_activity(profile: TaskProfile) -> str:
    return "\n".join(
        [
            f"  - tool_calls: {profile.tool_calls}",
            f"  - distinct_tools: {profile.distinct_tools}",
            f"  - read_calls: {profile.read_count}",
            f"  - edit_calls: {profile.edit_count}",
            f"  - bash_calls: {profile.bash_count}",
            f"  - step_started: {profile.step_start_count}",
            f"  - step_finished: {profile.step_finished_count}",
        ]
    )


def _summary(profile: TaskProfile, outcome: SessionOutcome) -> str:
    checkpoint = (
        profile.checkpoint_status if profile.checkpoint_status is not None else "none"
    )
    return (
        f"task={profile.task_id} outcome={outcome.value} checkpoint={checkpoint} "
        f"cost={profile.total_cost:.4f} duration_min={profile.duration_minutes} "
        f"punches={profile.total_punches} completion_ratio={profile.completion_ratio:.2f}"
    )


def build_dspy_example(
    labeled: LabeledTaskProfile,
    kill_recovery_lookup: Mapping[str, bool],
) -> dspy.Example:
    profile = labeled.profile
    example = dspy.Example(
        task_id=profile.task_id,
        session_id=profile.task_id,
        summary=_summary(profile, labeled.outcome),
        tool_activity=_tool_activity(profile),
        card_id=profile.card_id,
        card_status=profile.card_status,
        missing_punches=profile.missing_punches,
        mode=profile.mode,
        total_punches=profile.total_punches,
        tool_calls=profile.tool_calls,
        total_cost=profile.total_cost,
        duration_minutes=profile.duration_minutes,
        child_modes=profile.child_modes,
        parent_forbidden_tool_violations=profile.parent_forbidden_tool_violations,
        workflow_id=profile.workflow_id,
        outcome_label=labeled.outcome.value,
        diagnosis_category=labeled.diagnosis_category,
        is_kill_recovery=kill_recovery_lookup.get(profile.task_id, False),
    )
    return example.with_inputs(
        "task_id",
        "session_id",
        "summary",
        "tool_activity",
        "card_id",
        "card_status",
        "missing_punches",
        "mode",
        "total_punches",
        "tool_calls",
        "total_cost",
        "duration_minutes",
        "child_modes",
        "parent_forbidden_tool_violations",
        "workflow_id",
    )


def build_training_set(limit: int | None = None) -> list[dspy.Example]:
    """Build a labeled DSPy training set from historical Dolt telemetry."""
    profiles = extract_task_profiles(limit=limit)
    labeled_profiles = label_profiles(profiles)

    relationships = extract_child_relationships()
    pairs = identify_kill_recovery_pairs(labeled_profiles, relationships)
    recovery_lookup: dict[str, bool] = {}
    for pair in pairs:
        recovery_lookup[pair.failed_task_id] = True
        recovery_lookup[pair.recovery_task_id] = True

    return [
        build_dspy_example(labeled, recovery_lookup)
        for labeled in sorted(labeled_profiles, key=lambda item: item.profile.task_id)
    ]
