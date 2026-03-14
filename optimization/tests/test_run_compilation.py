from __future__ import annotations

from unittest.mock import MagicMock, patch

import dspy  # type: ignore[import-untyped]
from dspy.utils.dummies import DummyLM  # type: ignore[import-untyped]

from optimization import run_compilation


_DUMMY_RESPONSES = [
    {
        "exit_condition_prompt": "Do not exit until card requirements are satisfied.",
        "self_check_instruction": "Run .kilocode/tools/check_punch_card.sh $SESSION_ID test-card before exiting.",
        "recovery_prompt": "Focus on the diagnosed failure mode and recover deterministically.",
    },
] * 32


def _make_example(
    card_id: str | None = "execute-subtask",
    hierarchy_depth: int = 0,
    formula_id: str = "none",
    bead_type: str = "unknown",
) -> dspy.Example:
    """Create a minimal training example for run_compilation tests."""
    card_fragment = card_id or "missing-card"
    return dspy.Example(
        task_id=f"task-{card_fragment}-{hierarchy_depth}-{formula_id}",
        session_id=f"session-{card_fragment}",
        summary="test summary",
        tool_activity="test activity",
        card_id=card_id,
        card_status="pass",
        missing_punches="",
        mode="code",
        total_punches=10,
        tool_calls=5,
        total_cost=1.0,
        duration_minutes=10,
        child_modes="",
        parent_forbidden_tool_violations="",
        workflow_id="",
        bead_type=bead_type,
        hierarchy_depth=hierarchy_depth,
        has_parent=False,
        formula_id=formula_id,
        epic_outcome="unknown",
        outcome_label="success",
        diagnosis_category="stuck_on_approval",
        is_kill_recovery=False,
    ).with_inputs(
        "task_id",
        "session_id",
        "summary",
        "tool_activity",
        "card_id",
        "card_status",
        "missing_punches",
        "mode",
        "total_punches",
        "tool_calls",
        "total_cost",
        "duration_minutes",
        "child_modes",
        "parent_forbidden_tool_violations",
        "workflow_id",
        "bead_type",
        "hierarchy_depth",
        "has_parent",
        "formula_id",
        "epic_outcome",
    )


def _prompt_ids(mock_write_prompt: MagicMock) -> set[str]:
    prompt_ids: set[str] = set()
    for call in mock_write_prompt.call_args_list:
        if "prompt_id" in call.kwargs:
            prompt_ids.add(str(call.kwargs["prompt_id"]))
    return prompt_ids


def _base_card_definitions() -> dict[str, dict[str, list[str]]]:
    return {
        "execute-subtask": {
            "required": ["gate_pass:ruff-check"],
            "forbidden": ["child_spawn:%"],
        }
    }


def test_group_examples_basic() -> None:
    examples = [
        _make_example(card_id="card-a"),
        _make_example(card_id="card-a"),
        _make_example(card_id="card-b"),
    ]

    groups = run_compilation.group_examples_by_card(examples)

    assert len(groups["card-a"].all_examples) == 2
    assert len(groups["card-b"].all_examples) == 1


def test_group_examples_depth_subgroups() -> None:
    examples = [
        _make_example(card_id="card-a", hierarchy_depth=2),
        _make_example(card_id="card-a", hierarchy_depth=2),
        _make_example(card_id="card-a", hierarchy_depth=2),
        _make_example(card_id="card-a", hierarchy_depth=3),
        _make_example(card_id="card-a", hierarchy_depth=3),
    ]

    groups = run_compilation.group_examples_by_card(examples)

    assert len(groups["card-a"].by_depth[2]) == 3
    assert len(groups["card-a"].by_depth[3]) == 2


def test_group_examples_depth_zero_excluded() -> None:
    groups = run_compilation.group_examples_by_card(
        [_make_example(card_id="card-a", hierarchy_depth=0)]
    )

    assert 0 not in groups["card-a"].by_depth


