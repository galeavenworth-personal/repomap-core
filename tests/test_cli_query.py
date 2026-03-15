"""Tests for the CLI 'query' subcommand."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cli import main
from conftest import build_minimal_artifacts


def _write_query_file(tmp_path: Path, query: object) -> Path:
    """Write a query dict to a temporary JSON file and return its path."""
    query_file = tmp_path / "query.json"
    query_file.write_text(json.dumps(query), encoding="utf-8")
    return query_file


_SYMBOLS_FUNCTION_QUERY: dict[str, object] = {
    "collection": "symbols",
    "filter": {"type": "field", "field": "kind", "op": "eq", "value": "function"},
    "assertion": {"type": "exists"},
}


def _run_query(
    tmp_path: Path,
    artifacts_dir: Path,
    query: object,
    capsys: pytest.CaptureFixture[str],
) -> tuple[int, dict[str, object]]:
    """Write query, run CLI, parse JSON output."""
    query_file = _write_query_file(tmp_path, query)
    exit_code = main(
        [
            "query",
            "--artifacts-dir",
            str(artifacts_dir),
            "--query-file",
            str(query_file),
        ]
    )
    output = json.loads(capsys.readouterr().out)
    return exit_code, output


class TestCliQueryHappyPath:
    def test_query_returns_matches_for_valid_query(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        exit_code, output = _run_query(
            tmp_path, artifacts_dir, _SYMBOLS_FUNCTION_QUERY, capsys
        )

        assert exit_code == 0
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
        no_match_query = {
            "collection": "symbols",
            "filter": {
                "type": "field",
                "field": "kind",
                "op": "eq",
                "value": "nonexistent_kind",
            },
            "assertion": {"type": "exists"},
        }
        exit_code, output = _run_query(tmp_path, artifacts_dir, no_match_query, capsys)

        assert exit_code == 0
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
        build_minimal_artifacts(tmp_path / ".repomap")
        monkeypatch.chdir(tmp_path)

        query_file = _write_query_file(tmp_path, _SYMBOLS_FUNCTION_QUERY)
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
        exit_code, output = _run_query(
            tmp_path,
            artifacts_dir,
            {"collection": "symbols"},
            capsys,
        )

        assert exit_code == 1
        assert output["query_valid"] is False
        assert "Invalid query structure" in output["error"]

    def test_query_missing_artifacts_dir_returns_valid_empty(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        """Missing artifacts dir should return valid but empty results (not crash)."""
        missing_dir = tmp_path / "nonexistent_artifacts"
        exit_code, output = _run_query(
            tmp_path, missing_dir, _SYMBOLS_FUNCTION_QUERY, capsys
        )

        assert exit_code == 0
        assert output["query_valid"] is True
        assert output["matches"] == []


class TestCliQueryOutputFormat:
    def test_output_has_all_required_fields(
        self,
        tmp_path: Path,
        artifacts_dir: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        _, output = _run_query(tmp_path, artifacts_dir, _SYMBOLS_FUNCTION_QUERY, capsys)

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
        _, output = _run_query(tmp_path, artifacts_dir, _SYMBOLS_FUNCTION_QUERY, capsys)

        assert isinstance(output, dict)
