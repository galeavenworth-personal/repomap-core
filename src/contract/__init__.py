"""Stable core↔claims contract surface for repomap-core.

This module exposes the minimal, stable Python surface that repomap-claims
depends on. Treat these exports as the authoritative core↔claims boundary.
"""

from contract.artifacts import (
    ARTIFACT_SCHEMA_VERSION,
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    MODULES_JSONL,
    SYMBOLS_JSONL,
    TIER1_ARTIFACT_SPECS,
    Tier1ArtifactSpec,
)


def __getattr__(name: str) -> object:
    if name in {"DepsSummary", "IntegrationRecord", "ModuleRecord", "SymbolRecord"}:
        from contract.models import (
            DepsSummary,
            IntegrationRecord,
            ModuleRecord,
            SymbolRecord,
        )

        return {
            "DepsSummary": DepsSummary,
            "IntegrationRecord": IntegrationRecord,
            "ModuleRecord": ModuleRecord,
            "SymbolRecord": SymbolRecord,
        }[name]

    if name in {"ValidationMessage", "ValidationResult", "validate_artifacts"}:
        from contract.validation import (
            ValidationMessage,
            ValidationResult,
            validate_artifacts,
        )

        return {
            "ValidationMessage": ValidationMessage,
            "ValidationResult": ValidationResult,
            "validate_artifacts": validate_artifacts,
        }[name]

    msg = f"module 'contract' has no attribute {name!r}"
    raise AttributeError(msg)


__all__ = [
    "ARTIFACT_SCHEMA_VERSION",
    "DEPS_EDGELIST",
    "DEPS_SUMMARY_JSON",
    "INTEGRATIONS_STATIC_JSONL",
    "MODULES_JSONL",
    "SYMBOLS_JSONL",
    "TIER1_ARTIFACT_SPECS",
    "DepsSummary",
    "IntegrationRecord",
    "ModuleRecord",
    "SymbolRecord",
    "Tier1ArtifactSpec",
    "ValidationMessage",
    "ValidationResult",
    "validate_artifacts",
]
