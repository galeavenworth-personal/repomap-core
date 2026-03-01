"""Tier-1 artifact contract definitions.

This module defines the stable core↔claims boundary for Tier-1 artifacts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Artifact schema version for Tier-1 artifacts (artifact-v2).
ARTIFACT_SCHEMA_VERSION = 2

# Tier-1 artifact filename constants (stable contract identifiers).
SYMBOLS_JSONL = "symbols.jsonl"
MODULES_JSONL = "modules.jsonl"
DEPS_EDGELIST = "deps.edgelist"
DEPS_SUMMARY_JSON = "deps_summary.json"
INTEGRATIONS_STATIC_JSONL = "integrations_static.jsonl"
CALLS_RAW_JSONL = "calls_raw.jsonl"
REFS_JSONL = "refs.jsonl"
CALLS_JSONL = "calls.jsonl"


@dataclass(frozen=True)
class Tier1ArtifactSpec:
    """Specification for a Tier-1 contract artifact.

    This is the stable core↔claims boundary for filenames and formats.
    """

    filename: str
    format: str
    required_fields_note: str


# ---------------------------------------------------------------------------
# Deterministic ref_id + expr normalization
# ---------------------------------------------------------------------------
# Canonical ref_id format: ref:{path}@L{line}:C{col}:{ref_kind}:{expr}
# - path: POSIX relative path (forward slashes, no ./ prefix)
# - line/col: 1-based integers
# - ref_kind: lowercase identifier (e.g. "call", "name")
# - expr: normalized expression (see normalize_expr)

_WHITESPACE_RUN = re.compile(r"\s+")


def normalize_expr(raw_expr: str) -> str:
    """Normalize an expression string for embedding in a ref_id.

    Rules:
    - Strip leading/trailing whitespace.
    - Collapse internal whitespace runs to a single space.
    - Preserve dotted names (e.g. ``a.b.c``).
    - Dynamic placeholders (``<subscript>``, ``<call>``, etc.) pass through.
    - No file-system-dependent prefixes.
    """
    return _WHITESPACE_RUN.sub(" ", raw_expr.strip())


def build_ref_id(
    path: str,
    start_line: int,
    start_col: int,
    ref_kind: str,
    expr: str,
) -> str:
    """Build a deterministic ref_id following the contract format.

    Format: ``ref:{path}@L{line}:C{col}:{ref_kind}:{normalized_expr}``
    """
    return f"ref:{path}@L{start_line}:C{start_col}:{ref_kind}:{normalize_expr(expr)}"


TIER1_ARTIFACT_SPECS: dict[str, Tier1ArtifactSpec] = {
    "symbols": Tier1ArtifactSpec(
        filename=SYMBOLS_JSONL,
        format="jsonl",
        required_fields_note="SymbolRecord fields required by contract.",
    ),
    "modules": Tier1ArtifactSpec(
        filename=MODULES_JSONL,
        format="jsonl",
        required_fields_note="ModuleRecord fields required by contract.",
    ),
    "deps_edgelist": Tier1ArtifactSpec(
        filename=DEPS_EDGELIST,
        format="edgelist",
        required_fields_note="Dependency edge pairs (source, target).",
    ),
    "deps_summary": Tier1ArtifactSpec(
        filename=DEPS_SUMMARY_JSON,
        format="json",
        required_fields_note="DepsSummary fields required by contract.",
    ),
    "integrations": Tier1ArtifactSpec(
        filename=INTEGRATIONS_STATIC_JSONL,
        format="jsonl",
        required_fields_note="IntegrationRecord fields required by contract.",
    ),
    "calls_raw": Tier1ArtifactSpec(
        filename=CALLS_RAW_JSONL,
        format="jsonl",
        required_fields_note="CallRawRecord fields required by contract.",
    ),
    "refs": Tier1ArtifactSpec(
        filename=REFS_JSONL,
        format="jsonl",
        required_fields_note="RefRecord fields required by contract.",
    ),
    "calls": Tier1ArtifactSpec(
        filename=CALLS_JSONL,
        format="jsonl",
        required_fields_note="CallRecord fields required by contract.",
    ),
}
