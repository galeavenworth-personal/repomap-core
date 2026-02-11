"""Integration models for external touchpoints.

This module contains models for representing integration points with external systems.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# Schema version constant
SCHEMA_VERSION = 2

IntegrationTag = Literal[
    "database",
    "http",
    "logging",
    "testing",
    "cli",
    "serialization",
    "async",
    "file_io",
]


class IntegrationRecord(BaseModel):
    """An integration point detected in a Python source file."""

    schema_version: int = Field(default=SCHEMA_VERSION)
    path: str
    tag: IntegrationTag
    evidence: str
    line: int | None = None
    symbol: str | None = None


__all__ = ["SCHEMA_VERSION", "IntegrationRecord", "IntegrationTag"]
