"""Stable core↔claims contract surface for repomap-core.

This module exposes the minimal, stable Python surface that repomap-claims
depends on. Treat these exports as the authoritative core↔claims boundary.
"""

from contract.artifacts import (
    ARTIFACT_SCHEMA_VERSION,
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    SYMBOLS_JSONL,
    TIER1_ARTIFACT_SPECS,
    Tier1ArtifactSpec,
)
from contract.models import DepsSummary, IntegrationRecord, SymbolRecord
from contract.validation import (
    ValidationMessage,
    ValidationResult,
    validate_artifacts,
)

__all__ = [
    "ARTIFACT_SCHEMA_VERSION",
    "DEPS_EDGELIST",
    "DEPS_SUMMARY_JSON",
    "INTEGRATIONS_STATIC_JSONL",
    "SYMBOLS_JSONL",
    "TIER1_ARTIFACT_SPECS",
    "DepsSummary",
    "IntegrationRecord",
    "SymbolRecord",
    "Tier1ArtifactSpec",
    "ValidationMessage",
    "ValidationResult",
    "validate_artifacts",
]
