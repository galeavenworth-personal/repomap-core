from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from artifacts.write import generate_all_artifacts
from contract.artifacts import (
    CALLS_RAW_JSONL,
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    MODULES_JSONL,
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
        try:
            return int(value.strip())
        except (ValueError, AttributeError):
            return 0
    return 0


def test_artifact_contents_generated_from_committed_fixture(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)

    out_dir = tmp_path / "artifacts"
    generate_all_artifacts(root=repo_root, out_dir=out_dir)

    validation = validate_artifacts(out_dir)
    assert validation.errors == [], [m.to_dict() for m in validation.errors]

    symbols = read_jsonl(out_dir / SYMBOLS_JSONL)
    assert any(r.get("kind") == "class" and r.get("name") == "Greeter" for r in symbols)
    assert any(r.get("kind") == "method" and r.get("name") == "greet" for r in symbols)
    assert any(
        r.get("kind") == "function" and r.get("name") == "compute_value"
        for r in symbols
    )
    # Use delimiter-aware patterns to avoid backtracking-heavy wildcards.
    symbol_id_pattern = re.compile(r"sym:[^\n]*::[^@\n]+@L\d+:C\d+")
    symbol_key_pattern = re.compile(r"symkey:[^\n]*::[^:\n]+::[^:\n]+")
    symbol_ids: list[str] = []
    for symbol in symbols:
        assert "symbol_id" in symbol
        assert "symbol_key" in symbol

        path = str(symbol.get("path", ""))
        qualified_name = str(symbol.get("qualified_name", ""))
        kind = str(symbol.get("kind", ""))
        start_line = _to_int(symbol.get("start_line", 0))
        start_col = _to_int(symbol.get("start_col", 0))

        symbol_id = str(symbol["symbol_id"])
        symbol_key = str(symbol["symbol_key"])
        assert symbol_id_pattern.fullmatch(symbol_id)
        assert symbol_key_pattern.fullmatch(symbol_key)
        assert symbol_id == f"sym:{path}::{qualified_name}@L{start_line}:C{start_col}"
        assert symbol_key == f"symkey:{path}::{qualified_name}::{kind}"
        symbol_ids.append(symbol_id)

    assert len(symbol_ids) == len(set(symbol_ids))
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

    modules_path = out_dir / MODULES_JSONL
    assert modules_path.exists()
    modules = read_jsonl(modules_path)

    module_required_keys = {"path", "module", "is_package", "package_root"}
    for record in modules:
        assert module_required_keys.issubset(record.keys())

    module_paths = [str(r["path"]) for r in modules]
    assert module_paths == sorted(module_paths)
    assert len(module_paths) == len(set(module_paths))

    for record in modules:
        path = str(record["path"])
        is_package = bool(record["is_package"])
        assert is_package is path.endswith("__init__.py")

    expected_modules = {
        "pkg_a/__init__.py": ("pkg_a", True, "."),
        "pkg_a/core.py": ("pkg_a.core", False, "."),
        "pkg_a/integrations.py": ("pkg_a.integrations", False, "."),
        "pkg_a/use_core.py": ("pkg_a.use_core", False, "."),
    }
    observed_modules = {
        str(record["path"]): (
            str(record["module"]),
            bool(record["is_package"]),
            str(record["package_root"]),
        )
        for record in modules
    }
    assert observed_modules == expected_modules

    calls_raw = read_jsonl(out_dir / CALLS_RAW_JSONL)
    assert {str(r.get("callee_expr", "")) for r in calls_raw} == {
        "Greeter",
        "compute_value",
        "greeter.greet",
    }

    ref_id_pattern = re.compile(r"ref:[^\n]+@L\d+:C\d+:call:.+")
    for record in calls_raw:
        assert "schema_version" in record
        assert record.get("resolved_to") is None

        evidence = record.get("evidence")
        assert isinstance(evidence, dict)
        assert evidence.get("strategy") == "syntax_only"

        src_span = record.get("src_span")
        assert isinstance(src_span, dict)
        assert _to_int(src_span.get("start_line", 0)) >= 1
        assert _to_int(src_span.get("start_col", 0)) >= 1
        assert _to_int(src_span.get("end_line", 0)) >= 1
        assert _to_int(src_span.get("end_col", 0)) >= 1

        callee_expr = str(record.get("callee_expr", ""))
        ref_id = str(record.get("ref_id", ""))
        assert ref_id_pattern.fullmatch(ref_id)
        assert ref_id == (
            f"ref:{src_span['path']}"
            f"@L{src_span['start_line']}"
            f":C{src_span['start_col']}"
            f":call:{callee_expr}"
        )

    call_sort_keys: list[tuple[str, int, int, str, str, str]] = []
    for record in calls_raw:
        src_span = record.get("src_span")
        assert isinstance(src_span, dict)
        call_sort_keys.append(
            (
                str(src_span.get("path", "")),
                _to_int(src_span.get("start_line", 0)),
                _to_int(src_span.get("start_col", 0)),
                "call",
                str(record.get("enclosing_symbol_id", "")),
                str(record.get("callee_expr", "")),
            )
        )
    assert call_sort_keys == sorted(call_sort_keys)
