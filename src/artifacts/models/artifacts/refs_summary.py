"""Reference summary models for aggregate cross-reference statistics.

This module contains models for the refs_summary.json artifact, which provides
agent-friendly aggregate statistics about cross-references and call resolution.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from contract.artifacts import ARTIFACT_SCHEMA_VERSION


class ResolutionCounts(BaseModel):
    """Counts for internal vs external resolution outcomes."""

    internal: int = 0
    external: int = 0
    unresolved: int = 0


class RefKindCounts(BaseModel):
    """Counts broken down by reference kind."""

    total: int = 0
    resolved: int = 0
    unresolved: int = 0


class RefsSummary(BaseModel):
    """Summary of cross-reference and call resolution statistics.

    Emitted as refs_summary.json — an agent-friendly summary for quick
    gating and inspection of reference resolution quality.
    """

    schema_version: int = Field(default=ARTIFACT_SCHEMA_VERSION)
    total_refs: int
    total_calls: int
    refs_resolved: int
    refs_unresolved: int
    calls_resolved: int
    calls_unresolved: int
    resolution_rate_refs: float = Field(
        description="Fraction of refs resolved (0.0–1.0)."
    )
    resolution_rate_calls: float = Field(
        description="Fraction of calls resolved (0.0–1.0)."
    )
    by_ref_kind: dict[str, RefKindCounts] = Field(default_factory=dict)
    resolution_counts: ResolutionCounts = Field(default_factory=ResolutionCounts)
    avg_confidence_refs: float = Field(
        default=0.0,
        description="Average confidence score across resolved refs.",
    )
    avg_confidence_calls: float = Field(
        default=0.0,
        description="Average confidence score across resolved calls.",
    )


__all__ = ["RefKindCounts", "RefsSummary", "ResolutionCounts"]
