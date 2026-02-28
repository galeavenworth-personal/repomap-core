from __future__ import annotations

from optimization import training_data as td


def _profile(**overrides: object) -> td.TaskProfile:
    base = td.TaskProfile(
        task_id="task-1",
        total_punches=20,
        tool_calls=8,
        step_start_count=10,
        step_finished_count=9,
        gate_pass_count=0,
        gate_fail_count=0,
        child_spawn_count=0,
        child_complete_count=0,
        total_cost=1.2,
        duration_minutes=12,
        distinct_tools=4,
        read_count=5,
        edit_count=3,
        bash_count=2,
        checkpoint_status=None,
    )
    return td.TaskProfile(**{**base.__dict__, **overrides})


def test_label_task_outcome_success_from_checkpoint_pass() -> None:
    profile = _profile(checkpoint_status="pass")
    assert td.label_task_outcome(profile) == td.SessionOutcome.SUCCESS


def test_label_task_outcome_failure_from_checkpoint_fail() -> None:
    profile = _profile(checkpoint_status="fail")
    assert td.label_task_outcome(profile) == td.SessionOutcome.FAILURE


def test_label_task_outcome_failure_from_runaway_cost() -> None:
    profile = _profile(total_cost=9.1)
    assert td.label_task_outcome(profile) == td.SessionOutcome.FAILURE


def test_label_task_outcome_partial_for_mixed_signals() -> None:
    profile = _profile(
        total_cost=4.2,
        duration_minutes=35,
        step_start_count=10,
        step_finished_count=5,
    )
    assert td.label_task_outcome(profile) == td.SessionOutcome.PARTIAL


def test_infer_diagnosis_infinite_retry() -> None:
    profile = _profile(bash_count=14, duration_minutes=10)
    assert td.infer_diagnosis_category(profile) == "infinite_retry"


def test_infer_diagnosis_context_exhaustion() -> None:
    profile = _profile(read_count=40, edit_count=5, duration_minutes=30)
    assert td.infer_diagnosis_category(profile) == "context_exhaustion"


def test_identify_kill_recovery_pairs() -> None:
    failed = td.LabeledTaskProfile(
        profile=_profile(task_id="parent-fail", total_cost=10.0),
        outcome=td.SessionOutcome.FAILURE,
        diagnosis_category="model_confusion",
    )
    recovered = td.LabeledTaskProfile(
        profile=_profile(task_id="child-success", checkpoint_status="pass"),
        outcome=td.SessionOutcome.SUCCESS,
        diagnosis_category="scope_creep",
    )
    pairs = td.identify_kill_recovery_pairs(
        [failed, recovered],
        [("parent-fail", "child-success")],
    )
    assert pairs == [
        td.KillRecoveryPair(
            failed_task_id="parent-fail", recovery_task_id="child-success"
        )
    ]


def test_build_dspy_example_contains_labels() -> None:
    labeled = td.LabeledTaskProfile(
        profile=_profile(task_id="t-123", total_cost=0.7),
        outcome=td.SessionOutcome.SUCCESS,
        diagnosis_category="scope_creep",
    )
    example = td.build_dspy_example(labeled, {"t-123": True})
    assert example.outcome_label == "success"
    assert example.diagnosis_category == "scope_creep"
    assert example.is_kill_recovery is True
