"""QueryService — thin facade combining ArtifactStore and QueryEngine.

Provides an agent-friendly API over the query subsystem.  Accepts either
a :class:`StructuredQuery` or a plain ``dict`` (auto-parsed via
``model_validate``) and returns a :class:`QueryResult`.

Convenience helpers :meth:`exists` and :meth:`count` build the appropriate
query internally so callers don't need to assemble filter ASTs by hand.
"""

from __future__ import annotations

import logging
from pathlib import Path  # noqa: TC003

from query.artifact_store import ArtifactStore
from query.query_engine import (
    QueryEngine,
    QueryResult,
    StructuredQuery,
    validate_query,
)

logger = logging.getLogger(__name__)


class QueryService:
    """Agent-friendly facade over ArtifactStore + QueryEngine.

    Usage::

        svc = QueryService(Path(".repomap"))
        result = svc.execute({"collection": "symbols", ...})
        has_it = svc.exists("symbols", {"field": "kind", "op": "eq", "value": "function"})
        n = svc.count("symbols", {"field": "kind", "op": "eq", "value": "class"})
    """

    def __init__(self, artifacts_dir: Path) -> None:
        self.store = ArtifactStore(artifacts_dir)
        self.engine = QueryEngine()

    # ------------------------------------------------------------------
    # Core execution
    # ------------------------------------------------------------------

    def execute(self, query: StructuredQuery | dict[str, object]) -> QueryResult:
        """Execute a structured query against the artifact store.

        *query* may be a :class:`StructuredQuery` instance **or** a plain
        ``dict`` that will be fed through ``StructuredQuery.model_validate``.

        Args:
            query: Structured query or dict representation.

        Returns:
            :class:`QueryResult` with matches, locations, and validity flag.
        """
        sq = self._coerce_query(query)

        is_valid, err = validate_query(sq)
        if not is_valid:
            return QueryResult(
                matches=[],
                matched_locations=[],
                query_valid=False,
                error=err,
            )

        return self.engine.execute(self.store, sq)

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    def exists(self, collection: str, filter_dict: dict[str, object]) -> bool:
        """Return ``True`` if at least one record matches *filter_dict*.

        Args:
            collection: Collection name (e.g. ``"symbols"``).
            filter_dict: Dict describing a single :class:`FieldFilter`.

        Returns:
            Whether any matching record exists.
        """
        result = self.execute(
            {
                "collection": collection,
                "filter": {**filter_dict, "type": "field"},
                "assertion": {"type": "exists"},
            }
        )
        return result.query_valid and len(result.matches) > 0

    def count(self, collection: str, filter_dict: dict[str, object]) -> int:
        """Return the number of records matching *filter_dict*.

        Args:
            collection: Collection name (e.g. ``"symbols"``).
            filter_dict: Dict describing a single :class:`FieldFilter`.

        Returns:
            Number of matching records, or ``0`` if the query is invalid.
        """
        result = self.execute(
            {
                "collection": collection,
                "filter": {**filter_dict, "type": "field"},
                "assertion": {"type": "count", "op": ">=", "value": 0},
            }
        )
        if not result.query_valid:
            return 0
        return len(result.matches)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _coerce_query(query: StructuredQuery | dict[str, object]) -> StructuredQuery:
        """Coerce a dict to :class:`StructuredQuery` if needed."""
        if isinstance(query, StructuredQuery):
            return query
        return StructuredQuery.model_validate(query)
