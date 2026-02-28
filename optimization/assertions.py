from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any
import json

import dspy  # type: ignore[import-untyped]
from dspy.teleprompt import BootstrapFewShot  # type: ignore[import-untyped]


@dataclass(frozen=True)
class DecompositionConstraints:
    min_subtasks: int = 3
    max_subtasks: int = 7
    max_cost_per_subtask: float = 2.0
    scope_keywords: tuple[str, ...] = ()


@dataclass(frozen=True)
class DecompositionCompilationResult:
    compiled_program: Any
    compiled_prompt_text: str
    trainset_size: int
    average_metric_score: float


@dataclass(frozen=True)
class DecompositionCompileConfig:
    max_bootstrapped_demos: int = 2
    max_labeled_demos: int = 4
    max_rounds: int = 1


class TaskDecompositionSignature(dspy.Signature):  # type: ignore[misc]
    """Decompose a task into bounded subtasks. CONSTRAINTS: (1) Produce between 3 and 7 subtasks. (2) Each subtask must cost at most $2. (3) No subtask may exceed the parent task scope."""

    task_description: str = dspy.InputField(desc="Parent task description to decompose")
    parent_scope: str = dspy.InputField(
        desc="Explicit statement of parent task scope boundary"
    )
    cost_budget: float = dspy.InputField(desc="Total allowed budget across subtasks")
    subtasks_json: str = dspy.OutputField(
        desc=(
            "JSON array of 3-7 subtask objects; each object includes a cost field "
            "with value <= $2 and remains within parent task scope"
        )
    )
    scope_justification: str = dspy.OutputField(
        desc="Brief explanation that every subtask stays within parent task scope"
    )


class ConstrainedDecompositionModule(dspy.Module):
    def __init__(self, constraints: DecompositionConstraints) -> None:
        super().__init__()
        self.constraints = constraints
        self._predict = dspy.Predict(TaskDecompositionSignature)

    def forward(
        self,
        task_description: str,
        parent_scope: str,
        cost_budget: float,
    ) -> Any:
        return self._predict(
            task_description=task_description,
            parent_scope=parent_scope,
            cost_budget=cost_budget,
        )


def decomposition_constraint_metric(
    example: dspy.Example,
    prediction: Any,
    trace: Any = None,
) -> float:
    del trace

    constraints = getattr(example, "constraints", DecompositionConstraints())

    raw_json = str(getattr(prediction, "subtasks_json", "")).strip()
    if raw_json == "":
        return 0.0

    try:
        subtasks = json.loads(raw_json)
    except json.JSONDecodeError:
        return 0.0

    if not isinstance(subtasks, list):
        return 0.0

    if (
        len(subtasks) < constraints.min_subtasks
        or len(subtasks) > constraints.max_subtasks
    ):
        return 0.0

    for subtask in subtasks:
        if not isinstance(subtask, dict):
            return 0.0

        cost = subtask.get("cost")
        if not isinstance(cost, int | float):
            return 0.0
        if float(cost) > constraints.max_cost_per_subtask:
            return 0.0

        if constraints.scope_keywords:
            subtask_blob = json.dumps(subtask, sort_keys=True).lower()
            if any(
                keyword.lower() in subtask_blob
                for keyword in constraints.scope_keywords
            ):
                return 0.0

    return 1.0


def compile_constrained_decomposition(
    lm: Any,
    constraints: DecompositionConstraints,
    training_examples: list[dspy.Example],
    config: DecompositionCompileConfig | None = None,
) -> DecompositionCompilationResult:
    if len(training_examples) == 0:
        raise ValueError("training_examples must be non-empty")

    effective_config = config if config is not None else DecompositionCompileConfig()

    predictor = ConstrainedDecompositionModule(constraints=constraints)
    optimizer = BootstrapFewShot(
        metric=decomposition_constraint_metric,
        max_bootstrapped_demos=effective_config.max_bootstrapped_demos,
        max_labeled_demos=effective_config.max_labeled_demos,
        max_rounds=effective_config.max_rounds,
    )

    trainset: list[dspy.Example] = []
    for example in training_examples:
        payload = dict(example.toDict())
        payload["constraints"] = constraints
        trainset.append(
            dspy.Example(**payload).with_inputs(
                "task_description", "parent_scope", "cost_budget"
            )
        )

    with dspy.context(lm=lm):
        compiled = optimizer.compile(predictor, trainset=trainset)
        exemplar = trainset[0]
        prediction = compiled(**exemplar.inputs())
        scores = [
            decomposition_constraint_metric(example, compiled(**example.inputs()))
            for example in trainset
        ]

    compiled_prompt_text = str(getattr(prediction, "subtasks_json", "")).strip()
    if compiled_prompt_text == "":
        compiled_prompt_text = str(getattr(exemplar, "subtasks_json", "")).strip()

    return DecompositionCompilationResult(
        compiled_program=compiled,
        compiled_prompt_text=compiled_prompt_text,
        trainset_size=len(trainset),
        average_metric_score=mean(scores),
    )


def build_refined_decomposition(
    module: ConstrainedDecompositionModule,
    constraints: DecompositionConstraints,
) -> Any:
    def _reward_fn(example_dict: dict[str, Any], prediction: Any) -> float:
        wrapped_example = dspy.Example(**example_dict)
        setattr(wrapped_example, "constraints", constraints)
        return decomposition_constraint_metric(wrapped_example, prediction)

    return dspy.Refine(module=module, N=3, reward_fn=_reward_fn, threshold=1.0)
