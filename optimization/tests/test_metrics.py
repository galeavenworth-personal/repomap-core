from __future__ import annotations

from typing import Any

import dspy  # type: ignore[import-untyped]
import pytest

from optimization import metrics


def _example(**overrides: Any) -> dspy.Example:
    base: dict[str, Any] = {
        "task_id": "task-1",
        "session_id": "task-1",
        "summary": (
            "task=task-1 outcome=success checkpoint=pass cost=1.2000 "
            "duration_min=12 punches=20 completion_ratio=0.90"
        ),
        "tool_activity": "\n".join(
            [
                "  - tool_calls: 10",
                "  - distinct_tools: 4",
                "  - read_calls: 5",
                "  - edit_calls: 3",
                "  - bash_calls: 2",
                "  - step_started: 10",
                "  - step_finished: 9",
            ]
        ),
        "total_punches": 20,
        "tool_calls": 10,
        "total_cost": 1.2,
        "duration_minutes": 12,
        "outcome_label": "success",
        "diagnosis_category": "model_confusion",
        "is_kill_recovery": False,
    }
    payload = {**base, **overrides}
    return dspy.Example(**payload).with_inputs(
        "task_id",
        "session_id",
        "summary",
        "tool_activity",
        "total_punches",
        "tool_calls",
        "total_cost",
        "duration_minutes",
    )


def test_punch_card_pass_rate_checkpoint_pass() -> None:
    example = _example()
    assert metrics.punch_card_pass_rate(example) == pytest.approx(1.0)


def test_punch_card_pass_rate_checkpoint_fail() -> None:
    example = _example(
        summary=(
            "task=task-1 outcome=failure checkpoint=fail cost=1.2000 "
            "duration_min=12 punches=20 completion_ratio=0.90"
        )
    )
    assert metrics.punch_card_pass_rate(example) == pytest.approx(0.0)


def test_punch_card_pass_rate_checkpoint_none_uses_completion_ratio() -> None:
    example = _example(
        summary=(
            "task=task-1 outcome=partial checkpoint=none cost=1.2000 "
            "duration_min=12 punches=20 completion_ratio=0.65"
        )
    )
    assert metrics.punch_card_pass_rate(example) == pytest.approx(0.65)


def test_cost_efficiency_low_mid_high() -> None:
    assert metrics.cost_efficiency(_example(total_cost=0.0)) == pytest.approx(1.0)
    assert metrics.cost_efficiency(_example(total_cost=4.0)) == pytest.approx(0.5)
    assert metrics.cost_efficiency(_example(total_cost=10.0)) == pytest.approx(0.0)


def test_task_completion_rate_success_failure_partial() -> None:
    assert metrics.task_completion_rate(
        _example(outcome_label="success")
    ) == pytest.approx(1.0)
    assert metrics.task_completion_rate(
        _example(outcome_label="failure")
    ) == pytest.approx(0.0)
    assert metrics.task_completion_rate(
        _example(outcome_label="partial")
    ) == pytest.approx(0.0)


def test_fitter_recovery_success_rate_cases() -> None:
    assert metrics.fitter_recovery_success_rate(
        _example(is_kill_recovery=True, outcome_label="success")
    ) == pytest.approx(1.0)
    assert metrics.fitter_recovery_success_rate(
        _example(is_kill_recovery=True, outcome_label="failure")
    ) == pytest.approx(0.0)
    assert metrics.fitter_recovery_success_rate(
        _example(is_kill_recovery=False, outcome_label="failure")
    ) == pytest.approx(0.5)


def test_tool_adherence_score_all_recognized() -> None:
    example = _example(
        tool_activity="\n".join(
            [
                "  - tool_calls: 8",
                "  - read_calls: 3",
                "  - edit_calls: 3",
                "  - bash_calls: 2",
            ]
        )
    )
    assert metrics.tool_adherence_score(example) == pytest.approx(1.0)


def test_tool_adherence_score_some_unrecognized() -> None:
    example = _example(
        tool_activity="\n".join(
            [
                "  - tool_calls: 10",
                "  - read_calls: 4",
                "  - edit_calls: 2",
                "  - bash_calls: 1",
            ]
        )
    )
    assert metrics.tool_adherence_score(example) == pytest.approx(0.7)


def test_tool_adherence_score_zero_tools() -> None:
    example = _example(
        tool_activity="\n".join(
            [
                "  - tool_calls: 0",
                "  - read_calls: 0",
                "  - edit_calls: 0",
                "  - bash_calls: 0",
            ]
        )
    )
    assert metrics.tool_adherence_score(example) == pytest.approx(1.0)


def test_weighted_quality_score_range_and_composition() -> None:
    good = _example(
        summary=(
            "task=task-1 outcome=success checkpoint=pass cost=0.0000 "
            "duration_min=5 punches=8 completion_ratio=1.00"
        ),
        total_cost=0.0,
        outcome_label="success",
        is_kill_recovery=True,
        tool_activity="\n".join(
            [
                "  - tool_calls: 4",
                "  - read_calls: 2",
                "  - edit_calls: 1",
                "  - bash_calls: 1",
            ]
        ),
    )
    poor = _example(
        summary=(
            "task=task-2 outcome=failure checkpoint=fail cost=10.0000 "
            "duration_min=60 punches=150 completion_ratio=0.00"
        ),
        total_cost=10.0,
        outcome_label="failure",
        is_kill_recovery=True,
        tool_activity="\n".join(
            [
                "  - tool_calls: 10",
                "  - read_calls: 1",
                "  - edit_calls: 1",
                "  - bash_calls: 0",
            ]
        ),
    )

    good_score = metrics.weighted_quality_score(good)
    poor_score = metrics.weighted_quality_score(poor)

    assert 0.0 <= good_score <= 1.0
    assert 0.0 <= poor_score <= 1.0
    assert good_score > poor_score


def test_weighted_quality_score_custom_weights() -> None:
    example = _example(
        summary=(
            "task=task-1 outcome=partial checkpoint=none cost=4.0000 "
            "duration_min=12 punches=20 completion_ratio=0.50"
        ),
        total_cost=4.0,
        outcome_label="partial",
        is_kill_recovery=False,
        tool_activity="\n".join(
            [
                "  - tool_calls: 10",
                "  - read_calls: 2",
                "  - edit_calls: 2",
                "  - bash_calls: 1",
            ]
        ),
    )
    weights = {
        "punch_card_pass_rate": 0.4,
        "cost_efficiency": 0.2,
        "task_completion_rate": 0.1,
        "fitter_recovery_success_rate": 0.1,
        "tool_adherence_score": 0.2,
    }
    expected = 0.4 * 0.5 + 0.2 * 0.5 + 0.1 * 0.0 + 0.1 * 0.5 + 0.2 * 0.5
    assert metrics.weighted_quality_score(example, weights=weights) == pytest.approx(
        expected
    )


def test_metric_determinism_same_input_same_output() -> None:
    example = _example()

    first = metrics.calculate_all_metrics(example)
    second = metrics.calculate_all_metrics(example)

    assert first == second
