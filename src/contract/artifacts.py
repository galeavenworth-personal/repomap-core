"""Tier-1 artifact contract definitions.

This module defines the stable core↔claims boundary for Tier-1 artifacts.
"""

from __future__ import annotations

from dataclasses import dataclass

# Artifact schema version for Tier-1 artifacts (artifact-v2).
ARTIFACT_SCHEMA_VERSION = 2

# Tier-1 artifact filename constants (stable contract identifiers).
SYMBOLS_JSONL = "symbols.jsonl"
MODULES_JSONL = "modules.jsonl"
DEPS_EDGELIST = "deps.edgelist"
DEPS_SUMMARY_JSON = "deps_summary.json"
INTEGRATIONS_STATIC_JSONL = "integrations_static.jsonl"


@dataclass(frozen=True)
class Tier1ArtifactSpec:
    """Specification for a Tier-1 contract artifact.

    This is the stable core↔claims boundary for filenames and formats.
    """

    filename: str
    format: str
    required_fields_note: str


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
}
