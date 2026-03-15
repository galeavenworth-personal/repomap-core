"""Tests for the CLI 'query' subcommand."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cli import main
from contract.artifacts import (
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    SYMBOLS_JSONL,
)


def _write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    lines = [json.dumps(record, sort_keys=True) for record in records]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _build_minimal_artifacts(artifacts_dir: Path) -> None:
    """Build a minimal set of artifacts for query testing."""
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
        "\n".join(deps_lines) + "\n", encoding="utf-8"
    )

    integration_records = [
        {
            "path": "src/pkg/http_client.py",
            "line": 7,
            "tag": "http",
            "evidence": "requests.get(url)",
        },
    ]
    _write_jsonl(artifacts_dir / INTEGRATIONS_STATIC_JSONL, integration_records)

    deps_summary = {
        "fan_in": {"pkg.scanner": 2, "pkg.map": 1},
        "fan_out": {"pkg.scanner": 2, "pkg.map": 1},
        "cycles": [],
        "layer_violations": [],
        "node_count": 3,
        "edge_count": 3,
        "top_modules": ["pkg.scanner", "pkg.map"],
    }
    (artifacts_dir / DEPS_SUMMARY_JSON).write_text(
        json.dumps(deps_summary, sort_keys=True), encoding="utf-8"
    )


@pytest.fixture()
def artifacts_dir(tmp_path: Path) -> Path:
    path = tmp_path / ".repomap"
    _build_minimal_artifacts(path)
    return path


def _write_query_file(tmp_path: Path, query: object) -> Path:
    """Write a query dict to a temporary JSON file and return its path."""
    query_file = tmp_path / "query.json"
    query_file.write_text(json.dumps(query), encoding="utf-8")
    return query_file


class TestCliQueryHappyPath:
    def test_query_returns_matches_for_valid_query(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        query_file = _write_query_file(
            tmp_path,
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "exists"},
            },
        )

        exit_code = main(
            [
                "query",
                "--artifacts-dir",
                str(artifacts_dir),
                "--query-file",
                str(query_file),
            ]
        )

        assert exit_code == 0
        output = json.loads(capsys.readouterr().out)
        assert output["query_valid"] is True
        assert output["error"] is None
        assert len(output["matches"]) == 1
        assert output["matches"][0]["name"] == "build_map"
        assert output["matched_locations"] == ["src/pkg/map.py:10-22"]

    def test_query_returns_empty_matches_for_no_match(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        query_file = _write_query_file(
            tmp_path,
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "nonexistent_kind",
                },
                "assertion": {"type": "exists"},
            },
        )

        exit_code = main(
            [
                "query",
                "--artifacts-dir",
                str(artifacts_dir),
                "--query-file",
                str(query_file),
            ]
        )

        assert exit_code == 0
        output = json.loads(capsys.readouterr().out)
        assert output["query_valid"] is True
        assert output["matches"] == []
        assert output["matched_locations"] == []

    def test_query_default_artifacts_dir_is_repomap(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """When --artifacts-dir is omitted, it defaults to .repomap."""
        _build_minimal_artifacts(tmp_path / ".repomap")
        monkeypatch.chdir(tmp_path)

        query_file = _write_query_file(
            tmp_path,
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "exists"},
            },
        )

        exit_code = main(["query", "--query-file", str(query_file)])

        assert exit_code == 0
        output = json.loads(capsys.readouterr().out)
        assert output["query_valid"] is True
        assert len(output["matches"]) == 1


class TestCliQueryErrorHandling:
    def test_query_missing_query_file_returns_error(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        missing_file = tmp_path / "nonexistent.json"

        exit_code = main(
            [
                "query",
                "--artifacts-dir",
                str(artifacts_dir),
                "--query-file",
                str(missing_file),
            ]
        )

        assert exit_code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["query_valid"] is False
        assert "not found" in output["error"]
        assert output["matches"] == []
        assert output["matched_locations"] == []

    def test_query_invalid_json_returns_error(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        query_file = tmp_path / "bad.json"
        query_file.write_text("{not valid json}", encoding="utf-8")

        exit_code = main(
            [
                "query",
                "--artifacts-dir",
                str(artifacts_dir),
                "--query-file",
                str(query_file),
            ]
        )

        assert exit_code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["query_valid"] is False
        assert "Invalid JSON" in output["error"]

    def test_query_non_object_json_returns_error(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        query_file = tmp_path / "array.json"
        query_file.write_text("[1, 2, 3]", encoding="utf-8")

        exit_code = main(
            [
                "query",
                "--artifacts-dir",
                str(artifacts_dir),
                "--query-file",
                str(query_file),
            ]
        )

        assert exit_code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["query_valid"] is False
        assert "JSON object" in output["error"]

    def test_query_invalid_structure_returns_error(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        query_file = _write_query_file(
            tmp_path,
            {"collection": "symbols"},  # missing filter and assertion
        )

        exit_code = main(
            [
                "query",
                "--artifacts-dir",
                str(artifacts_dir),
                "--query-file",
                str(query_file),
            ]
        )

        assert exit_code == 1
        output = json.loads(capsys.readouterr().out)
        assert output["query_valid"] is False
        assert "Invalid query structure" in output["error"]

    def test_query_missing_artifacts_dir_returns_valid_empty(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """Missing artifacts dir should return valid but empty results (not crash)."""
        query_file = _write_query_file(
            tmp_path,
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "exists"},
            },
        )
        missing_dir = tmp_path / "nonexistent_artifacts"

        exit_code = main(
            [
                "query",
                "--artifacts-dir",
                str(missing_dir),
                "--query-file",
                str(query_file),
            ]
        )

        assert exit_code == 0
        output = json.loads(capsys.readouterr().out)
        assert output["query_valid"] is True
        assert output["matches"] == []


class TestCliQueryOutputFormat:
    def test_output_has_all_required_fields(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        query_file = _write_query_file(
            tmp_path,
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "exists"},
            },
        )

        main(
            [
                "query",
                "--artifacts-dir",
                str(artifacts_dir),
                "--query-file",
                str(query_file),
            ]
        )

        output = json.loads(capsys.readouterr().out)
        assert "matches" in output
        assert "matched_locations" in output
        assert "query_valid" in output
        assert "error" in output

    def test_output_is_valid_json(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        query_file = _write_query_file(
            tmp_path,
            {
                "collection": "symbols",
                "filter": {
                    "type": "field",
                    "field": "kind",
                    "op": "eq",
                    "value": "function",
                },
                "assertion": {"type": "exists"},
            },
        )

        main(
            [
                "query",
                "--artifacts-dir",
                str(artifacts_dir),
                "--query-file",
                str(query_file),
            ]
        )

        raw_out = capsys.readouterr().out
        parsed = json.loads(raw_out)
        assert isinstance(parsed, dict)
