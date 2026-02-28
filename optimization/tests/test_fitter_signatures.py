from __future__ import annotations

from unittest.mock import patch

import dspy  # type: ignore[import-untyped]
import pytest
from dspy.utils import DummyLM  # type: ignore[import-untyped]

from optimization import fitter_signatures as fs


def _report(category: fs.DiagnosisCategory) -> fs.DiagnosisReport:
    return fs.DiagnosisReport(
        session_id="sess-123",
        category=category,
        confidence=0.9,
        summary='Tool "edit_file" failed repeatedly. Last error: permission denied',
        suggested_action="Apply a targeted fix to the affected file.",
        tool_patterns=[
            fs.ToolPattern(
                tool="edit_file", count=7, error_count=4, last_status="error"
            ),
            fs.ToolPattern(tool="read_file", count=3, error_count=0, last_status="ok"),
            fs.ToolPattern(
                tool="execute_command", count=2, error_count=1, last_status="error"
            ),
        ],
    )


def test_format_tool_activity_empty() -> None:
    assert fs.format_tool_activity([]) == "  (no tool activity recorded)"


def test_format_tool_activity_sorts_limits_and_formats_errors() -> None:
    patterns = [
        fs.ToolPattern(
            tool=f"tool-{index}", count=index, error_count=index % 2, last_status="ok"
        )
        for index in range(12)
    ]
    rendered = fs.format_tool_activity(patterns)
    lines = rendered.splitlines()
    assert len(lines) == 10
    assert lines[0].startswith("  - tool-11: 11 calls")
    assert "(1 errors)" in lines[0]
    assert lines[-1].startswith("  - tool-2: 2 calls")


@pytest.mark.parametrize(
    ("category", "markers"),
    [
        (
            "stuck_on_approval",
            [
                "RECOVERY TASK:",
                "stuck waiting for approval",
                "Action:",
                "auto-approve permissions",
            ],
        ),
        (
            "infinite_retry",
            [
                "RECOVERY TASK:",
                "kept retrying",
                "Error message:",
                "Do NOT retry the same approach",
            ],
        ),
        (
            "scope_creep",
            [
                "RECOVERY TASK:",
                "expanded scope far beyond",
                "Do NOT:",
                "Make the minimal change needed",
            ],
        ),
        (
            "context_exhaustion",
            [
                "RECOVERY TASK:",
                "exhausted its context window",
                "Plan:",
                "Do not search the codebase broadly",
            ],
        ),
        (
            "model_confusion",
            [
                "RECOVERY TASK:",
                "producing contradictory changes",
                "SIMPLIFIED INSTRUCTIONS:",
                "Keep it simple",
            ],
        ),
    ],
)
def test_prompt_builders_include_category_markers(
    category: fs.DiagnosisCategory,
    markers: list[str],
) -> None:
    report = _report(category)
    prompt = fs.build_recovery_prompt(report)
    for marker in markers:
        assert marker in prompt


def test_extract_retry_count_defaults_to_three() -> None:
    report = fs.DiagnosisReport(
        session_id="sess-empty",
        category="infinite_retry",
        confidence=0.6,
        summary="No details",
        suggested_action="Try a different approach",
        tool_patterns=[
            fs.ToolPattern(tool="read_file", count=2, error_count=0, last_status="ok")
        ],
    )
    assert fs.extract_retry_count(report) == 3


def test_extract_error_and_tool_defaults() -> None:
    last_error, failing_tool = fs.extract_error_and_tool(
        "summary without regex matches"
    )
    assert last_error == "unknown error"
    assert failing_tool == "unknown tool"


def test_publish_compiled_prompt_writes_to_dolt_bus() -> None:
    report = _report("scope_creep")
    compiled_prompt = fs.build_recovery_prompt(report)
    with patch(
        "optimization.fitter_signatures.dolt_bus.write_compiled_prompt"
    ) as writer:
        prompt_id = fs.publish_compiled_prompt(
            report=report,
            compiled_prompt=compiled_prompt,
            dspy_version="3.1.3",
        )

    assert prompt_id == "fitter-dispatch:scope_creep"
    writer.assert_called_once_with(
        prompt_id="fitter-dispatch:scope_creep",
        module_name="fitter_dispatch",
        signature_name="ScopeCreepSignature",
        compiled_prompt=compiled_prompt,
        dspy_version="3.1.3",
    )


def test_signature_classes_expose_expected_fields() -> None:
    assert set(fs.StuckOnApprovalSignature.__annotations__) == {
        "session_id",
        "summary",
        "suggested_action",
        "tool_activity",
        "recovery_prompt",
    }
    assert set(fs.InfiniteRetrySignature.__annotations__) == {
        "session_id",
        "summary",
        "suggested_action",
        "tool_activity",
        "last_error",
        "failing_tool",
        "retry_count",
        "recovery_prompt",
    }
    assert set(fs.ScopeCreepSignature.__annotations__) == {
        "session_id",
        "summary",
        "suggested_action",
        "tool_activity",
        "recovery_prompt",
    }
    assert set(fs.ContextExhaustionSignature.__annotations__) == {
        "session_id",
        "summary",
        "suggested_action",
        "tool_activity",
        "recovery_prompt",
    }
    assert set(fs.ModelConfusionSignature.__annotations__) == {
        "session_id",
        "summary",
        "suggested_action",
        "tool_activity",
        "recovery_prompt",
    }


@pytest.mark.parametrize(
    "signature_cls,input_payload",
    [
        (
            fs.StuckOnApprovalSignature,
            {
                "session_id": "s1",
                "summary": "x",
                "suggested_action": "y",
                "tool_activity": "z",
            },
        ),
        (
            fs.InfiniteRetrySignature,
            {
                "session_id": "s2",
                "summary": "x",
                "suggested_action": "y",
                "tool_activity": "z",
                "last_error": "err",
                "failing_tool": "tool",
                "retry_count": 4,
            },
        ),
        (
            fs.ScopeCreepSignature,
            {
                "session_id": "s3",
                "summary": "x",
                "suggested_action": "y",
                "tool_activity": "z",
            },
        ),
        (
            fs.ContextExhaustionSignature,
            {
                "session_id": "s4",
                "summary": "x",
                "suggested_action": "y",
                "tool_activity": "z",
            },
        ),
        (
            fs.ModelConfusionSignature,
            {
                "session_id": "s5",
                "summary": "x",
                "suggested_action": "y",
                "tool_activity": "z",
            },
        ),
    ],
)
def test_predict_with_dummy_lm_for_each_signature(
    signature_cls: type,
    input_payload: dict[str, str | int],
) -> None:
    lm = DummyLM([{"recovery_prompt": "compiled prompt"}])
    predictor = dspy.Predict(signature_cls)
    with dspy.context(lm=lm):
        prediction = predictor(**input_payload)
    assert prediction.recovery_prompt == "compiled prompt"
