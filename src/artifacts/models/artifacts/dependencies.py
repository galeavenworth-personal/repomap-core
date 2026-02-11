"""Dependency models for module relationships.

This module contains models for representing module dependencies and layer violations.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

# Schema version constant
SCHEMA_VERSION = 2


class LayerViolation(BaseModel):
    """A dependency that violates layer rules."""

    from_file: str
    to_module: str
    from_layer: str
    to_layer: str | None = None


class DepsSummary(BaseModel):
    """Summary of dependency graph metrics."""

    schema_version: int = Field(default=SCHEMA_VERSION)
    node_count: int
    edge_count: int
    cycles: list[list[str]] = Field(default_factory=list)
    fan_in: dict[str, int] = Field(default_factory=dict)
    fan_out: dict[str, int] = Field(default_factory=dict)
    top_modules: list[str] = Field(default_factory=list)
    layer_violations: list[LayerViolation] = Field(default_factory=list)


__all__ = ["SCHEMA_VERSION", "DepsSummary", "LayerViolation"]
