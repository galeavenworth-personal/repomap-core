"""Shared test fixtures for query-related tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from contract.artifacts import (
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    SYMBOLS_JSONL,
)

SYMBOL_FUNCTION = {
    "kind": "function",
    "name": "build_map",
    "path": "src/pkg/map.py",
    "start_line": 10,
    "end_line": 22,
    "start_col": 0,
    "qualified_name": "pkg.map.build_map",
    "symbol_id": "sym:src/pkg/map.py::pkg.map.build_map@L10:C0",
    "symbol_key": "symkey:src/pkg/map.py::pkg.map.build_map::function",
}

SYMBOL_CLASS = {
    "kind": "class",
    "name": "RepoScanner",
    "path": "src/pkg/scanner.py",
    "start_line": 4,
    "end_line": 40,
    "start_col": 0,
    "qualified_name": "pkg.scanner.RepoScanner",
    "symbol_id": "sym:src/pkg/scanner.py::pkg.scanner.RepoScanner@L4:C0",
    "symbol_key": "symkey:src/pkg/scanner.py::pkg.scanner.RepoScanner::class",
}


def write_jsonl(path: Path, records: list[dict[str, object]]) -> None:
    """Write a list of dicts as newline-delimited JSON."""
    lines = [json.dumps(record, sort_keys=True) for record in records]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_minimal_artifacts(
    artifacts_dir: Path,
    *,
    extra_integration_records: list[dict[str, object]] | None = None,
    cycles: list[object] | None = None,
    layer_violations: list[object] | None = None,
) -> None:
    """Build a minimal set of .repomap artifacts for testing."""
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    write_jsonl(artifacts_dir / SYMBOLS_JSONL, [SYMBOL_FUNCTION, SYMBOL_CLASS])

    deps_lines = [
        "pkg.map -> pkg.scanner",
        "pkg.scanner -> pathlib",
        "pkg.scanner -> json",
    ]
    (artifacts_dir / DEPS_EDGELIST).write_text(
        "\n".join(deps_lines) + "\n", encoding="utf-8"
    )

    integration_records: list[dict[str, object]] = [
        {
            "path": "src/pkg/http_client.py",
            "line": 7,
            "tag": "http",
            "evidence": "requests.get(url)",
        },
    ]
    if extra_integration_records:
        integration_records.extend(extra_integration_records)
    write_jsonl(artifacts_dir / INTEGRATIONS_STATIC_JSONL, integration_records)

    deps_summary: dict[str, object] = {
        "fan_in": {"pkg.scanner": 2, "pkg.map": 1},
        "fan_out": {"pkg.scanner": 2, "pkg.map": 1},
        "cycles": cycles if cycles is not None else [],
        "layer_violations": layer_violations if layer_violations is not None else [],
        "node_count": 3,
        "edge_count": 3,
        "top_modules": ["pkg.scanner", "pkg.map"],
    }
    (artifacts_dir / DEPS_SUMMARY_JSON).write_text(
        json.dumps(deps_summary, sort_keys=True), encoding="utf-8"
    )


@pytest.fixture()
def artifacts_dir(tmp_path: Path) -> Path:
    """Standard artifacts directory with minimal fixture data."""
    path = tmp_path / ".repomap"
    build_minimal_artifacts(path)
    return path
