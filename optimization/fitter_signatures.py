from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
import re

import dspy  # type: ignore[import-untyped]

from optimization import dolt_bus


DiagnosisCategory = Literal[
    "stuck_on_approval",
    "infinite_retry",
    "scope_creep",
    "context_exhaustion",
    "model_confusion",
]


@dataclass(frozen=True)
class ToolPattern:
    tool: str
    count: int
    error_count: int
    last_status: str


@dataclass(frozen=True)
class DiagnosisReport:
    session_id: str
    category: DiagnosisCategory
    confidence: float
    summary: str
    suggested_action: str
    tool_patterns: list[ToolPattern]


class StuckOnApprovalSignature(dspy.Signature):  # type: ignore[misc]
    """Generate a recovery prompt for a session stuck waiting for approval. The fitter has full auto-approve permissions."""

    session_id: str = dspy.InputField(desc="Session ID of the failed session")
    summary: str = dspy.InputField(desc="Human-readable diagnosis summary")
    suggested_action: str = dspy.InputField(desc="Suggested recovery action")
    tool_activity: str = dspy.InputField(desc="Formatted tool activity lines")
    recovery_prompt: str = dspy.OutputField(
        desc="Complete recovery prompt for bounded fitter session"
    )


class InfiniteRetrySignature(dspy.Signature):  # type: ignore[misc]
    """Generate a recovery prompt for repeated retries that keep failing with the same error."""

    session_id: str = dspy.InputField(desc="Session ID of the failed session")
    summary: str = dspy.InputField(desc="Human-readable diagnosis summary")
    suggested_action: str = dspy.InputField(desc="Suggested recovery action")
    tool_activity: str = dspy.InputField(desc="Formatted tool activity lines")
    last_error: str = dspy.InputField(desc="Last error extracted from summary")
    failing_tool: str = dspy.InputField(desc="Failing tool extracted from summary")
    retry_count: int = dspy.InputField(desc="Estimated retry count from tool activity")
    recovery_prompt: str = dspy.OutputField(
        desc="Complete recovery prompt for bounded fitter session"
    )


class ScopeCreepSignature(dspy.Signature):  # type: ignore[misc]
    """Generate a recovery prompt that constrains scope to the original task."""

    session_id: str = dspy.InputField(desc="Session ID of the failed session")
    summary: str = dspy.InputField(desc="Human-readable diagnosis summary")
    suggested_action: str = dspy.InputField(desc="Suggested recovery action")
    tool_activity: str = dspy.InputField(desc="Formatted tool activity lines")
    recovery_prompt: str = dspy.OutputField(
        desc="Complete recovery prompt for bounded fitter session"
    )


class ContextExhaustionSignature(dspy.Signature):  # type: ignore[misc]
    """Generate a recovery prompt for context-exhaustion failures with one-file-at-a-time strategy."""

    session_id: str = dspy.InputField(desc="Session ID of the failed session")
    summary: str = dspy.InputField(desc="Human-readable diagnosis summary")
    suggested_action: str = dspy.InputField(desc="Suggested recovery action")
    tool_activity: str = dspy.InputField(desc="Formatted tool activity lines")
    recovery_prompt: str = dspy.OutputField(
        desc="Complete recovery prompt for bounded fitter session"
    )


class ModelConfusionSignature(dspy.Signature):  # type: ignore[misc]
    """Generate a simplified recovery prompt when the previous session produced contradictory changes."""

    session_id: str = dspy.InputField(desc="Session ID of the failed session")
    summary: str = dspy.InputField(desc="Human-readable diagnosis summary")
    suggested_action: str = dspy.InputField(desc="Suggested recovery action")
    tool_activity: str = dspy.InputField(desc="Formatted tool activity lines")
    recovery_prompt: str = dspy.OutputField(
        desc="Complete recovery prompt for bounded fitter session"
    )


def format_tool_activity(patterns: list[ToolPattern]) -> str:
    """Format tool activity to match the TypeScript formatToolSummary helper."""
    if len(patterns) == 0:
        return "  (no tool activity recorded)"

    top_patterns = sorted(patterns, key=lambda pattern: pattern.count, reverse=True)[
        :10
    ]
    lines: list[str] = []
    for pattern in top_patterns:
        suffix = f" ({pattern.error_count} errors)" if pattern.error_count > 0 else ""
        lines.append(f"  - {pattern.tool}: {pattern.count} calls{suffix}")
    return "\n".join(lines)


def extract_retry_count(report: DiagnosisReport) -> int:
    """Extract retry count to match the TypeScript extractRetryCount helper."""
    failing_patterns = [p for p in report.tool_patterns if p.error_count > 0]
    if len(failing_patterns) == 0:
        return 3
    return max(pattern.error_count for pattern in failing_patterns)


def extract_error_and_tool(summary: str) -> tuple[str, str]:
    """Extract last_error and failing_tool from summary with TS-equivalent defaults."""
    error_match = re.search(r"Last error: (.+)", summary)
    tool_match = re.search(r'Tool "([^"]+)"', summary)
    last_error = error_match.group(1) if error_match is not None else "unknown error"
    failing_tool = tool_match.group(1) if tool_match is not None else "unknown tool"
    return last_error, failing_tool


