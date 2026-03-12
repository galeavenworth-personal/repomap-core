from __future__ import annotations

from unittest.mock import patch

import dspy  # type: ignore[import-untyped]
import pytest
from dspy.utils.dummies import DummyLM  # type: ignore[import-untyped]

from optimization import card_exit


def _training_examples() -> list[dspy.Example]:
    return [
        dspy.Example(
            task_description="Implement feature A",
            card_id="execute-subtask",
            card_requirements="REQUIRED gate_pass:ruff-check; FORBIDDEN child_spawn:%",
            historical_failures="missing gate_pass:pytest",
            exit_condition_prompt="Do not exit until execute-subtask required punches are satisfied.",
            self_check_instruction="Run .kilocode/tools/check_punch_card.sh $SESSION_ID execute-subtask before exiting.",
        ).with_inputs(
            "task_description",
            "card_id",
            "card_requirements",
            "historical_failures",
        ),
        dspy.Example(
            task_description="Coordinate specialist delegation",
            card_id="plant-orchestrate",
            card_requirements="REQUIRED child_spawn:%; FORBIDDEN tool_call:edit_file%",
            historical_failures="FORBIDDEN violation tool_call:write_to_file",
            exit_condition_prompt="Exit only when plant-orchestrate requirements are met.",
            self_check_instruction="Run .kilocode/tools/check_punch_card.sh $SESSION_ID plant-orchestrate before completion.",
        ).with_inputs(
            "task_description",
            "card_id",
            "card_requirements",
            "historical_failures",
        ),
    ]


def test_compile_card_exit_prompts_smoke_with_dummy_lm() -> None:
    lm = DummyLM(
        [
            {
                "exit_condition_prompt": "Do not exit until execute-subtask required punches are satisfied.",
                "self_check_instruction": "Run .kilocode/tools/check_punch_card.sh $SESSION_ID execute-subtask before exiting.",
            },
            {
                "exit_condition_prompt": "Exit only when plant-orchestrate requirements are met.",
                "self_check_instruction": "Run .kilocode/tools/check_punch_card.sh $SESSION_ID plant-orchestrate before completion.",
            },
        ]
        * 32
    )

    with patch("optimization.card_exit.dolt_bus.write_compiled_prompt") as writer:
        results = card_exit.compile_card_exit_prompts(
            lm=lm,
            training_examples=_training_examples(),
            config=card_exit.CardExitCompileConfig(
                max_bootstrapped_demos=1,
                max_labeled_demos=2,
                max_rounds=1,
            ),
        )

    assert len(results) == 2
    assert writer.call_count == 2
    assert [result.card_id for result in results] == [
        "execute-subtask",
        "plant-orchestrate",
    ]
    assert all(
        "check_punch_card.sh" in result.compiled_prompt_text for result in results
    )


def test_build_refined_card_exit_returns_refine_module() -> None:
    refined = card_exit.build_refined_card_exit(card_exit.PunchCardExitModule())
    assert refined is not None


def _orchestration_training_examples() -> list[dspy.Example]:
    return [
        dspy.Example(
            workflow_name="plant-orchestrate",
            expected_child_modes="explore,execute-subtask",
            expected_phase_count="3",
            forbidden_parent_tools="edit_file,write_to_file",
            historical_deviations="parent called edit_file directly",
            delegation_instructions="Spawn explore child first, then execute-subtask child for implementation.",
            phase_ordering_instructions="Execute 3 sequential phases: explore, prepare, execute.",
            tool_prohibition_instructions="The orchestrator must not call edit_file or write_to_file directly.",
        ).with_inputs(
            "workflow_name",
            "expected_child_modes",
            "expected_phase_count",
            "forbidden_parent_tools",
            "historical_deviations",
        ),
        dspy.Example(
            workflow_name="review-orchestrate",
            expected_child_modes="code-review,test-runner",
            expected_phase_count="2",
            forbidden_parent_tools="run_command",
            historical_deviations="skipped test-runner phase",
            delegation_instructions="Delegate to code-review and test-runner children.",
            phase_ordering_instructions="Execute 2 sequential phases: review then test.",
            tool_prohibition_instructions="The orchestrator must not call run_command directly.",
        ).with_inputs(
            "workflow_name",
            "expected_child_modes",
            "expected_phase_count",
            "forbidden_parent_tools",
            "historical_deviations",
        ),
    ]


def test_compile_orchestration_compliance_smoke_with_dummy_lm() -> None:
    lm = DummyLM(
        [
            {
                "delegation_instructions": "Spawn explore child first, then execute-subtask child for implementation.",
                "phase_ordering_instructions": "Execute 3 sequential phases: explore, prepare, execute.",
                "tool_prohibition_instructions": "The orchestrator must not call edit_file or write_to_file directly.",
            },
            {
                "delegation_instructions": "Delegate to code-review and test-runner children.",
                "phase_ordering_instructions": "Execute 2 sequential phases: review then test.",
                "tool_prohibition_instructions": "The orchestrator must not call run_command directly.",
            },
        ]
        * 32
    )

    with patch("optimization.card_exit.dolt_bus.write_compiled_prompt") as writer:
        results = card_exit.compile_orchestration_compliance_prompts(
            lm=lm,
            training_examples=_orchestration_training_examples(),
            config=card_exit.CardExitCompileConfig(
                max_bootstrapped_demos=1,
                max_labeled_demos=2,
                max_rounds=1,
            ),
        )

    assert len(results) == 2
    assert writer.call_count == 2
    assert [result.workflow_name for result in results] == [
        "plant-orchestrate",
        "review-orchestrate",
    ]


def test_orchestration_compliance_metric_scoring() -> None:
    example = dspy.Example(
        workflow_name="plant-orchestrate",
        expected_child_modes="explore,execute-subtask",
        expected_phase_count="3",
        forbidden_parent_tools="edit_file,write_to_file",
        historical_deviations="parent called edit_file directly",
    )

    # Empty outputs → 0.0
    empty_pred = dspy.Example(
        delegation_instructions="",
        phase_ordering_instructions="",
        tool_prohibition_instructions="",
    )
    assert card_exit.orchestration_compliance_metric(
        example, empty_pred
    ) == pytest.approx(0.0)

    # Base only (no keywords matched) → 0.3
    base_pred = dspy.Example(
        delegation_instructions="do something generic",
        phase_ordering_instructions="do something generic",
        tool_prohibition_instructions="do something generic",
    )
    assert card_exit.orchestration_compliance_metric(
        example, base_pred
    ) == pytest.approx(0.3)

    # All bonuses → 1.0
    full_pred = dspy.Example(
        delegation_instructions="Spawn explore child and execute-subtask child.",
        phase_ordering_instructions="Execute 3 sequential phases in order.",
        tool_prohibition_instructions="Never call edit_file or write_to_file.",
    )
    assert card_exit.orchestration_compliance_metric(
        example, full_pred
    ) == pytest.approx(1.0)

    # Partial: only child mode match → 0.5
    partial_pred = dspy.Example(
        delegation_instructions="Spawn explore child.",
        phase_ordering_instructions="do generic ordering",
        tool_prohibition_instructions="do generic prohibition",
    )
    assert card_exit.orchestration_compliance_metric(
        example, partial_pred
    ) == pytest.approx(0.5)


def test_build_refined_orchestration_compliance_returns_refine_module() -> None:
    refined = card_exit.build_refined_orchestration_compliance(
        card_exit.OrchestrationComplianceModule()
    )
    assert refined is not None
