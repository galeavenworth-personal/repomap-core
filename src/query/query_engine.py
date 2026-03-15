"""Query Engine - Execute typed filter queries against collections.

This module provides the QueryEngine class which executes structured queries with
typed filter AST evaluation against in-memory collections from the ArtifactStore.

Key responsibilities:
- Execute typed-filter queries against collections
- Evaluate filter AST (FieldFilter, AndFilter, OrFilter)
- Support 8 field operators (eq, ne, gt, gte, lt, lte, in, contains)
- Handle dot notation for nested field access
- Return matches with location mapping for falsifiability

Key invariant: Query engine is stateless and deterministic. Same query + store
always produces same result.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel

if TYPE_CHECKING:
    from query.artifact_store import ArtifactStore

logger = logging.getLogger(__name__)

# Scalar types for filter values
Scalar = str | int | float | bool


class FieldFilter(BaseModel):
    """Field-level filter with operator.

    Discriminated union type for OpenAI strict mode compatibility.
    """

    type: Literal["field"]
    field: str
    op: Literal["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"]
    value: Scalar | list[Scalar]


class AndFilter(BaseModel):
    """Boolean AND composition of filters.

    Discriminated union type for OpenAI strict mode compatibility.
    """

    type: Literal["and"]
    filters: list[Filter]


class OrFilter(BaseModel):
    """Boolean OR composition of filters.

    Discriminated union type for OpenAI strict mode compatibility.
    """

    type: Literal["or"]
    filters: list[Filter]


# Discriminated union for filter types
Filter = FieldFilter | AndFilter | OrFilter

# Update forward references for recursive types
AndFilter.model_rebuild()
OrFilter.model_rebuild()


class ExistsAssertion(BaseModel):
    """Check if any records match the filter.

    Discriminated union type for OpenAI strict mode compatibility.
    """

    type: Literal["exists"]


class CountAssertion(BaseModel):
    """Check if match count satisfies threshold.

    Discriminated union type for OpenAI strict mode compatibility.
    """

    type: Literal["count"]
    op: Literal[">=", "<=", "==", ">", "<"]
    value: int


# Discriminated union for assertion types
Assertion = ExistsAssertion | CountAssertion


class StructuredQuery(BaseModel):
    """Verification query with typed filter and assertion.

    Combines collection name, filter AST, and assertion into a complete
    query that can be executed against an ArtifactStore.
    """

    collection: Literal[
        "symbols",
        "deps_edges",
        "integrations",
        "fan_in",
        "fan_out",
        "layer_violations",
        "cycles",
        "complexity",
        "security",
    ]
    filter: Filter
    assertion: Assertion


@dataclass
class QueryResult:
    """Result of executing a structured query.

    Attributes:
        matches: List of matching records
        matched_locations: Location strings for each match (for falsifiability)
        query_valid: Whether the query executed successfully (indicates query
            execution success, not assertion evaluation — see QueryEngine.execute())
        error: Error message if query_valid is False
    """

    matches: list[dict[str, object]]
    matched_locations: list[str]
    # Indicates query execution success, not assertion evaluation.
    query_valid: bool
    error: str | None = None


class QueryEngine:
    """Typed filter AST evaluator for structured queries.

    Executes structured queries against ArtifactStore collections using
    recursive filter evaluation. Stateless and deterministic.

    Supported operators:
    - Field: eq, ne, gt, gte, lt, lte, in, contains
    - Boolean: and, or (structural composition)
    """

    def execute(self, store: ArtifactStore, query: StructuredQuery) -> QueryResult:
        """Execute structured query against artifact store.

        Args:
            store: Artifact store providing collections
            query: Structured query to execute

        Returns:
            Query result with matches and locations
        """
        try:
            # Get collection
            collection = store.get_collection(query.collection)

            # Filter records using AST evaluation
            matches = [
                doc for doc in collection if self._match_filter(doc, query.filter)
            ]

            # Get locations for all matches
            locations = [
                store.get_record_location(query.collection, match) for match in matches
            ]

            return QueryResult(
                matches=matches,
                matched_locations=locations,
                query_valid=True,
            )
        except (KeyError, ValueError, TypeError) as e:
            # Expected errors: missing collection, invalid filter values
            return QueryResult(
                matches=[],
                matched_locations=[],
                query_valid=False,
                error=f"Query execution error: {e!s}",
            )
        except Exception:
            # Unexpected errors should be logged and re-raised for debugging
            logger.exception("Unexpected error in query execution")
            raise

    def _match_filter(self, doc: dict[str, object], filter_: Filter) -> bool:
        """Evaluate a typed filter AST against a document.

        Args:
            doc: Document to match against
            filter_: Filter AST (FieldFilter, AndFilter, or OrFilter)

        Returns:
            True if document matches filter
        """
        if filter_.type == "field":
            return self._match_field(doc, filter_.field, filter_.op, filter_.value)
        if filter_.type == "and":
            return all(self._match_filter(doc, f) for f in filter_.filters)
        # filter_.type == "or"
        return any(self._match_filter(doc, f) for f in filter_.filters)

    def _compare_numeric(self, value: Any, expected: Any, op: str) -> bool:
        """Compare numeric values with operator.

        Args:
            value: Actual value
            expected: Expected value
            op: Comparison operator (gt, gte, lt, lte)

        Returns:
            True if comparison succeeds
        """
        if value is None:
            return False
        try:
            if op == "gt":
                return bool(value > expected)
            if op == "gte":
                return bool(value >= expected)
            if op == "lt":
                return bool(value < expected)
            if op == "lte":
                return bool(value <= expected)
        except TypeError:
            return False
        else:
            return False

    def _match_field(
        self,
        doc: dict[str, object],
        field: str,
        op: str,
        expected: Scalar | list[Scalar],
    ) -> bool:
        """Match a single FieldFilter against a document.

        Supports 8 operators:
        - eq, ne: Equality/inequality
        - gt, gte, lt, lte: Numeric comparisons
        - in: Set membership
        - contains: Substring match (strings only)

        Args:
            doc: Document to evaluate
            field: Field name (supports dot notation)
            op: Operator name
            expected: Expected value or list of values

        Returns:
            True if field value matches operator condition
        """
        value = self._get_field_value(doc, field)

        if op == "eq":
            return bool(value == expected)
        if op == "ne":
            return bool(value != expected)
        if op in ("gt", "gte", "lt", "lte"):
            return self._compare_numeric(value, expected, op)
        if op == "in":
            if not isinstance(expected, list):
                return False
            try:
                return value in expected
            except TypeError:
                return False
        if op == "contains":
            return (
                isinstance(value, str)
                and isinstance(expected, str)
                and expected in value
            )
        return False

    def _get_field_value(self, doc: dict[str, object], field: str) -> Any:
        """Get field value, supporting dot notation for nested fields.

        Examples:
        - "kind" -> doc["kind"]
        - "metadata.tags" -> doc["metadata"]["tags"]

        Args:
            doc: Document
            field: Field name (may be dotted like "metadata.tags")

        Returns:
            Field value or None if not found
        """
        if "." not in field:
            return doc.get(field)

        # Handle nested fields
        parts = field.split(".")
        value: Any = doc
        for part in parts:
            if isinstance(value, dict):
                value = value.get(part)
            else:
                return None
        return value


def validate_query(query: StructuredQuery) -> tuple[bool, str | None]:
    """Validate query before execution.

    Performs runtime validation beyond Pydantic's schema validation:
    - Collection name validity (redundant with Pydantic Literal, but provides
      explicit error messages for debugging)
    - Assertion parameter constraints (e.g., non-negative count thresholds)
      that require runtime value checks

    While Pydantic validates structure and types, this function validates
    semantic constraints that depend on runtime values.

    Note: Filter structure is validated by Pydantic schema, so we don't
    need to validate filter AST here.

    Args:
        query: Query to validate

    Returns:
        Tuple of (is_valid, error_message)
    """
    # Valid collections (matches StructuredQuery.collection Literal)
    valid_collections = {
        "symbols",
        "deps_edges",
        "integrations",
        "fan_in",
        "fan_out",
        "layer_violations",
        "cycles",
        "complexity",
        "security",
    }

    if query.collection not in valid_collections:
        return False, f"Unknown collection: {query.collection}"

    # Validate assertion
    if query.assertion.type == "count":
        if query.assertion.value < 0:
            return False, "Count threshold must be non-negative"
        if query.assertion.op not in (">=", "<=", "==", ">", "<"):
            return False, f"Invalid comparison operator: {query.assertion.op}"

    return True, None
