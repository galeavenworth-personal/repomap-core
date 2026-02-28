from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any, Literal

import dspy  # type: ignore[import-untyped]
from dspy.teleprompt import BootstrapFewShot, MIPROv2  # type: ignore[import-untyped]

from optimization import dolt_bus
from optimization import fitter_signatures as fs
from optimization.metrics import fitter_recovery_success_rate
from optimization.training_data import build_training_set

OptimizerKind = Literal["bootstrap_fewshot", "miprov2"]

SIGNATURE_BY_CATEGORY: dict[fs.DiagnosisCategory, type[dspy.Signature]] = {
    "stuck_on_approval": fs.StuckOnApprovalSignature,
    "infinite_retry": fs.InfiniteRetrySignature,
    "scope_creep": fs.ScopeCreepSignature,
    "context_exhaustion": fs.ContextExhaustionSignature,
    "model_confusion": fs.ModelConfusionSignature,
}


@dataclass(frozen=True)
class OptimizerConfig:
    optimizer_kind: OptimizerKind = "bootstrap_fewshot"
    max_bootstrapped_demos: int = 2
    max_labeled_demos: int = 4
    max_rounds: int = 1


@dataclass(frozen=True)
class CompilationResult:
    category: fs.DiagnosisCategory
    compiled_program: Any
    compiled_prompt_text: str
    trainset_size: int
    average_metric_score: float


@dataclass(frozen=True)
class ComparisonResult:
    category: fs.DiagnosisCategory
    compiled_score: float
    handwritten_score: float
    compiled_prompt: str
    handwritten_prompt: str


@dataclass(frozen=True)
class ComparisonSummary:
    results: list[ComparisonResult]
    compiled_average: float
    handwritten_average: float
    compiled_at_least_as_good: bool
    note: str


def _parse_tool_activity_to_patterns(tool_activity: str) -> list[fs.ToolPattern]:
    patterns: list[fs.ToolPattern] = []
    for raw_line in tool_activity.splitlines():
        line = raw_line.strip()
        if not line.startswith("-"):
            continue
        payload = line.removeprefix("-").strip()
        if ":" not in payload:
            continue
        key, value_raw = payload.split(":", 1)
        key = key.strip()
        value_raw = value_raw.strip()
        try:
            value = int(value_raw)
        except ValueError:
            continue
        if key in {"read_calls", "edit_calls", "bash_calls", "tool_calls"}:
            patterns.append(
                fs.ToolPattern(
                    tool=key,
                    count=max(value, 0),
                    error_count=0,
                    last_status="ok",
                )
            )

    if len(patterns) > 0:
        return patterns

    return [
        fs.ToolPattern(tool="read_calls", count=1, error_count=0, last_status="ok"),
        fs.ToolPattern(tool="edit_calls", count=1, error_count=0, last_status="ok"),
    ]


def _example_to_report(
    example: dspy.Example,
    category: fs.DiagnosisCategory,
) -> fs.DiagnosisReport:
    session_id = str(getattr(example, "session_id", "unknown-session"))
    summary = str(getattr(example, "summary", "no summary available"))
    tool_activity = str(getattr(example, "tool_activity", ""))
    return fs.DiagnosisReport(
        session_id=session_id,
        category=category,
        confidence=0.7,
        summary=summary,
        suggested_action="Apply a minimal targeted fix and verify before exiting.",
        tool_patterns=_parse_tool_activity_to_patterns(tool_activity),
    )


def _input_keys_for_category(category: fs.DiagnosisCategory) -> tuple[str, ...]:
    if category == "infinite_retry":
        return (
            "session_id",
            "summary",
            "suggested_action",
            "tool_activity",
            "last_error",
            "failing_tool",
            "retry_count",
        )
    return ("session_id", "summary", "suggested_action", "tool_activity")


def _payload_for_report(
    report: fs.DiagnosisReport,
) -> dict[str, str | int]:
    tool_activity = fs.format_tool_activity(report.tool_patterns)
    payload: dict[str, str | int] = {
        "session_id": report.session_id,
        "summary": report.summary,
        "suggested_action": report.suggested_action,
        "tool_activity": tool_activity,
    }
    if report.category == "infinite_retry":
        last_error, failing_tool = fs.extract_error_and_tool(report.summary)
        payload["last_error"] = last_error
        payload["failing_tool"] = failing_tool
        payload["retry_count"] = fs.extract_retry_count(report)
    return payload