def _build_stuck_on_approval_prompt(report: DiagnosisReport) -> str:
    tool_activity = format_tool_activity(report.tool_patterns)
    return "\n".join(
        [
            f"RECOVERY TASK: Complete the work that session {report.session_id} could not finish.",
            "",
            f"Problem: {report.summary}",
            "The previous session was stuck waiting for approval that never came.",
            "",
            f"Action: {report.suggested_action}",
            "",
            "Previous session tool activity:",
            tool_activity,
            "",
            "You have full auto-approve permissions for all file operations.",
            "Complete the pending changes, verify correctness, commit, and exit.",
        ]
    )


def _build_infinite_retry_prompt(report: DiagnosisReport) -> str:
    last_error, failing_tool = extract_error_and_tool(report.summary)
    retry_count = extract_retry_count(report)
    tool_activity = format_tool_activity(report.tool_patterns)

    return "\n".join(
        [
            f"RECOVERY TASK: Fix the error that caused session {report.session_id} to loop.",
            "",
            f"Problem: {report.summary}",
            f'The previous session kept retrying "{failing_tool}" and hitting the same error.',
            "",
            f"Error message: {last_error}",
            f"Hint: Do NOT retry the same approach. The previous session already tried it {retry_count} times and failed.",
            "Analyze the error, understand the root cause, and apply a different fix.",
            "",
            "Previous session tool activity:",
            tool_activity,
            "",
            "Fix the underlying issue, verify the fix works, commit, and exit.",
        ]
    )


def _build_scope_creep_prompt(report: DiagnosisReport) -> str:
    tool_activity = format_tool_activity(report.tool_patterns)
    return "\n".join(
        [
            f"RECOVERY TASK: Complete ONLY the core fix from session {report.session_id}.",
            "",
            f"Problem: {report.summary}",
            "The previous session expanded scope far beyond the original task.",
            "",
            "Previous session tool activity:",
            tool_activity,
            "",
            f"Action: {report.suggested_action}",
            "",
            "Do NOT:",
            "- Refactor unrelated code",
            "- Add features not directly required by the fix",
            "- Expand scope beyond the original task",
            "",
            "Make the minimal change needed, verify it, commit, and exit.",
        ]
    )


def _build_context_exhaustion_prompt(report: DiagnosisReport) -> str:
    tool_activity = format_tool_activity(report.tool_patterns)
    return "\n".join(
        [
            f"RECOVERY TASK: Complete the work from session {report.session_id} using a focused approach.",
            "",
            f"Problem: {report.summary}",
            "The previous session exhausted its context window re-reading the same content.",
            "",
            "Previous session tool activity:",
            tool_activity,
            "",
            "Strategy: Work on ONE file at a time. Do not read files you don't need to edit.",
            "",
            "Plan:",
            "1. Identify which file needs the primary fix",
            "2. Make the change in that file",
            "3. If dependent files need updating, handle them one at a time",
            "4. Commit after each logical change",
            "5. Exit when the task is complete",
            "",
            "Do not search the codebase broadly. Stay focused on the task.",
        ]
    )


def _build_model_confusion_prompt(report: DiagnosisReport) -> str:
    tool_activity = format_tool_activity(report.tool_patterns)
    return "\n".join(
        [
            f"RECOVERY TASK: Fix what session {report.session_id} could not.",
            "",
            f"Problem: {report.summary}",
            "The previous session was confused and producing contradictory changes.",
            "",
            "Previous session tool activity:",
            tool_activity,
            "",
            "SIMPLIFIED INSTRUCTIONS:",
            "1. Gather context on the task",
            "2. Identify what needs to change",
            "3. Make the change",
            "4. Commit and exit",
            "",
            f"Suggested approach: {report.suggested_action}",
            "",
            "Keep it simple. One change at a time. Do not over-think.",
        ]
    )


def build_recovery_prompt(report: DiagnosisReport) -> str:
    """Build category-specific recovery prompt from diagnosis report."""
    if report.category == "stuck_on_approval":
        return _build_stuck_on_approval_prompt(report)
    if report.category == "infinite_retry":
        return _build_infinite_retry_prompt(report)
    if report.category == "scope_creep":
        return _build_scope_creep_prompt(report)
    if report.category == "context_exhaustion":
        return _build_context_exhaustion_prompt(report)
    return _build_model_confusion_prompt(report)


SIGNATURE_NAME_BY_CATEGORY: dict[DiagnosisCategory, str] = {
    "stuck_on_approval": "StuckOnApprovalSignature",
    "infinite_retry": "InfiniteRetrySignature",
    "scope_creep": "ScopeCreepSignature",
    "context_exhaustion": "ContextExhaustionSignature",
    "model_confusion": "ModelConfusionSignature",
}


def publish_compiled_prompt(
    report: DiagnosisReport,
    compiled_prompt: str,
    dspy_version: str,
) -> str:
    """Publish a compiled fitter dispatch prompt using the Dolt bus writer."""
    prompt_id = f"fitter-dispatch:{report.category}"
    dolt_bus.write_compiled_prompt(
        prompt_id=prompt_id,
        module_name="fitter_dispatch",
        signature_name=SIGNATURE_NAME_BY_CATEGORY[report.category],
        compiled_prompt=compiled_prompt,
        dspy_version=dspy_version,
    )
    return prompt_id
