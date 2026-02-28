from __future__ import annotations

import json
from typing import Any, cast

import dspy  # type: ignore[import-untyped]
import pytest
from dspy.utils import DummyLM  # type: ignore[import-untyped]

from optimization import assertions


def _example(subtasks: list[dict[str, object]]) -> dspy.Example:
    payload = {
        "task_description": "Implement bounded decomposition",
        "parent_scope": "Only split this parent task into bounded subtasks",
        "cost_budget": 10.0,
        "subtasks_json": json.dumps(subtasks),
        "scope_justification": "All subtasks are within parent task scope.",
    }
    return dspy.Example(**payload).with_inputs(
        "task_description", "parent_scope", "cost_budget"
    )


def _training_examples() -> list[dspy.Example]:
    valid = [
        {"title": f"subtask-{index}", "cost": 1.5, "notes": "in scope"}
        for index in range(5)
    ]
    return [_example(valid), _example(valid)]


def test_signature_docstring_contains_constraint_language() -> None:
    doc = assertions.TaskDecompositionSignature.__doc__ or ""
    assert "3 and 7" in doc
    assert "$2" in doc
    assert "parent task scope" in doc


def test_signature_field_descriptions_encode_constraints() -> None:
    model_fields = cast(
        dict[str, Any], assertions.TaskDecompositionSignature.model_fields
    )
    subtasks_field = model_fields["subtasks_json"]
    scope_field = model_fields["scope_justification"]

    subtasks_extra = cast(
        dict[str, Any], getattr(subtasks_field, "json_schema_extra", {})
    )
    scope_extra = cast(dict[str, Any], getattr(scope_field, "json_schema_extra", {}))

    subtasks_desc = str(subtasks_extra.get("desc", ""))
    scope_desc = str(scope_extra.get("desc", ""))

    assert "3-7" in subtasks_desc
    assert "$2" in subtasks_desc
    assert "parent task scope" in scope_desc


def test_constraint_metric_accepts_valid_decomposition() -> None:
    constraints = assertions.DecompositionConstraints(
        min_subtasks=3,
        max_subtasks=7,
        max_cost_per_subtask=2.0,
        scope_keywords=("out-of-scope",),
    )
    subtasks = [
        {"title": f"subtask-{index}", "cost": 1.5, "notes": "in scope"}
        for index in range(5)
    ]
    example = _example(subtasks)
    setattr(example, "constraints", constraints)
    prediction = dspy.Prediction(subtasks_json=json.dumps(subtasks))

    score = assertions.decomposition_constraint_metric(example, prediction)

    assert score == pytest.approx(1.0)


def test_constraint_metric_rejects_too_many_subtasks() -> None:
    constraints = assertions.DecompositionConstraints()
    subtasks = [
        {"title": f"subtask-{index}", "cost": 1.5, "notes": "in scope"}
        for index in range(10)
    ]
    example = _example(subtasks)
    setattr(example, "constraints", constraints)
    prediction = dspy.Prediction(subtasks_json=json.dumps(subtasks))

    score = assertions.decomposition_constraint_metric(example, prediction)

    assert score == pytest.approx(0.0)


def test_constraint_metric_rejects_over_budget_subtask() -> None:
    constraints = assertions.DecompositionConstraints()
    subtasks = [
        {"title": "subtask-0", "cost": 1.5, "notes": "in scope"},
        {"title": "subtask-1", "cost": 5.0, "notes": "in scope"},
        {"title": "subtask-2", "cost": 1.5, "notes": "in scope"},
    ]
    example = _example(subtasks)
    setattr(example, "constraints", constraints)
    prediction = dspy.Prediction(subtasks_json=json.dumps(subtasks))

    score = assertions.decomposition_constraint_metric(example, prediction)

    assert score == pytest.approx(0.0)


def test_compile_constrained_decomposition_with_dummy_lm() -> None:
    subtasks = [
        {"title": f"subtask-{index}", "cost": 1.5, "notes": "in scope"}
        for index in range(5)
    ]
    lm = DummyLM(
        [
            {"subtasks_json": json.dumps(subtasks), "scope_justification": "in scope"}
            for _ in range(256)
        ]
    )

    result = assertions.compile_constrained_decomposition(
        lm=lm,
        constraints=assertions.DecompositionConstraints(),
        training_examples=_training_examples(),
        config=assertions.DecompositionCompileConfig(
            max_bootstrapped_demos=1,
            max_labeled_demos=2,
            max_rounds=1,
        ),
    )

    assert result.trainset_size >= 1
    assert result.compiled_prompt_text != ""


def test_constrained_module_forward_produces_output() -> None:
    subtasks = [
        {"title": f"subtask-{index}", "cost": 1.5, "notes": "in scope"}
        for index in range(3)
    ]
    lm = DummyLM(
        {
            "Implement bounded decomposition": {
                "subtasks_json": json.dumps(subtasks),
                "scope_justification": "in scope",
            }
        }
    )
    module = assertions.ConstrainedDecompositionModule(
        constraints=assertions.DecompositionConstraints()
    )

    with dspy.context(lm=lm):
        prediction = module(
            task_description="Implement bounded decomposition",
            parent_scope="Only split this parent task into bounded subtasks",
            cost_budget=10.0,
        )

    assert hasattr(prediction, "subtasks_json")
    assert hasattr(prediction, "scope_justification")


def test_build_refined_decomposition_wraps_with_refine() -> None:
    module = assertions.ConstrainedDecompositionModule(
        constraints=assertions.DecompositionConstraints()
    )

    refined = assertions.build_refined_decomposition(
        module=module,
        constraints=assertions.DecompositionConstraints(),
    )

    assert refined.__class__.__name__ == "Refine"
