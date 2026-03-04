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
    total_refs = len(ref_dicts)
    refs_resolved = 0
    refs_unresolved = 0
    internal_count = 0
    external_count = 0
    ref_confidence_sum = 0.0
    ref_confidence_count = 0

    by_kind: dict[str, dict[str, int]] = defaultdict(
        lambda: {"total": 0, "resolved": 0, "unresolved": 0}
    )

    for ref in ref_dicts:
        ref_kind = ref.get("ref_kind", "unknown")
        by_kind[ref_kind]["total"] += 1

        if _is_resolved(ref):
            refs_resolved += 1
            by_kind[ref_kind]["resolved"] += 1

            resolved_to = ref["resolved_to"]
            if _is_external(resolved_to):
                external_count += 1
            else:
                internal_count += 1

            confidence = resolved_to.get("confidence")
            if confidence is not None:
                ref_confidence_sum += confidence
                ref_confidence_count += 1
        else:
            refs_unresolved += 1
            by_kind[ref_kind]["unresolved"] += 1

    # --- Calls ---
    total_calls = len(call_dicts)
    calls_resolved = 0
    calls_unresolved = 0
    call_confidence_sum = 0.0
    call_confidence_count = 0

    for call in call_dicts:
        if _is_resolved(call):
            calls_resolved += 1

            resolved_to = call["resolved_to"]
            if _is_external(resolved_to):
                external_count += 1
            else:
                internal_count += 1

            confidence = resolved_to.get("confidence")
            if confidence is not None:
                call_confidence_sum += confidence
                call_confidence_count += 1
        else:
            calls_unresolved += 1

    # --- Derived metrics ---
    unresolved_count = refs_unresolved + calls_unresolved

    resolution_rate_refs = refs_resolved / total_refs if total_refs > 0 else 0.0
    resolution_rate_calls = calls_resolved / total_calls if total_calls > 0 else 0.0

    avg_confidence_refs = (
        ref_confidence_sum / ref_confidence_count if ref_confidence_count > 0 else 0.0
    )
    avg_confidence_calls = (
        call_confidence_sum / call_confidence_count
        if call_confidence_count > 0
        else 0.0
    )

    # Build sorted by_ref_kind dict for determinism.
    by_ref_kind = {
        kind: RefKindCounts(**counts) for kind, counts in sorted(by_kind.items())
    }

    return RefsSummary(
        total_refs=total_refs,
        total_calls=total_calls,
        refs_resolved=refs_resolved,
        refs_unresolved=refs_unresolved,
        calls_resolved=calls_resolved,
        calls_unresolved=calls_unresolved,
        resolution_rate_refs=resolution_rate_refs,
        resolution_rate_calls=resolution_rate_calls,
        by_ref_kind=by_ref_kind,
        resolution_counts=ResolutionCounts(
            internal=internal_count,
            external=external_count,
            unresolved=unresolved_count,
        ),
        avg_confidence_refs=avg_confidence_refs,
        avg_confidence_calls=avg_confidence_calls,
    )


__all__ = ["build_refs_summary"]
