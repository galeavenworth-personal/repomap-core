"""Artifact query API for repomap-core.

This package provides a deterministic, typed query interface over repomap
artifacts. It normalizes heterogeneous artifact formats into uniform
in-memory collections and supports location mapping for falsifiability.

Primary entry points:
- :class:`query.service.QueryService` — agent-friendly facade (recommended)
- :class:`query.artifact_store.ArtifactStore` — normalize artifacts into collections
- :class:`query.query_engine.QueryEngine` — execute typed filter queries
- :class:`query.query_engine.StructuredQuery` — typed filter AST for queries
"""

from query.artifact_store import ArtifactStore, ArtifactStoreProtocol
from query.query_engine import (
    AndFilter,
    CountAssertion,
    ExistsAssertion,
    FieldFilter,
    OrFilter,
    QueryEngine,
    QueryResult,
    StructuredQuery,
    validate_query,
)
from query.service import QueryService

__all__ = [
    "AndFilter",
    "ArtifactStore",
    "ArtifactStoreProtocol",
    "CountAssertion",
    "ExistsAssertion",
    "FieldFilter",
    "OrFilter",
    "QueryEngine",
    "QueryResult",
    "QueryService",
    "StructuredQuery",
    "validate_query",
]