def test_group_examples_formula_subgroups() -> None:
    groups = run_compilation.group_examples_by_card(
        [
            _make_example(card_id="card-a", formula_id="pr-review"),
            _make_example(card_id="card-a", formula_id="pr-review"),
            _make_example(card_id="card-a", formula_id="pr-review"),
        ]
    )

    assert len(groups["card-a"].by_formula["pr-review"]) == 3


def test_group_examples_formula_none_excluded() -> None:
    groups = run_compilation.group_examples_by_card(
        [_make_example(card_id="card-a", formula_id="none")]
    )

    assert "none" not in groups["card-a"].by_formula


def test_group_examples_no_card_id_excluded() -> None:
    groups = run_compilation.group_examples_by_card([_make_example(card_id=None)])

    assert groups == {}


def test_generate_card_exit_prompt_basic() -> None:
    lm = DummyLM(_DUMMY_RESPONSES)

    output = run_compilation.generate_card_exit_prompt(
        lm=lm,
        card_id="test-card",
        card_def={"required": ["gate_pass:pytest"], "forbidden": ["child_spawn:%"]},
        failures=["missing gate_pass:pytest"],
    )

    assert "Exit Condition:" in output
    assert "Self-Check:" in output


def test_generate_card_exit_prompt_with_specialization() -> None:
    lm = DummyLM(_DUMMY_RESPONSES)

    output = run_compilation.generate_card_exit_prompt(
        lm=lm,
        card_id="test-card",
        card_def={"required": ["gate_pass:pytest"], "forbidden": ["child_spawn:%"]},
        failures=["missing gate_pass:pytest"],
        hierarchy_depth=3,
        formula_id="pr-review",
    )

    assert isinstance(output, str)


@patch("optimization.run_compilation._connect")
@patch("optimization.run_compilation.dolt_bus.write_compiled_prompt")
@patch("optimization.run_compilation.build_training_set")
@patch("optimization.run_compilation.load_checkpoint_failures")
@patch("optimization.run_compilation.load_punch_card_definitions")
@patch("optimization.run_compilation.configure_lm")
def test_run_writes_generic_prompt_always(
    mock_configure_lm: MagicMock,
    mock_load_cards: MagicMock,
    mock_load_failures: MagicMock,
    mock_build_training: MagicMock,
    mock_write_prompt: MagicMock,
    mock_connect: MagicMock,
) -> None:
    mock_configure_lm.return_value = DummyLM(_DUMMY_RESPONSES)
    mock_load_cards.return_value = _base_card_definitions()
    mock_load_failures.return_value = {"execute-subtask": ["missing gate_pass:pytest"]}
    mock_build_training.return_value = [
        _make_example(hierarchy_depth=2),
        _make_example(hierarchy_depth=2),
    ]

    run_compilation.run(lm_name="dummy", dry_run=False)

    prompt_ids = _prompt_ids(mock_write_prompt)
    assert "card-exit:execute-subtask" in prompt_ids
    assert "card-exit:execute-subtask:depth-2" not in prompt_ids
    assert not any(
        prompt_id.startswith("card-exit:execute-subtask:formula-")
        for prompt_id in prompt_ids
    )


@patch("optimization.run_compilation._connect")
@patch("optimization.run_compilation.dolt_bus.write_compiled_prompt")
@patch("optimization.run_compilation.build_training_set")
@patch("optimization.run_compilation.load_checkpoint_failures")
@patch("optimization.run_compilation.load_punch_card_definitions")
@patch("optimization.run_compilation.configure_lm")
def test_run_writes_depth_specialization_above_threshold(
    mock_configure_lm: MagicMock,
    mock_load_cards: MagicMock,
    mock_load_failures: MagicMock,
    mock_build_training: MagicMock,
    mock_write_prompt: MagicMock,
    mock_connect: MagicMock,
) -> None:
    mock_configure_lm.return_value = DummyLM(_DUMMY_RESPONSES)
    mock_load_cards.return_value = _base_card_definitions()
    mock_load_failures.return_value = {"execute-subtask": []}
    mock_build_training.return_value = [
        _make_example(hierarchy_depth=2),
        _make_example(hierarchy_depth=2),
        _make_example(hierarchy_depth=2),
    ]

    run_compilation.run(lm_name="dummy", dry_run=False)

    prompt_ids = _prompt_ids(mock_write_prompt)
    assert "card-exit:execute-subtask" in prompt_ids
    assert "card-exit:execute-subtask:depth-2" in prompt_ids


