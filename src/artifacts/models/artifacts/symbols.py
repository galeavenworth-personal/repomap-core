"""Symbol models for code artifacts.

This module contains models for representing code symbols (modules, classes,
functions, methods).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# Schema version constant
SCHEMA_VERSION = 3

SymbolKind = Literal["module", "class", "function", "method"]


class SymbolRecord(BaseModel):
    """A symbol extracted from a Python source file."""

    schema_version: int = Field(default=SCHEMA_VERSION)
    path: str
    kind: SymbolKind
    name: str
    qualified_name: str
    symbol_id: str
    symbol_key: str
    start_line: int
    start_col: int
    end_line: int
    end_col: int
    docstring_present: bool
    layer: str | None = Field(
        default=None, description="Architectural layer (if configured)"
    )


__all__ = ["SCHEMA_VERSION", "SymbolKind", "SymbolRecord"]
