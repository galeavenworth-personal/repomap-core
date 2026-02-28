from __future__ import annotations

from typing import Any
from unittest.mock import patch

import dspy  # type: ignore[import-untyped]
from dspy.utils import DummyLM  # type: ignore[import-untyped]

from optimization import compiler


def _example(
    category: str, *, outcome_label: str, is_kill_recovery: bool
) -> dspy.Example:
    payload: dict[str, Any] = {
        "task_id": f"task-{category}-{outcome_label}",
        "session_id": f"session-{category}-{outcome_label}",
        "summary": (
            f"task=t outcome={outcome_label} checkpoint=pass cost=1.0000 "
            "duration_min=10 punches=15 completion_ratio=1.00"
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
        "outcome_label": outcome_label,
        "diagnosis_category": category,
        "is_kill_recovery": is_kill_recovery,
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
    categories: tuple[compiler.fs.DiagnosisCategory, ...] = (
        "stuck_on_approval",
        "infinite_retry",
        "scope_creep",
        "context_exhaustion",
        "model_confusion",
    )
    examples: list[dspy.Example] = []
    for category in categories:
        examples.append(
            _example(category, outcome_label="success", is_kill_recovery=True)
        )
        examples.append(
            _example(category, outcome_label="failure", is_kill_recovery=True)
        )
    return examples


def test_build_category_trainset_adapts_infinite_retry_fields() -> None:
    trainset = compiler.build_category_trainset("infinite_retry", _training_examples())
    assert len(trainset) >= 2
    first = trainset[0]
    assert hasattr(first, "last_error")
    assert hasattr(first, "failing_tool")
    assert hasattr(first, "retry_count")
    assert set(first.inputs().keys()) == {
        "session_id",
        "summary",
        "suggested_action",
        "tool_activity",
        "last_error",
        "failing_tool",
        "retry_count",
    }


def test_compile_category_bootstrapfewshot_with_dummy_lm() -> None:
    lm = DummyLM([{"recovery_prompt": "compiled recovery prompt"} for _ in range(256)])
    result = compiler.compile_category(
        category="scope_creep",
        lm=lm,
        training_examples=_training_examples(),
        config=compiler.OptimizerConfig(
            optimizer_kind="bootstrap_fewshot",
            max_bootstrapped_demos=1,
            max_labeled_demos=2,
            max_rounds=1,
        ),
    )

    assert result.category == "scope_creep"
    assert result.trainset_size >= 2
    assert result.compiled_prompt_text != ""
    assert 0.0 <= result.average_metric_score <= 1.0


def test_compile_all_categories_compiles_five_results() -> None:
    lm = DummyLM([{"recovery_prompt": "compiled recovery prompt"} for _ in range(1024)])
    results = compiler.compile_all_categories(
        lm=lm,
        training_examples=_training_examples(),
        config=compiler.OptimizerConfig(
            optimizer_kind="bootstrap_fewshot",
            max_bootstrapped_demos=1,
            max_labeled_demos=2,
            max_rounds=1,
        ),
    )

    assert len(results) == 5
    assert {result.category for result in results} == set(
        compiler.SIGNATURE_BY_CATEGORY
    )


def test_publish_compilation_results_writes_to_dolt_bus() -> None:
    lm = DummyLM([{"recovery_prompt": "compiled recovery prompt"} for _ in range(512)])
    results = compiler.compile_all_categories(
        lm=lm,
        training_examples=_training_examples(),
        config=compiler.OptimizerConfig(
            optimizer_kind="bootstrap_fewshot",
            max_bootstrapped_demos=1,
            max_labeled_demos=2,
            max_rounds=1,
        ),
    )

    with patch("optimization.compiler.dolt_bus.write_compiled_prompt") as writer:
        prompt_ids = compiler.publish_compilation_results(results, dspy_version="3.1.3")

    assert len(prompt_ids) == 5
    assert writer.call_count == 5


def test_compare_compiled_vs_handwritten_returns_structural_summary() -> None:
    lm = DummyLM([{"recovery_prompt": "compiled recovery prompt"} for _ in range(1024)])
    examples = _training_examples()
    results = compiler.compile_all_categories(
        lm=lm,
        training_examples=examples,
        config=compiler.OptimizerConfig(
            optimizer_kind="bootstrap_fewshot",
            max_bootstrapped_demos=1,
            max_labeled_demos=2,
            max_rounds=1,
        ),
    )

    summary = compiler.compare_compiled_vs_handwritten(results, examples, lm=lm)

    assert len(summary.results) == 5
    assert 0.0 <= summary.compiled_average <= 1.0
    assert 0.0 <= summary.handwritten_average <= 1.0
    assert "structural pipeline validation" in summary.note


def test_run_compilation_pipeline_end_to_end() -> None:
    lm = DummyLM([{"recovery_prompt": "compiled recovery prompt"} for _ in range(1024)])

    with patch("optimization.compiler.dolt_bus.write_compiled_prompt"):
        results, comparison, prompt_ids = compiler.run_compilation_pipeline(
            lm=lm,
            config=compiler.OptimizerConfig(
                optimizer_kind="bootstrap_fewshot",
                max_bootstrapped_demos=1,
                max_labeled_demos=2,
                max_rounds=1,
            ),
            training_examples=_training_examples(),
        )

    assert len(results) == 5
    assert len(prompt_ids) == 5
    assert len(comparison.results) == 5
