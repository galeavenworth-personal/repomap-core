"""Call record models for resolved call references."""

from __future__ import annotations

from pydantic import BaseModel, Field

from artifacts.models.artifacts.refs import RefEvidence, ResolvedTo, SourceSpan
from contract.artifacts import ARTIFACT_SCHEMA_VERSION


class CallRecord(BaseModel):
    """Schema for calls.jsonl records."""

    schema_version: int = Field(default=ARTIFACT_SCHEMA_VERSION)
    ref_id: str
    src_span: SourceSpan
    callee_expr: str
    module: str
    enclosing_symbol_id: str | None = None
    resolved_to: ResolvedTo | None = None
    resolved_base_to: ResolvedTo | None = None
    member: str | None = None
    evidence: RefEvidence


__all__ = ["CallRecord"]
