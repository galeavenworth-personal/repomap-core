from __future__ import annotations

from dataclasses import dataclass
from statistics import mean
from typing import Any

import dspy  # type: ignore[import-untyped]
from dspy.teleprompt import BootstrapFewShot  # type: ignore[import-untyped]

from optimization import dolt_bus


@dataclass(frozen=True)
class CardExitCompileConfig:
    max_bootstrapped_demos: int = 2
    max_labeled_demos: int = 4
    max_rounds: int = 1


@dataclass(frozen=True)
class CardExitCompilationResult:
    card_id: str
    compiled_program: Any
    compiled_prompt_text: str
    trainset_size: int
    average_metric_score: float


class PunchCardExitSignature(dspy.Signature):  # type: ignore[misc]
    """Generate card-specific exit conditions and self-check instructions."""

    task_description: str = dspy.InputField(desc="Task to complete")
    card_id: str = dspy.InputField(desc="Punch card identifier")
    card_requirements: str = dspy.InputField(
        desc="Human-readable required and forbidden punches"
    )
    historical_failures: str = dspy.InputField(
        desc="Prior missing/violated punch patterns"
    )
    exit_condition_prompt: str = dspy.OutputField(
        desc="Prompt text describing when the agent may exit"
    )
    self_check_instruction: str = dspy.OutputField(
        desc="Instruction including check_punch_card.sh invocation"
    )


class PunchCardExitModule(dspy.Module):
    def __init__(self) -> None:
        super().__init__()
        self._predict = dspy.Predict(PunchCardExitSignature)

    def forward(
        self,
        task_description: str,
        card_id: str,
        card_requirements: str,
        historical_failures: str,
    ) -> Any:
        return self._predict(
            task_description=task_description,
            card_id=card_id,
            card_requirements=card_requirements,
            historical_failures=historical_failures,
        )


def _normalize_text(value: Any) -> str:
    return str(value).strip().lower()


def card_exit_metric(
    example: dspy.Example, prediction: Any, trace: Any = None
) -> float:
    del trace
    exit_prompt = _normalize_text(getattr(prediction, "exit_condition_prompt", ""))
    instruction = _normalize_text(getattr(prediction, "self_check_instruction", ""))
    card_id = _normalize_text(getattr(example, "card_id", ""))
    requirements = _normalize_text(getattr(example, "card_requirements", ""))

    if exit_prompt == "" or instruction == "":
        return 0.0

    score = 0.4
    if card_id and card_id in exit_prompt:
        score += 0.2
    if "check_punch_card.sh" in instruction:
        score += 0.2
    if requirements and ("required" in requirements or "forbidden" in requirements):
        if "required" in exit_prompt or "forbidden" in exit_prompt:
            score += 0.2
    return min(score, 1.0)


def build_refined_card_exit(module: PunchCardExitModule) -> Any:
    def _reward_fn(example_dict: dict[str, Any], prediction: Any) -> float:
        return card_exit_metric(dspy.Example(**example_dict), prediction)

    return dspy.Refine(module=module, N=3, reward_fn=_reward_fn, threshold=1.0)


def compile_card_exit_prompts(
    lm: Any,
    training_examples: list[dspy.Example],
    config: CardExitCompileConfig | None = None,
    dspy_version: str | None = None,
) -> list[CardExitCompilationResult]:
    if len(training_examples) == 0:
        raise ValueError("training_examples must be non-empty")

    effective_config = config if config is not None else CardExitCompileConfig()

    by_card: dict[str, list[dspy.Example]] = {}
    for example in training_examples:
        card_id = str(getattr(example, "card_id", "")).strip()
        if card_id == "":
            continue
        by_card.setdefault(card_id, []).append(example)

    if not by_card:
        raise ValueError("No card-tagged examples provided")

    results: list[CardExitCompilationResult] = []
    version = dspy_version if dspy_version is not None else str(dspy.__version__)

    for card_id in sorted(by_card):
        trainset = [
            dspy.Example(**dict(item.toDict())).with_inputs(
                "task_description",
                "card_id",
                "card_requirements",
                "historical_failures",
            )
            for item in by_card[card_id]
        ]

        module = PunchCardExitModule()
        optimizer = BootstrapFewShot(
            metric=card_exit_metric,
            max_bootstrapped_demos=effective_config.max_bootstrapped_demos,
            max_labeled_demos=effective_config.max_labeled_demos,
            max_rounds=effective_config.max_rounds,
        )

        with dspy.context(lm=lm):
            compiled = optimizer.compile(module, trainset=trainset)
            exemplar = trainset[0]
            prediction = compiled(**exemplar.inputs())
            scores = [
                card_exit_metric(example, compiled(**example.inputs()))
                for example in trainset
            ]

        exit_condition_prompt = str(
            getattr(prediction, "exit_condition_prompt", "")
        ).strip()
        self_check_instruction = str(
            getattr(prediction, "self_check_instruction", "")
        ).strip()
        compiled_prompt_text = f"Exit Condition:\n{exit_condition_prompt}\n\nSelf-Check:\n{self_check_instruction}"

        dolt_bus.write_compiled_prompt(
            prompt_id=f"card-exit:{card_id}",
            module_name="card_exit",
            signature_name="PunchCardExitSignature",
            compiled_prompt=compiled_prompt_text,
            dspy_version=version,
        )

        results.append(
            CardExitCompilationResult(
                card_id=card_id,
                compiled_program=compiled,
                compiled_prompt_text=compiled_prompt_text,
                trainset_size=len(trainset),
                average_metric_score=mean(scores),
            )
        )

    return results
