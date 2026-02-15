"""Module identity models for Python files.

This module contains models for representing canonical module identities
for Python source files.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


def _artifact_schema_version() -> int:
    from contract.artifacts import ARTIFACT_SCHEMA_VERSION

    return ARTIFACT_SCHEMA_VERSION


class ModuleRecord(BaseModel):
    """A canonical module identity for a Python source file."""

    schema_version: int = Field(default_factory=_artifact_schema_version)
    path: str
    module: str
    is_package: bool
    package_root: str


__all__ = ["ModuleRecord"]