def build_category_trainset(
    category: fs.DiagnosisCategory,
    examples: list[dspy.Example],
) -> list[dspy.Example]:
    """Adapt generic telemetry examples to category-specific signature trainset."""
    trainset: list[dspy.Example] = []
    input_keys = _input_keys_for_category(category)

    for example in examples:
        diagnosis = str(getattr(example, "diagnosis_category", ""))
        if diagnosis != category:
            continue

        report = _example_to_report(example, category)
        payload = _payload_for_report(report)
        payload["recovery_prompt"] = fs.build_recovery_prompt(report)
        payload["outcome_label"] = str(getattr(example, "outcome_label", "partial"))
        payload["is_kill_recovery"] = bool(getattr(example, "is_kill_recovery", False))

        adapted = dspy.Example(**payload).with_inputs(*input_keys)
        trainset.append(adapted)

    return trainset


def _optimizer(metric: Any, config: OptimizerConfig) -> Any:
    if config.optimizer_kind == "miprov2":
        return MIPROv2(
            metric=metric,
            auto="light",
            max_bootstrapped_demos=config.max_bootstrapped_demos,
            max_labeled_demos=config.max_labeled_demos,
        )

    return BootstrapFewShot(
        metric=metric,
        max_bootstrapped_demos=config.max_bootstrapped_demos,
        max_labeled_demos=config.max_labeled_demos,
        max_rounds=config.max_rounds,
    )


def _optimization_metric(
    example: dspy.Example,
    prediction: Any,
    trace: Any = None,
) -> float:
    del trace
    generated = str(getattr(prediction, "recovery_prompt", "")).strip()
    if generated == "":
        return 0.0
    return fitter_recovery_success_rate(example)


def compile_category(
    category: fs.DiagnosisCategory,
    lm: Any,
    training_examples: list[dspy.Example] | None = None,
    config: OptimizerConfig | None = None,
) -> CompilationResult:
    """Compile one fitter dispatch category with the configured DSPy optimizer."""
    effective_config = config if config is not None else OptimizerConfig()
    source_examples = (
        training_examples
        if training_examples is not None
        else build_training_set(limit=200)
    )
    trainset = build_category_trainset(category=category, examples=source_examples)

    if len(trainset) == 0:
        raise ValueError(f"No training examples found for category={category}")

    predictor = dspy.Predict(SIGNATURE_BY_CATEGORY[category])
    optimizer = _optimizer(metric=_optimization_metric, config=effective_config)

    with dspy.context(lm=lm):
        if effective_config.optimizer_kind == "miprov2":
            compiled = optimizer.compile(predictor, trainset=trainset, valset=trainset)
        else:
            compiled = optimizer.compile(predictor, trainset=trainset)

        exemplar = trainset[0]
        payload = {
            key: getattr(exemplar, key) for key in _input_keys_for_category(category)
        }
        prediction = compiled(**payload)
        scores = [
            _optimization_metric(example, compiled(**example.inputs()))
            for example in trainset
        ]

    compiled_prompt_text = str(getattr(prediction, "recovery_prompt", "")).strip()
    if compiled_prompt_text == "":
        compiled_prompt_text = str(exemplar.recovery_prompt)

    return CompilationResult(
        category=category,
        compiled_program=compiled,
        compiled_prompt_text=compiled_prompt_text,
        trainset_size=len(trainset),
        average_metric_score=mean(scores),
    )


def compile_all_categories(
    lm: Any,
    training_examples: list[dspy.Example] | None = None,
    config: OptimizerConfig | None = None,
) -> list[CompilationResult]:
    """Compile all fitter dispatch categories and return deterministic ordered results."""
    categories: tuple[fs.DiagnosisCategory, ...] = (
        "stuck_on_approval",
        "infinite_retry",
        "scope_creep",
        "context_exhaustion",
        "model_confusion",
    )

    source_examples = (
        training_examples
        if training_examples is not None
        else build_training_set(limit=200)
    )

    results: list[CompilationResult] = []
    for category in categories:
        trainset_for_category = [
            example
            for example in source_examples
            if str(getattr(example, "diagnosis_category", "")) == category
        ]
        if len(trainset_for_category) == 0:
            continue
        results.append(
            compile_category(
                category=category,
                lm=lm,
                training_examples=source_examples,
                config=config,
            )
        )
    return results


