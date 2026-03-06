from __future__ import annotations

from unittest.mock import patch

import dspy  # type: ignore[import-untyped]
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
