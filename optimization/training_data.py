from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from typing import Any, Literal, cast

import dspy  # type: ignore[import-untyped]

from optimization import dolt_bus


DiagnosisCategory = Literal[
    "stuck_on_approval",
    "infinite_retry",
    "scope_creep",
    "context_exhaustion",
    "model_confusion",
]


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
    checkpoint_status: Literal["pass", "fail"] | None = None

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

        sql = """
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
        if limit is not None:
            sql = f"{sql} LIMIT %s"

        with conn.cursor() as cursor:
            if limit is None:
                cursor.execute(sql)
            else:
                cursor.execute(sql, (limit,))
            rows = cast(list[dict[str, Any]], cursor.fetchall())

        checkpoint_by_task: dict[str, Literal["pass", "fail"]] = {}
        if "checkpoints" in tables:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT c.task_id, c.status
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
                status = str(row.get("status", "")).lower()
                if status in {"pass", "fail"}:
                    checkpoint_by_task[str(row["task_id"])] = cast(
                        Literal["pass", "fail"], status
                    )

    profiles: list[TaskProfile] = []
    for row in rows:
        task_id = str(row["task_id"])
        profiles.append(
            TaskProfile(
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
                checkpoint_status=checkpoint_by_task.get(task_id),
            )
        )
    return profiles


def label_task_outcome(profile: TaskProfile) -> SessionOutcome:
    """Label session outcome using deterministic, documented heuristics."""
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


def infer_diagnosis_category(profile: TaskProfile) -> DiagnosisCategory:
    """Map telemetry patterns to fitter diagnosis categories."""
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
        total_punches=profile.total_punches,
        tool_calls=profile.tool_calls,
        total_cost=profile.total_cost,
        duration_minutes=profile.duration_minutes,
        outcome_label=labeled.outcome.value,
        diagnosis_category=labeled.diagnosis_category,
        is_kill_recovery=kill_recovery_lookup.get(profile.task_id, False),
    )
    return example.with_inputs(
        "task_id",
        "session_id",
        "summary",
        "tool_activity",
        "total_punches",
        "tool_calls",
        "total_cost",
        "duration_minutes",
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
