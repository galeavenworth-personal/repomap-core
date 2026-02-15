"""Call-site models for raw syntax-level call extraction."""

from __future__ import annotations

from pydantic import BaseModel, Field

from contract.artifacts import ARTIFACT_SCHEMA_VERSION


class SourceSpan(BaseModel):
    """Source span for a call expression."""

    path: str
    start_line: int
    start_col: int
    end_line: int
    end_col: int


class CallEvidence(BaseModel):
    """Evidence metadata for call extraction."""

    strategy: str


class CallRawRecord(BaseModel):
    """Schema for calls_raw.jsonl records."""

    schema_version: int = Field(default=ARTIFACT_SCHEMA_VERSION)
    ref_id: str
    src_span: SourceSpan
    callee_expr: str
    enclosing_symbol_id: str
    resolved_to: str | None = None
    evidence: CallEvidence


__all__ = ["CallRawRecord", "CallEvidence", "SourceSpan"]
