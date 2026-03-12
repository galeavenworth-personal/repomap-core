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


@dataclass(frozen=True)
class OrchestrationComplianceResult:
    workflow_name: str
    compiled_program: Any
    compiled_prompt_text: str
    trainset_size: int
    average_metric_score: float


class OrchestrationComplianceSignature(dspy.Signature):  # type: ignore[misc]
    """Generate orchestrator-level compliance instructions for delegation, phase ordering, and tool prohibitions."""

    workflow_name: str = dspy.InputField(
        desc="Name of the orchestration workflow (e.g. plant-orchestrate)"
    )
    expected_child_modes: str = dspy.InputField(
        desc="Comma-separated list of expected child agent modes"
    )
    expected_phase_count: str = dspy.InputField(
        desc="Number of sequential phases expected in the workflow"
    )
    forbidden_parent_tools: str = dspy.InputField(
        desc="Comma-separated list of tools the parent must not call"
    )
    historical_deviations: str = dspy.InputField(
        desc="Prior orchestration deviations or violations"
    )
    delegation_instructions: str = dspy.OutputField(
        desc="Instructions for which children to spawn and in what modes"
    )
    phase_ordering_instructions: str = dspy.OutputField(
        desc="Instructions for sequential phase execution ordering"
    )
    tool_prohibition_instructions: str = dspy.OutputField(
        desc="Instructions for tools the orchestrator must not use directly"
    )


class OrchestrationComplianceModule(dspy.Module):
    def __init__(self) -> None:
        super().__init__()
        self._predict = dspy.Predict(OrchestrationComplianceSignature)

    def forward(
        self,
        workflow_name: str,
        expected_child_modes: str,
        expected_phase_count: str,
        forbidden_parent_tools: str,
        historical_deviations: str,
    ) -> Any:
        return self._predict(
            workflow_name=workflow_name,
            expected_child_modes=expected_child_modes,
            expected_phase_count=expected_phase_count,
            forbidden_parent_tools=forbidden_parent_tools,
            historical_deviations=historical_deviations,
        )


def orchestration_compliance_metric(
    example: dspy.Example, prediction: Any, trace: Any = None
) -> float:
    del trace
    delegation = _normalize_text(getattr(prediction, "delegation_instructions", ""))
    phase_ordering = _normalize_text(
        getattr(prediction, "phase_ordering_instructions", "")
    )
    tool_prohibition = _normalize_text(
        getattr(prediction, "tool_prohibition_instructions", "")
    )

    if delegation == "" or phase_ordering == "" or tool_prohibition == "":
        return 0.0

    score = 0.3

    expected_modes = _normalize_text(getattr(example, "expected_child_modes", ""))
    if expected_modes:
        for mode in expected_modes.split(","):
            mode = mode.strip()
            if mode and mode in delegation:
                score += 0.2
                break

    phase_count = _normalize_text(getattr(example, "expected_phase_count", ""))
    if (
        phase_count in phase_ordering
        or "sequential" in phase_ordering
        or "phase" in phase_ordering
    ):
        score += 0.2

    forbidden_tools = _normalize_text(getattr(example, "forbidden_parent_tools", ""))
    if forbidden_tools:
        for tool in forbidden_tools.split(","):
            tool = tool.strip()
            if tool and tool in tool_prohibition:
                score += 0.3
                break

    return min(score, 1.0)


def build_refined_orchestration_compliance(
    module: OrchestrationComplianceModule,
) -> Any:
    def _reward_fn(example_dict: dict[str, Any], prediction: Any) -> float:
        return orchestration_compliance_metric(dspy.Example(**example_dict), prediction)

    return dspy.Refine(module=module, N=3, reward_fn=_reward_fn, threshold=1.0)


def compile_orchestration_compliance_prompts(
    lm: Any,
    training_examples: list[dspy.Example],
    config: CardExitCompileConfig | None = None,
    dspy_version: str | None = None,
) -> list[OrchestrationComplianceResult]:
    if len(training_examples) == 0:
        raise ValueError("training_examples must be non-empty")

    effective_config = config if config is not None else CardExitCompileConfig()

    by_workflow: dict[str, list[dspy.Example]] = {}
    for example in training_examples:
        workflow_name = str(getattr(example, "workflow_name", "")).strip()
        if workflow_name == "":
            continue
        by_workflow.setdefault(workflow_name, []).append(example)

    if not by_workflow:
        raise ValueError("No workflow-tagged examples provided")

    results: list[OrchestrationComplianceResult] = []
    version = dspy_version if dspy_version is not None else str(dspy.__version__)

    for workflow_name in sorted(by_workflow):
        trainset = [
            dspy.Example(**dict(item.toDict())).with_inputs(
                "workflow_name",
                "expected_child_modes",
                "expected_phase_count",
                "forbidden_parent_tools",
                "historical_deviations",
            )
            for item in by_workflow[workflow_name]
        ]

        module = OrchestrationComplianceModule()
        optimizer = BootstrapFewShot(
            metric=orchestration_compliance_metric,
            max_bootstrapped_demos=effective_config.max_bootstrapped_demos,
            max_labeled_demos=effective_config.max_labeled_demos,
            max_rounds=effective_config.max_rounds,
        )

        with dspy.context(lm=lm):
            compiled = optimizer.compile(module, trainset=trainset)
            exemplar = trainset[0]
            prediction = compiled(**exemplar.inputs())
            scores = [
                orchestration_compliance_metric(example, compiled(**example.inputs()))
                for example in trainset
            ]

        delegation_instructions = str(
            getattr(prediction, "delegation_instructions", "")
        ).strip()
        phase_ordering_instructions = str(
            getattr(prediction, "phase_ordering_instructions", "")
        ).strip()
        tool_prohibition_instructions = str(
            getattr(prediction, "tool_prohibition_instructions", "")
        ).strip()
        compiled_prompt_text = (
            f"Delegation:\n{delegation_instructions}\n\n"
            f"Phase Ordering:\n{phase_ordering_instructions}\n\n"
            f"Tool Prohibitions:\n{tool_prohibition_instructions}"
        )

        dolt_bus.write_compiled_prompt(
            prompt_id=f"orchestration-compliance:{workflow_name}",
            module_name="card_exit",
            signature_name="OrchestrationComplianceSignature",
            compiled_prompt=compiled_prompt_text,
            dspy_version=version,
        )

        results.append(
            OrchestrationComplianceResult(
                workflow_name=workflow_name,
                compiled_program=compiled,
                compiled_prompt_text=compiled_prompt_text,
                trainset_size=len(trainset),
                average_metric_score=mean(scores),
            )
        )

    return results
