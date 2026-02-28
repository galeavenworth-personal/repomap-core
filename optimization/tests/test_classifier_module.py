from __future__ import annotations

from typing import Any
from unittest.mock import patch

import dspy  # type: ignore[import-untyped]
from dspy.utils import DummyLM  # type: ignore[import-untyped]

from optimization import classifier


def _example(category: str) -> dspy.Example:
    payload: dict[str, Any] = {
        "task_id": f"task-{category}",
        "session_id": f"session-{category}",
        "summary": (
            "task=t outcome=failure checkpoint=fail cost=1.0000 "
            "duration_min=10 punches=15 completion_ratio=0.00"
        ),
        "tool_activity": "\n".join(
            [
                "  - tool_calls: 8",
                "  - read_calls: 3",
                "  - edit_calls: 2",
                "  - bash_calls: 1",
            ]
        ),
        "total_punches": 15,
        "tool_calls": 8,
        "total_cost": 1.0,
        "duration_minutes": 10,
        "outcome_label": "failure",
        "diagnosis_category": category,
        "is_kill_recovery": True,
    }
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


def _training_examples() -> list[dspy.Example]:
    categories: tuple[str, ...] = (
        "stuck_on_approval",
        "infinite_retry",
        "scope_creep",
        "context_exhaustion",
        "model_confusion",
    )
    return [_example(category) for category in categories]


def test_build_classifier_trainset_has_expected_inputs() -> None:
    trainset = classifier.build_classifier_trainset(_training_examples())
    assert len(trainset) == 5
    first = trainset[0]
    assert set(first.inputs().keys()) == {
        "session_id",
        "tool_patterns",
        "last_messages",
        "kill_reason",
    }
    assert hasattr(first, "category")
    assert hasattr(first, "confidence")
    assert hasattr(first, "evidence")


def test_compile_classifier_with_dummy_lm() -> None:
    lm = DummyLM(
        [
            {
                "category": "scope_creep",
                "confidence": 0.82,
                "evidence": "High edit and tool diversity",
            }
            for _ in range(512)
        ]
    )
    result = classifier.compile_classifier(
        lm=lm,
        config=classifier.ClassifierCompileConfig(
            max_bootstrapped_demos=1,
            max_labeled_demos=2,
            max_rounds=1,
        ),
        training_examples=_training_examples(),
    )

    assert result.trainset_size == 5
    assert 0.0 <= result.average_metric_score <= 1.0


def test_classify_session_clamps_invalid_values() -> None:
    lm = DummyLM(
        [
            {
                "category": "not-a-real-category",
                "confidence": 7.0,
                "evidence": "",
            }
        ]
    )
    module = classifier.DiagnosisClassifierModule()
    with dspy.context(lm=lm):
        result = classifier.classify_session(
            compiled_program=module,
            session_id="s1",
            tool_patterns="- tool_calls: 1",
            last_messages="summary",
            kill_reason="cache_plateau",
        )

    assert result.category == "model_confusion"
    assert result.confidence == 1.0
    assert result.evidence != ""


def test_publish_classification_writes_to_dolt_bus() -> None:
    result = classifier.ClassificationResult(
        session_id="session-123",
        category="infinite_retry",
        confidence=0.91,
        evidence="Repeated error bursts on bash",
    )
    with patch(
        "optimization.classifier.dolt_bus.write_diagnosis_classification"
    ) as writer:
        classifier.publish_classification(result)

    writer.assert_called_once()


def test_compare_with_heuristic_returns_summary() -> None:
    lm = DummyLM(
        [
            {
                "category": "stuck_on_approval",
                "confidence": 0.7,
                "evidence": "No tool calls in tail",
            }
            for _ in range(512)
        ]
    )
    module = classifier.DiagnosisClassifierModule()
    examples = _training_examples()

    with dspy.context(lm=lm):
        summary = classifier.compare_with_heuristic(module, examples)

    assert 0.0 <= summary.classifier_accuracy <= 1.0
    assert summary.heuristic_accuracy == 1.0
    assert "infer_diagnosis_category" in summary.note
