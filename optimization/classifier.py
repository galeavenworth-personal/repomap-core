from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any, Literal

import dspy  # type: ignore[import-untyped]
from dspy.teleprompt import BootstrapFewShot  # type: ignore[import-untyped]

from optimization import dolt_bus
from optimization.fitter_signatures import DiagnosisCategory
from optimization.training_data import build_training_set


ClassifierVersion = Literal["dspy-diagnosis-classifier-v1"]


@dataclass(frozen=True)
class ClassificationResult:
    session_id: str
    category: DiagnosisCategory
    confidence: float
    evidence: str


@dataclass(frozen=True)
class ClassifierCompileConfig:
    max_bootstrapped_demos: int = 2
    max_labeled_demos: int = 4
    max_rounds: int = 1


@dataclass(frozen=True)
class ClassifierCompilationResult:
    compiled_program: Any
    trainset_size: int
    average_metric_score: float


@dataclass(frozen=True)
class BaselineComparison:
    classifier_accuracy: float
    heuristic_accuracy: float
    classifier_at_least_as_good: bool
    note: str


class DiagnosisClassifierSignature(dspy.Signature):  # type: ignore[misc]
    """Classify diagnosis category from session telemetry patterns.

    Categories must be exactly one of:
    - stuck_on_approval
    - infinite_retry
    - scope_creep
    - context_exhaustion
    - model_confusion
    """

    session_id: str = dspy.InputField(desc="Session/task id")
    tool_patterns: str = dspy.InputField(desc="Tool usage and error pattern summary")
    last_messages: str = dspy.InputField(
        desc="Summary of last assistant/user/tool messages"
    )
    kill_reason: str = dspy.InputField(
        desc="Kill trigger reason/classification summary"
    )

    category: str = dspy.OutputField(desc="One of the 5 diagnosis categories")
    confidence: float = dspy.OutputField(desc="Confidence score in [0.0, 1.0]")
    evidence: str = dspy.OutputField(desc="Evidence for why this category was selected")


class DiagnosisClassifierModule(dspy.Module):
    def __init__(self) -> None:
        super().__init__()
        self._predict = dspy.Predict(DiagnosisClassifierSignature)

    def forward(
        self,
        session_id: str,
        tool_patterns: str,
        last_messages: str,
        kill_reason: str,
    ) -> Any:
        return self._predict(
            session_id=session_id,
            tool_patterns=tool_patterns,
            last_messages=last_messages,
            kill_reason=kill_reason,
        )


def _valid_category(value: str) -> bool:
    allowed: set[str] = {
        "stuck_on_approval",
        "infinite_retry",
        "scope_creep",
        "context_exhaustion",
        "model_confusion",
    }
    return value in allowed


def _example_to_classifier_payload(example: dspy.Example) -> dict[str, Any]:
    summary = str(getattr(example, "summary", ""))
    tool_activity = str(getattr(example, "tool_activity", ""))
    diagnosis = str(getattr(example, "diagnosis_category", "model_confusion"))
    return {
        "session_id": str(getattr(example, "session_id", "unknown-session")),
        "tool_patterns": tool_activity,
        "last_messages": summary,
        "kill_reason": f"inferred_outcome={str(getattr(example, 'outcome_label', 'partial'))}",
        "category": diagnosis,
        "confidence": 0.8,
        "evidence": f"Telemetry patterns mapped to {diagnosis}",
    }


def build_classifier_trainset(examples: list[dspy.Example]) -> list[dspy.Example]:
    trainset: list[dspy.Example] = []
    for example in examples:
        payload = _example_to_classifier_payload(example)
        trainset.append(
            dspy.Example(**payload).with_inputs(
                "session_id", "tool_patterns", "last_messages", "kill_reason"
            )
        )
    return trainset


def classification_accuracy_metric(
    example: dspy.Example,
    prediction: Any,
    trace: Any = None,
) -> float:
    del trace
    predicted_category = str(getattr(prediction, "category", "")).strip()
    expected_category = str(getattr(example, "category", "")).strip()
    raw_confidence = float(getattr(prediction, "confidence", 0.0))
    confidence = max(0.0, min(raw_confidence, 1.0))
    evidence = str(getattr(prediction, "evidence", "")).strip()

    if not _valid_category(predicted_category):
        return 0.0
    if expected_category == "":
        return 0.0
    if evidence == "":
        return 0.0
    if predicted_category != expected_category:
        return 0.0
    return confidence