def publish_compilation_results(
    results: list[CompilationResult],
    dspy_version: str | None = None,
) -> list[str]:
    """Persist compiled prompts to Dolt compiled_prompts table."""
    effective_version = (
        dspy_version if dspy_version is not None else str(dspy.__version__)
    )
    prompt_ids: list[str] = []
    for result in results:
        prompt_id = f"fitter-dispatch:{result.category}"
        dolt_bus.write_compiled_prompt(
            prompt_id=prompt_id,
            module_name="fitter_dispatch",
            signature_name=fs.SIGNATURE_NAME_BY_CATEGORY[result.category],
            compiled_prompt=result.compiled_prompt_text,
            dspy_version=effective_version,
        )
        prompt_ids.append(prompt_id)
    return prompt_ids


def compare_compiled_vs_handwritten(
    results: list[CompilationResult],
    evaluation_examples: list[dspy.Example],
    lm: Any,
) -> ComparisonSummary:
    """Compare compiled programs against hand-written prompt templates.

    Note: with DummyLM this comparison is structural, not statistically meaningful.
    """
    comparisons: list[ComparisonResult] = []

    for compiled in results:
        category = compiled.category
        category_examples = [
            example
            for example in evaluation_examples
            if str(getattr(example, "diagnosis_category", "")) == category
        ]
        if len(category_examples) == 0:
            continue

        compiled_scores: list[float] = []
        handwritten_scores: list[float] = []

        for example in category_examples:
            report = _example_to_report(example, category)
            payload = _payload_for_report(report)

            with dspy.context(lm=lm):
                compiled_prediction = compiled.compiled_program(**payload)
            compiled_prompt = str(
                getattr(compiled_prediction, "recovery_prompt", "")
            ).strip()
            handwritten_prompt = fs.build_recovery_prompt(report)

            compiled_valid = compiled_prompt != ""
            handwritten_valid = handwritten_prompt != ""

            base_metric = fitter_recovery_success_rate(example)
            compiled_scores.append(base_metric if compiled_valid else 0.0)
            handwritten_scores.append(base_metric if handwritten_valid else 0.0)

        compiled_average = mean(compiled_scores)
        handwritten_average = mean(handwritten_scores)
        sample_report = _example_to_report(category_examples[0], category)

        comparisons.append(
            ComparisonResult(
                category=category,
                compiled_score=compiled_average,
                handwritten_score=handwritten_average,
                compiled_prompt=compiled.compiled_prompt_text,
                handwritten_prompt=fs.build_recovery_prompt(sample_report),
            )
        )

    compiled_avg = (
        mean([entry.compiled_score for entry in comparisons]) if comparisons else 0.0
    )
    handwritten_avg = (
        mean([entry.handwritten_score for entry in comparisons]) if comparisons else 0.0
    )

    return ComparisonSummary(
        results=comparisons,
        compiled_average=compiled_avg,
        handwritten_average=handwritten_avg,
        compiled_at_least_as_good=compiled_avg >= handwritten_avg,
        note=(
            "Comparison uses fitter_recovery_success_rate with prompt non-empty checks; "
            "with DummyLM this is a structural pipeline validation."
        ),
    )


def run_compilation_pipeline(
    lm: Any,
    config: OptimizerConfig | None = None,
    training_examples: list[dspy.Example] | None = None,
) -> tuple[list[CompilationResult], ComparisonSummary, list[str]]:
    """Compile, compare against hand-written templates, and publish to Dolt."""
    source_examples = (
        training_examples
        if training_examples is not None
        else build_training_set(limit=200)
    )
    results = compile_all_categories(
        lm=lm, training_examples=source_examples, config=config
    )
    comparison = compare_compiled_vs_handwritten(
        results=results,
        evaluation_examples=source_examples,
        lm=lm,
    )
    prompt_ids = publish_compilation_results(results=results)
    return results, comparison, prompt_ids


def main() -> int:
    """Batch-oriented local entrypoint for manual offline compilation runs."""
    raise SystemExit(
        "Instantiate an LM and call run_compilation_pipeline(...) from a script or test."
    )


if __name__ == "__main__":
    main()
