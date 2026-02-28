from __future__ import annotations

import re
from collections.abc import Callable, Mapping

import dspy  # type: ignore[import-untyped]

_SUMMARY_FIELD_RE = re.compile(r"(?P<key>[a-zA-Z_]\w*)=(?P<value>[^\s]+)")
_TOOL_ACTIVITY_RE = re.compile(
    r"^\s*-\s*(?P<key>[a-zA-Z_]\w*)\s*:\s*(?P<value>-?\d+)\s*$"
)


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(value, maximum))


def _parse_summary_fields(summary: str) -> dict[str, str]:
    """Parse key=value fields from the synthetic summary string."""
    return {
        match.group("key"): match.group("value")
        for match in _SUMMARY_FIELD_RE.finditer(summary)
    }


def _parse_tool_activity(tool_activity: str) -> dict[str, int]:
    """Parse tool activity bullet lines into integer counters."""
    parsed: dict[str, int] = {}
    for line in tool_activity.splitlines():
        match = _TOOL_ACTIVITY_RE.match(line)
        if not match:
            continue
        parsed[match.group("key")] = int(match.group("value"))
    return parsed


def punch_card_pass_rate(example: dspy.Example) -> float:
    fields = _parse_summary_fields(str(getattr(example, "summary", "")))
    checkpoint = fields.get("checkpoint", "none")

    if checkpoint == "pass":
        return 1.0
    if checkpoint == "fail":
        return 0.0

    completion_ratio_raw = fields.get("completion_ratio", "0")
    try:
        completion_ratio = float(completion_ratio_raw)
    except ValueError:
        return 0.0
    return _clamp(completion_ratio)


def cost_efficiency(example: dspy.Example) -> float:
    total_cost = float(getattr(example, "total_cost", 0.0))
    return _clamp(1.0 - (total_cost / 8.0))


def task_completion_rate(example: dspy.Example) -> float:
    return 1.0 if str(getattr(example, "outcome_label", "")) == "success" else 0.0


def fitter_recovery_success_rate(example: dspy.Example) -> float:
    is_kill_recovery = bool(getattr(example, "is_kill_recovery", False))
    if not is_kill_recovery:
        return 0.5
    return 1.0 if str(getattr(example, "outcome_label", "")) == "success" else 0.0


def tool_adherence_score(example: dspy.Example) -> float:
    activity = _parse_tool_activity(str(getattr(example, "tool_activity", "")))
    total_tool_calls = activity.get("tool_calls", 0)
    if total_tool_calls <= 0:
        return 1.0

    recognized_calls = (
        activity.get("read_calls", 0)
        + activity.get("edit_calls", 0)
        + activity.get("bash_calls", 0)
    )
    return _clamp(recognized_calls / total_tool_calls)


def weighted_quality_score(
    example: dspy.Example,
    weights: Mapping[str, float] | None = None,
) -> float:
    metric_fns: dict[str, Callable[[dspy.Example], float]] = {
        "punch_card_pass_rate": punch_card_pass_rate,
        "cost_efficiency": cost_efficiency,
        "task_completion_rate": task_completion_rate,
        "fitter_recovery_success_rate": fitter_recovery_success_rate,
        "tool_adherence_score": tool_adherence_score,
    }

    effective_weights: Mapping[str, float]
    if weights is None:
        effective_weights = dict.fromkeys(metric_fns, 0.2)
    else:
        effective_weights = weights

    total = 0.0
    for name, metric_fn in metric_fns.items():
        total += float(effective_weights.get(name, 0.0)) * metric_fn(example)
    return _clamp(total)


def calculate_all_metrics(example: dspy.Example) -> dict[str, float]:
    """Return all individual metrics and the weighted composite metric."""
    return {
        "punch_card_pass_rate": punch_card_pass_rate(example),
        "cost_efficiency": cost_efficiency(example),
        "task_completion_rate": task_completion_rate(example),
        "fitter_recovery_success_rate": fitter_recovery_success_rate(example),
        "tool_adherence_score": tool_adherence_score(example),
        "weighted_quality_score": weighted_quality_score(example),
    }
