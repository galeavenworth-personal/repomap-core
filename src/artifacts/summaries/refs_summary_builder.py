"""Builder for refs_summary.json aggregate statistics."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from artifacts.models.artifacts.refs_summary import (
    RefKindCounts,
    RefsSummary,
    ResolutionCounts,
)

# Resolution values that indicate external/stdlib targets.
_EXTERNAL_RESOLUTIONS = frozenset({"external", "stdlib"})


def _is_resolved(record: dict[str, Any]) -> bool:
    """Return True if the record has a non-None resolved_to."""
    return record.get("resolved_to") is not None


def _is_external(resolved_to: dict[str, Any]) -> bool:
    """Return True if the resolution indicates an external/stdlib target."""
    resolution = resolved_to.get("resolution", "")
    return resolution in _EXTERNAL_RESOLUTIONS


class _Tally:
    """Accumulator for resolution statistics."""

    __slots__ = (
        "resolved",
        "unresolved",
        "internal",
        "external",
        "confidence_sum",
        "confidence_count",
    )

    def __init__(self) -> None:
        self.resolved = 0
        self.unresolved = 0
        self.internal = 0
        self.external = 0
        self.confidence_sum = 0.0
        self.confidence_count = 0

    def count(self, record: dict[str, Any]) -> None:
        """Tally a single record (ref or call)."""
        if not _is_resolved(record):
            self.unresolved += 1
            return
        self.resolved += 1
        resolved_to = record["resolved_to"]
        if _is_external(resolved_to):
            self.external += 1
        else:
            self.internal += 1
        confidence = resolved_to.get("confidence")
        if confidence is not None:
            self.confidence_sum += confidence
            self.confidence_count += 1

    @property
    def avg_confidence(self) -> float:
        return (
            self.confidence_sum / self.confidence_count
            if self.confidence_count > 0
            else 0.0
        )


def build_refs_summary(
    ref_dicts: list[dict[str, Any]],
    call_dicts: list[dict[str, Any]],
) -> RefsSummary:
    """Compute aggregate cross-reference and call resolution statistics.

    Args:
        ref_dicts: List of ref record dicts (from refs.jsonl).
        call_dicts: List of call record dicts (from calls.jsonl).

    Returns:
        A RefsSummary model instance with computed statistics.
    """
    # --- Refs ---
    ref_tally = _Tally()
    by_kind: dict[str, dict[str, int]] = defaultdict(
        lambda: {"total": 0, "resolved": 0, "unresolved": 0}
    )

    for ref in ref_dicts:
        ref_kind = ref.get("ref_kind", "unknown")
        by_kind[ref_kind]["total"] += 1
        ref_tally.count(ref)
        by_kind[ref_kind]["resolved" if _is_resolved(ref) else "unresolved"] += 1

    # --- Calls ---
    call_tally = _Tally()
    for call in call_dicts:
        call_tally.count(call)

    # --- Derived metrics ---
    total_refs = len(ref_dicts)
    total_calls = len(call_dicts)
    resolution_rate_refs = ref_tally.resolved / total_refs if total_refs > 0 else 0.0
    resolution_rate_calls = (
        call_tally.resolved / total_calls if total_calls > 0 else 0.0
    )

    by_ref_kind = {
        kind: RefKindCounts(**counts) for kind, counts in sorted(by_kind.items())
    }

    return RefsSummary(
        total_refs=total_refs,
        total_calls=total_calls,
        refs_resolved=ref_tally.resolved,
        refs_unresolved=ref_tally.unresolved,
        calls_resolved=call_tally.resolved,
        calls_unresolved=call_tally.unresolved,
        resolution_rate_refs=resolution_rate_refs,
        resolution_rate_calls=resolution_rate_calls,
        by_ref_kind=by_ref_kind,
        resolution_counts=ResolutionCounts(
            internal=ref_tally.internal + call_tally.internal,
            external=ref_tally.external + call_tally.external,
            unresolved=ref_tally.unresolved + call_tally.unresolved,
        ),
        avg_confidence_refs=ref_tally.avg_confidence,
        avg_confidence_calls=call_tally.avg_confidence,
    )


__all__ = ["build_refs_summary"]