def compile_classifier(
    lm: Any,
    config: ClassifierCompileConfig | None = None,
    training_examples: list[dspy.Example] | None = None,
) -> ClassifierCompilationResult:
    effective_config = config if config is not None else ClassifierCompileConfig()
    source_examples = (
        training_examples
        if training_examples is not None
        else build_training_set(limit=200)
    )
    trainset = build_classifier_trainset(source_examples)
    if len(trainset) == 0:
        raise ValueError("training_examples produced empty classifier trainset")

    module = DiagnosisClassifierModule()
    optimizer = BootstrapFewShot(
        metric=classification_accuracy_metric,
        max_bootstrapped_demos=effective_config.max_bootstrapped_demos,
        max_labeled_demos=effective_config.max_labeled_demos,
        max_rounds=effective_config.max_rounds,
    )

    with dspy.context(lm=lm):
        compiled = optimizer.compile(module, trainset=trainset)
        scores = [
            classification_accuracy_metric(example, compiled(**example.inputs()))
            for example in trainset
        ]

    return ClassifierCompilationResult(
        compiled_program=compiled,
        trainset_size=len(trainset),
        average_metric_score=mean(scores),
    )


def classify_session(
    compiled_program: Any,
    session_id: str,
    tool_patterns: str,
    last_messages: str,
    kill_reason: str,
) -> ClassificationResult:
    prediction = compiled_program(
        session_id=session_id,
        tool_patterns=tool_patterns,
        last_messages=last_messages,
        kill_reason=kill_reason,
    )

    predicted_category = str(getattr(prediction, "category", "model_confusion")).strip()
    category: DiagnosisCategory
    if _valid_category(predicted_category):
        category = predicted_category  # type: ignore[assignment]
    else:
        category = "model_confusion"

    raw_confidence = float(getattr(prediction, "confidence", 0.3))
    confidence = max(0.0, min(raw_confidence, 1.0))
    evidence = str(getattr(prediction, "evidence", "")).strip()
    if evidence == "":
        evidence = "No evidence produced by classifier"

    return ClassificationResult(
        session_id=session_id,
        category=category,
        confidence=confidence,
        evidence=evidence,
    )


def publish_classification(
    result: ClassificationResult,
    classifier_version: ClassifierVersion = "dspy-diagnosis-classifier-v1",
) -> None:
    dolt_bus.write_diagnosis_classification(
        session_id=result.session_id,
        category=result.category,
        confidence=result.confidence,
        evidence=result.evidence,
        classifier_version=classifier_version,
    )


def compare_with_heuristic(
    compiled_program: Any,
    evaluation_examples: list[dspy.Example],
) -> BaselineComparison:
    if len(evaluation_examples) == 0:
        return BaselineComparison(
            classifier_accuracy=0.0,
            heuristic_accuracy=1.0,
            classifier_at_least_as_good=False,
            note="No evaluation examples available",
        )

    classifier_matches = 0
    total = 0
    for example in evaluation_examples:
        expected = str(getattr(example, "diagnosis_category", "")).strip()
        if expected == "":
            continue

        payload = _example_to_classifier_payload(example)
        result = classify_session(
            compiled_program=compiled_program,
            session_id=str(payload["session_id"]),
            tool_patterns=str(payload["tool_patterns"]),
            last_messages=str(payload["last_messages"]),
            kill_reason=str(payload["kill_reason"]),
        )
        if result.category == expected:
            classifier_matches += 1
        total += 1

    if total == 0:
        return BaselineComparison(
            classifier_accuracy=0.0,
            heuristic_accuracy=1.0,
            classifier_at_least_as_good=False,
            note="No labeled diagnosis examples found",
        )

    classifier_accuracy = classifier_matches / total
    # Heuristic baseline from infer_diagnosis_category-generated labels in training_data.
    heuristic_accuracy = 1.0
    return BaselineComparison(
        classifier_accuracy=classifier_accuracy,
        heuristic_accuracy=heuristic_accuracy,
        classifier_at_least_as_good=classifier_accuracy >= heuristic_accuracy,
        note=(
            "Baseline compares against training labels produced by infer_diagnosis_category; "
            "heuristic baseline is therefore 1.0 by construction on this dataset."
        ),
    )


def _cli() -> int:
    raise SystemExit(
        "Instantiate an LM and call compile_classifier(...) / classify_session(...) from a script or test."
    )


if __name__ == "__main__":
    _cli()