@patch("optimization.run_compilation._connect")
@patch("optimization.run_compilation.dolt_bus.write_compiled_prompt")
@patch("optimization.run_compilation.build_training_set")
@patch("optimization.run_compilation.load_checkpoint_failures")
@patch("optimization.run_compilation.load_punch_card_definitions")
@patch("optimization.run_compilation.configure_lm")
def test_run_skips_depth_specialization_below_threshold(
    mock_configure_lm: MagicMock,
    mock_load_cards: MagicMock,
    mock_load_failures: MagicMock,
    mock_build_training: MagicMock,
    mock_write_prompt: MagicMock,
    mock_connect: MagicMock,
) -> None:
    mock_configure_lm.return_value = DummyLM(_DUMMY_RESPONSES)
    mock_load_cards.return_value = _base_card_definitions()
    mock_load_failures.return_value = {"execute-subtask": []}
    mock_build_training.return_value = [
        _make_example(hierarchy_depth=2),
        _make_example(hierarchy_depth=2),
    ]

    run_compilation.run(lm_name="dummy", dry_run=False)

    prompt_ids = _prompt_ids(mock_write_prompt)
    assert "card-exit:execute-subtask:depth-2" not in prompt_ids


@patch("optimization.run_compilation._connect")
@patch("optimization.run_compilation.dolt_bus.write_compiled_prompt")
@patch("optimization.run_compilation.build_training_set")
@patch("optimization.run_compilation.load_checkpoint_failures")
@patch("optimization.run_compilation.load_punch_card_definitions")
@patch("optimization.run_compilation.configure_lm")
def test_run_writes_formula_specialization_above_threshold(
    mock_configure_lm: MagicMock,
    mock_load_cards: MagicMock,
    mock_load_failures: MagicMock,
    mock_build_training: MagicMock,
    mock_write_prompt: MagicMock,
    mock_connect: MagicMock,
) -> None:
    mock_configure_lm.return_value = DummyLM(_DUMMY_RESPONSES)
    mock_load_cards.return_value = _base_card_definitions()
    mock_load_failures.return_value = {"execute-subtask": []}
    mock_build_training.return_value = [
        _make_example(formula_id="pr-review"),
        _make_example(formula_id="pr-review"),
        _make_example(formula_id="pr-review"),
    ]

    run_compilation.run(lm_name="dummy", dry_run=False)

    prompt_ids = _prompt_ids(mock_write_prompt)
    assert "card-exit:execute-subtask:formula-pr-review" in prompt_ids


@patch("optimization.run_compilation._connect")
@patch("optimization.run_compilation.dolt_bus.write_compiled_prompt")
@patch("optimization.run_compilation.build_training_set")
@patch("optimization.run_compilation.load_checkpoint_failures")
@patch("optimization.run_compilation.load_punch_card_definitions")
@patch("optimization.run_compilation.configure_lm")
def test_run_skips_formula_specialization_below_threshold(
    mock_configure_lm: MagicMock,
    mock_load_cards: MagicMock,
    mock_load_failures: MagicMock,
    mock_build_training: MagicMock,
    mock_write_prompt: MagicMock,
    mock_connect: MagicMock,
) -> None:
    mock_configure_lm.return_value = DummyLM(_DUMMY_RESPONSES)
    mock_load_cards.return_value = _base_card_definitions()
    mock_load_failures.return_value = {"execute-subtask": []}
    mock_build_training.return_value = [
        _make_example(formula_id="pr-review"),
        _make_example(formula_id="pr-review"),
    ]

    run_compilation.run(lm_name="dummy", dry_run=False)

    prompt_ids = _prompt_ids(mock_write_prompt)
    assert "card-exit:execute-subtask:formula-pr-review" not in prompt_ids
