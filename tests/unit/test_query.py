from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from contract.artifacts import (
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    SYMBOLS_JSONL,
)
from query.artifact_store import ArtifactStore
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

_COMPLEXITY_JSONL = "complexity.jsonl"
_SECURITY_JSONL = "security.jsonl"

_EXPECTED_COLLECTIONS = [
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


def _write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    lines = [json.dumps(record, sort_keys=True) for record in records]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _build_minimal_artifacts(artifacts_dir: Path) -> None:
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    symbols_records = [
        {
            "kind": "function",
            "name": "build_map",
            "path": "src/pkg/map.py",
            "start_line": 10,
            "end_line": 22,
            "start_col": 0,
            "qualified_name": "pkg.map.build_map",
            "symbol_id": "sym:src/pkg/map.py::pkg.map.build_map@L10:C0",
            "symbol_key": "symkey:src/pkg/map.py::pkg.map.build_map::function",
        },
        {
            "kind": "class",
            "name": "RepoScanner",
            "path": "src/pkg/scanner.py",
            "start_line": 4,
            "end_line": 40,
            "start_col": 0,
            "qualified_name": "pkg.scanner.RepoScanner",
            "symbol_id": "sym:src/pkg/scanner.py::pkg.scanner.RepoScanner@L4:C0",
            "symbol_key": "symkey:src/pkg/scanner.py::pkg.scanner.RepoScanner::class",
        },
    ]
    _write_jsonl(artifacts_dir / SYMBOLS_JSONL, symbols_records)

    deps_lines = [
        "pkg.map -> pkg.scanner",
        "pkg.scanner -> pathlib",
        "pkg.scanner -> json",
    ]
    (artifacts_dir / DEPS_EDGELIST).write_text(
        "\n".join(deps_lines) + "\n",
        encoding="utf-8",
    )

    integration_records = [
        {
            "path": "src/pkg/http_client.py",
            "line": 7,
            "tag": "http",
            "evidence": "requests.get(url)",
        },
        {
            "path": "src/pkg/cache.py",
            "line": 3,
            "tag": "serialization",
            "evidence": "import json",
        },
    ]
    _write_jsonl(artifacts_dir / INTEGRATIONS_STATIC_JSONL, integration_records)

    deps_summary = {
        "fan_in": {"pkg.scanner": 2, "pkg.map": 1},
        "fan_out": {"pkg.scanner": 2, "pkg.map": 1},
        "cycles": [["pkg.a", "pkg.b"]],
        "layer_violations": [{"from_file": "src/pkg/a.py", "to_file": "src/pkg/b.py"}],
        "node_count": 5,
        "edge_count": 3,
        "top_modules": ["pkg.scanner", "pkg.map"],
    }
    (artifacts_dir / DEPS_SUMMARY_JSON).write_text(
        json.dumps(deps_summary, sort_keys=True),
        encoding="utf-8",
    )

    complexity_records = [
        {
            "path": "src/pkg/scanner.py",
            "line": 12,
            "metric": "cyclomatic_complexity",
            "value": 7,
        }
    ]
    _write_jsonl(artifacts_dir / _COMPLEXITY_JSONL, complexity_records)

    security_records = [
        {
            "path": "src/pkg/http_client.py",
            "line_number": 19,
            "severity": "medium",
            "rule": "insecure-transport",
        }
    ]
    _write_jsonl(artifacts_dir / _SECURITY_JSONL, security_records)


@pytest.fixture
def artifacts_dir(tmp_path: Path) -> Path:
    path = tmp_path / ".repomap"
    _build_minimal_artifacts(path)
    return path


@pytest.fixture
def empty_artifacts_dir(tmp_path: Path) -> Path:
    path = tmp_path / ".repomap"
    path.mkdir(parents=True, exist_ok=True)
    return path


@pytest.fixture
def artifact_store(artifacts_dir: Path) -> ArtifactStore:
    return ArtifactStore(artifacts_dir)


class TestQueryImports:
    def test_query_symbols_importable(self) -> None:
        imported: tuple[Any, ...] = (
            FieldFilter,
            AndFilter,
            OrFilter,
            ExistsAssertion,
            CountAssertion,
            StructuredQuery,
            QueryResult,
            QueryEngine,
            validate_query,
            QueryService,
        )
        assert all(symbol is not None for symbol in imported)


class TestArtifactStore:
    def test_empty_artifacts_directory_does_not_crash(
        self, empty_artifacts_dir: Path
    ) -> None:
        store = ArtifactStore(empty_artifacts_dir)

        assert store.list_collections() == _EXPECTED_COLLECTIONS
        assert all(store.get_collection(name) == [] for name in _EXPECTED_COLLECTIONS)

    def test_list_collections_returns_expected_names(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        assert artifact_store.list_collections() == _EXPECTED_COLLECTIONS

    def test_get_collection_symbols_returns_records(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        symbols = artifact_store.get_collection("symbols")

        assert len(symbols) == 2
        assert symbols[0]["name"] == "build_map"
        assert symbols[1]["kind"] == "class"

    def test_get_collection_unknown_raises_key_error(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        with pytest.raises(KeyError):
            artifact_store.get_collection("unknown")

    def test_get_record_location_symbol_uses_span(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        symbol = artifact_store.get_collection("symbols")[0]

        location = artifact_store.get_record_location("symbols", symbol)

        assert location == "src/pkg/map.py:10-22"

    def test_get_record_location_deps_edge_uses_embedded_location(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        edge = artifact_store.get_collection("deps_edges")[0]

        location = artifact_store.get_record_location("deps_edges", edge)

        assert location == edge["_location"]

    def test_get_record_location_fan_in_uses_module_locator(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        fan_in_record = artifact_store.get_collection("fan_in")[0]

        location = artifact_store.get_record_location("fan_in", fan_in_record)

        assert location == f"{DEPS_SUMMARY_JSON}:fan_in[{fan_in_record['module']}]"

    def test_get_record_location_cycle_uses_cycle_id(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        cycle_record = artifact_store.get_collection("cycles")[0]

        location = artifact_store.get_record_location("cycles", cycle_record)

        assert location == f"{DEPS_SUMMARY_JSON}:cycles[{cycle_record['cycle_id']}]"

    def test_get_record_location_unlocatable_raises_value_error(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        with pytest.raises(ValueError):
            artifact_store.get_record_location("symbols", {"name": "missing-location"})

    def test_artifacts_hash_is_16_char_hex(self, artifact_store: ArtifactStore) -> None:
        assert re.fullmatch(r"[0-9a-f]{16}", artifact_store.artifacts_hash) is not None

    def test_artifacts_hash_is_stable_on_repeated_access(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        first = artifact_store.artifacts_hash
        second = artifact_store.artifacts_hash

        assert first == second

    def test_artifacts_hash_changes_when_artifacts_change(
        self, artifacts_dir: Path
    ) -> None:
        before_store = ArtifactStore(artifacts_dir)
        before_hash = before_store.artifacts_hash

        symbols_path = artifacts_dir / SYMBOLS_JSONL
        with symbols_path.open("a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "kind": "function",
                        "name": "new_symbol",
                        "path": "src/pkg/new.py",
                        "start_line": 1,
                        "end_line": 1,
                        "start_col": 0,
                        "qualified_name": "pkg.new.new_symbol",
                        "symbol_id": "sym:src/pkg/new.py::pkg.new.new_symbol@L1:C0",
                        "symbol_key": "symkey:src/pkg/new.py::pkg.new.new_symbol::function",
                    },
                    sort_keys=True,
                )
                + "\n"
            )

        after_store = ArtifactStore(artifacts_dir)
        after_hash = after_store.artifacts_hash

        assert before_hash != after_hash


class TestQueryEngine:
    def test_field_filter_eq_matches_function_symbol(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="symbols",
            filter=FieldFilter(type="field", field="kind", op="eq", value="function"),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["name"] == "build_map"

    def test_field_filter_ne_matches_non_function_symbol(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="symbols",
            filter=FieldFilter(type="field", field="kind", op="ne", value="function"),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["name"] == "RepoScanner"

    def test_field_filter_gt_matches_fan_in_above_threshold(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="fan_in",
            filter=FieldFilter(type="field", field="value", op="gt", value=1),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["module"] == "pkg.scanner"

    def test_field_filter_gte_matches_fan_in_at_threshold(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="fan_in",
            filter=FieldFilter(type="field", field="value", op="gte", value=2),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["module"] == "pkg.scanner"

    def test_field_filter_lt_matches_fan_in_below_threshold(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="fan_in",
            filter=FieldFilter(type="field", field="value", op="lt", value=2),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["module"] == "pkg.map"

    def test_field_filter_lte_matches_fan_in_at_or_below_threshold(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="fan_in",
            filter=FieldFilter(type="field", field="value", op="lte", value=1),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["module"] == "pkg.map"

    def test_field_filter_in_matches_function_symbol(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="symbols",
            filter=FieldFilter(
                type="field",
                field="kind",
                op="in",
                value=["function", "method"],
            ),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["name"] == "build_map"

    def test_field_filter_contains_matches_deps_edge_sources(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="deps_edges",
            filter=FieldFilter(
                type="field",
                field="source",
                op="contains",
                value="scanner",
            ),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 2
        assert all("scanner" in str(match["source"]) for match in result.matches)

    def test_dot_notation_filter_matches_nested_field(self, tmp_path: Path) -> None:
        artifacts_dir = tmp_path / ".repomap"
        _build_minimal_artifacts(artifacts_dir)

        complexity_path = artifacts_dir / _COMPLEXITY_JSONL
        with complexity_path.open("a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "path": "src/pkg/nested.py",
                        "line": 21,
                        "metric": "cyclomatic_complexity",
                        "value": 3,
                        "metadata": {"tags": ["web"]},
                    },
                    sort_keys=True,
                )
                + "\n"
            )

        query = StructuredQuery(
            collection="complexity",
            filter=FieldFilter(
                type="field",
                field="metadata.tags",
                op="eq",
                value=["web"],
            ),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(ArtifactStore(artifacts_dir), query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["path"] == "src/pkg/nested.py"

    def test_and_filter_matches_symbol_with_both_constraints(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="symbols",
            filter=AndFilter(
                type="and",
                filters=[
                    FieldFilter(type="field", field="kind", op="eq", value="function"),
                    FieldFilter(type="field", field="name", op="eq", value="build_map"),
                ],
            ),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["qualified_name"] == "pkg.map.build_map"

    def test_or_filter_matches_function_or_class_symbols(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="symbols",
            filter=OrFilter(
                type="or",
                filters=[
                    FieldFilter(type="field", field="kind", op="eq", value="function"),
                    FieldFilter(type="field", field="kind", op="eq", value="class"),
                ],
            ),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert result.query_valid
        assert len(result.matches) == 2
        assert {match["name"] for match in result.matches} == {
            "build_map",
            "RepoScanner",
        }

    def test_unknown_collection_returns_query_invalid(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery.model_construct(
            collection="unknown",
            filter=FieldFilter(type="field", field="kind", op="eq", value="function"),
            assertion=ExistsAssertion(type="exists"),
        )

        result = QueryEngine().execute(artifact_store, query)

        assert not result.query_valid
        assert result.matches == []
        assert result.matched_locations == []
        assert result.error is not None


class TestValidateQuery:
    def test_validate_query_returns_true_for_valid_query(self) -> None:
        query = StructuredQuery(
            collection="symbols",
            filter=FieldFilter(type="field", field="kind", op="eq", value="function"),
            assertion=ExistsAssertion(type="exists"),
        )

        is_valid, error = validate_query(query)

        assert is_valid is True
        assert error is None

    def test_validate_query_rejects_negative_count_threshold(self) -> None:
        query = StructuredQuery(
            collection="symbols",
            filter=FieldFilter(type="field", field="kind", op="eq", value="function"),
            assertion=CountAssertion(type="count", op=">=", value=-1),
        )

        is_valid, error = validate_query(query)

        assert is_valid is False
        assert error == "Count threshold must be non-negative"


class TestQueryDeterminism:
    def test_repeated_execution_returns_identical_results(
        self,
        artifact_store: ArtifactStore,
    ) -> None:
        query = StructuredQuery(
            collection="symbols",
            filter=FieldFilter(type="field", field="kind", op="eq", value="function"),
            assertion=ExistsAssertion(type="exists"),
        )

        engine = QueryEngine()
        results = [engine.execute(artifact_store, query) for _ in range(3)]

        assert results[0].matches == results[1].matches == results[2].matches
        assert (
            results[0].matched_locations
            == results[1].matched_locations
            == results[2].matched_locations
        )
        assert (
            results[0].query_valid == results[1].query_valid == results[2].query_valid
        )


class TestQueryService:
    def test_execute_with_dict_input_matches_function_symbol(
        self,
        artifacts_dir: Path,
    ) -> None:
        svc = QueryService(artifacts_dir)

        result = svc.execute(
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "exists"},
            }
        )

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["name"] == "build_map"

    def test_execute_with_structured_query_input_matches_function_symbol(
        self,
        artifacts_dir: Path,
    ) -> None:
        svc = QueryService(artifacts_dir)
        query = StructuredQuery(
            collection="symbols",
            filter=FieldFilter(type="field", field="kind", op="eq", value="function"),
            assertion=ExistsAssertion(type="exists"),
        )

        result = svc.execute(query)

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["qualified_name"] == "pkg.map.build_map"

    def test_exists_positive_case(self, artifacts_dir: Path) -> None:
        svc = QueryService(artifacts_dir)

        assert (
            svc.exists(
                "symbols",
                {"field": "kind", "op": "eq", "value": "function"},
            )
            is True
        )

    def test_exists_negative_case(self, artifacts_dir: Path) -> None:
        svc = QueryService(artifacts_dir)

        assert (
            svc.exists(
                "symbols",
                {"field": "kind", "op": "eq", "value": "nonexistent"},
            )
            is False
        )

    def test_count_positive_case(self, artifacts_dir: Path) -> None:
        svc = QueryService(artifacts_dir)

        assert (
            svc.count(
                "symbols",
                {"field": "kind", "op": "eq", "value": "function"},
            )
            == 1
        )

    def test_count_returns_zero_for_no_matches(self, artifacts_dir: Path) -> None:
        svc = QueryService(artifacts_dir)

        assert (
            svc.count(
                "symbols",
                {"field": "kind", "op": "eq", "value": "nonexistent"},
            )
            == 0
        )

    def test_invalid_dict_query_returns_query_invalid(
        self, artifacts_dir: Path
    ) -> None:
        svc = QueryService(artifacts_dir)

        result = svc.execute(
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "count", "op": ">=", "value": -1},
            }
        )

        assert not result.query_valid
        assert result.matches == []
        assert result.matched_locations == []
        assert result.error == "Count threshold must be non-negative"


class TestRoundTrip:
    def test_full_round_trip_query_service_with_receipts(
        self,
        artifacts_dir: Path,
    ) -> None:
        svc = QueryService(artifacts_dir)

        result = svc.execute(
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "exists"},
            }
        )

        assert result.query_valid
        assert len(result.matches) == 1
        assert result.matches[0]["name"] == "build_map"
        assert result.matched_locations == ["src/pkg/map.py:10-22"]

    def test_round_trip_with_deps_edges_receipts(self, artifacts_dir: Path) -> None:
        svc = QueryService(artifacts_dir)

        result = svc.execute(
            {
                "collection": "deps_edges",
                "filter": {
                    "type": "field",
                    "field": "source",
                    "op": "contains",
                    "value": "scanner",
                },
                "assertion": {"type": "exists"},
            }
        )

        assert result.query_valid
        assert len(result.matches) == 2
        assert all("_location" in match for match in result.matches)
        assert result.matched_locations == [
            str(match["_location"]) for match in result.matches
        ]


class TestQueryServiceDeterminism:
    def test_repeated_execute_returns_identical_results(
        self,
        artifacts_dir: Path,
    ) -> None:
        svc = QueryService(artifacts_dir)
        query_dict = {
            "collection": "symbols",
            "filter": {
                "type": "field",
                "field": "kind",
                "op": "eq",
                "value": "function",
            },
            "assertion": {"type": "exists"},
        }

        results = [svc.execute(query_dict) for _ in range(3)]

        assert results[0].matches == results[1].matches == results[2].matches
        assert (
            results[0].matched_locations
            == results[1].matched_locations
            == results[2].matched_locations
        )
        assert (
            results[0].query_valid == results[1].query_valid == results[2].query_valid
        )
        assert results[0].error == results[1].error == results[2].error


class TestMissingArtifactsDirectory:
    def test_artifact_store_with_missing_directory_returns_empty_collections(
        self,
        tmp_path: Path,
    ) -> None:
        missing_dir = tmp_path / "nonexistent"
        store = ArtifactStore(missing_dir)

        assert store.list_collections() == _EXPECTED_COLLECTIONS
        assert all(store.get_collection(name) == [] for name in _EXPECTED_COLLECTIONS)

    def test_query_service_with_missing_directory_returns_valid_empty_result(
        self,
        tmp_path: Path,
    ) -> None:
        missing_dir = tmp_path / "nonexistent"
        svc = QueryService(missing_dir)

        result = svc.execute(
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "exists"},
            }
        )

        assert result.query_valid
        assert result.matches == []
        assert result.matched_locations == []
        assert result.error is None
