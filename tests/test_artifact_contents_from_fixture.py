from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from artifacts.write import generate_all_artifacts
from contract.artifacts import (
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    SYMBOLS_JSONL,
)
from contract.validation import validate_artifacts


def read_jsonl(path: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        records.append(json.loads(line))
    return records


def read_edgelist(path: Path) -> list[tuple[str, str]]:
    edges: list[tuple[str, str]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        source, target = line.split("->", 1)
        edges.append((source.strip(), target.strip()))
    return edges


def _to_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        return int(value)
    return 0


def test_artifact_contents_generated_from_committed_fixture(tmp_path: Path) -> None:
    fixture_root = Path("tests/fixtures/mini_repo")
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)

    out_dir = tmp_path / "artifacts"
    generate_all_artifacts(root=repo_root, out_dir=out_dir)

    validation = validate_artifacts(out_dir)
    assert validation.ok, [m.to_dict() for m in validation.errors]

    symbols = read_jsonl(out_dir / SYMBOLS_JSONL)
    assert any(r.get("kind") == "class" and r.get("name") == "Greeter" for r in symbols)
    assert any(r.get("kind") == "method" and r.get("name") == "greet" for r in symbols)
    assert any(
        r.get("kind") == "function" and r.get("name") == "compute_value"
        for r in symbols
    )
    symbol_sort_keys = [
        (
            str(r.get("path", "")),
            _to_int(r.get("start_line", 0)),
            _to_int(r.get("start_col", 0)),
        )
        for r in symbols
    ]
    assert symbol_sort_keys == sorted(symbol_sort_keys)

    edges = read_edgelist(out_dir / DEPS_EDGELIST)
    assert ("pkg_a.use_core", "pkg_a.core") in edges
    assert ("pkg_a.integrations", "requests") in edges
    assert edges == sorted(set(edges))

    deps_summary = json.loads((out_dir / DEPS_SUMMARY_JSON).read_text(encoding="utf-8"))
    for key in ("node_count", "edge_count", "fan_in", "fan_out", "top_modules"):
        assert key in deps_summary
    assert deps_summary["edge_count"] == len(edges)

    integrations = read_jsonl(out_dir / INTEGRATIONS_STATIC_JSONL)
    assert any(
        r.get("tag") == "http" and "requests" in str(r.get("evidence", ""))
        for r in integrations
    )
    integration_sort_keys = [
        (
            str(r.get("path", "")),
            _to_int(r.get("line", 0)),
            str(r.get("tag", "")),
            str(r.get("evidence", "")),
        )
        for r in integrations
    ]
    assert integration_sort_keys == sorted(integration_sort_keys)
