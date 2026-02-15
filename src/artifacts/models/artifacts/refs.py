"""Reference models for resolved and unresolved identifier uses."""

from __future__ import annotations

from pydantic import BaseModel, Field

from contract.artifacts import ARTIFACT_SCHEMA_VERSION


class SourceSpan(BaseModel):
    """Source span for a reference expression."""

    path: str
    start_line: int
    start_col: int
    end_line: int
    end_col: int


class ResolvedTo(BaseModel):
    """Resolution payload for a reference target."""

    symbol_id: str
    qualified_name: str
    resolution: str
    confidence: int
    path: str | None
    dst_module: str | None


class RefEvidence(BaseModel):
    """Evidence metadata for reference extraction and resolution."""

    strategy: str
    confidence: int
    notes: str | None = None


class RefRecord(BaseModel):
    """Schema for refs.jsonl records."""

    schema_version: int = Field(default=ARTIFACT_SCHEMA_VERSION)
    ref_id: str
    ref_kind: str
    src_span: SourceSpan
    module: str
    enclosing_symbol_id: str | None
    expr: str
    resolved_to: ResolvedTo | None
    evidence: RefEvidence
    resolved_base_to: ResolvedTo | None = None
    member: str | None = None


__all__ = ["RefRecord", "RefEvidence", "ResolvedTo", "SourceSpan"]
