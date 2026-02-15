from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from artifacts.generators.calls import CallsGenerator
from artifacts.generators.calls_raw import CallsRawGenerator
from artifacts.generators.modules import ModulesGenerator
from artifacts.generators.refs import RefsGenerator
from artifacts.generators.symbols import SymbolsGenerator
from contract.artifacts import CALLS_JSONL, REFS_JSONL
from parse.ast_imports import extract_imports
from parse.name_resolution import (
    build_modules_index,
    build_name_table,
    build_symbols_index,
    resolve_call,
)


def _read_jsonl(path: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line:
            records.append(json.loads(line))
    return records


def _write_python_file(repo_root: Path, relative_path: str, source: str) -> Path:
    path = repo_root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    return path


def _run_resolution_pipeline(repo_root: Path, out_dir: Path) -> None:
    SymbolsGenerator().generate(root=repo_root, out_dir=out_dir)
    ModulesGenerator().generate(root=repo_root, out_dir=out_dir)
    CallsRawGenerator().generate(root=repo_root, out_dir=out_dir)
    RefsGenerator().generate(root=repo_root, out_dir=out_dir)
    CallsGenerator().generate(root=repo_root, out_dir=out_dir)


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


def _src_span_path(record: dict[str, object]) -> str:
    src_span = record.get("src_span")
    if not isinstance(src_span, dict):
        return ""
    value = src_span.get("path")
    return value if isinstance(value, str) else ""


def _resolved_qualified_name(record: dict[str, object]) -> str | None:
    resolved_to = record.get("resolved_to")
    if not isinstance(resolved_to, dict):
        return None
    qualified_name = resolved_to.get("qualified_name")
    return qualified_name if isinstance(qualified_name, str) else None


def test_build_modules_index() -> None:
    module_records = [
        {"path": "pkg_a/__init__.py", "module": "pkg_a"},
        {"path": "pkg_a/core.py", "module": "pkg_a.core"},
        {"path": "pkg_a/use_core.py", "module": "pkg_a.use_core"},
    ]

    modules_index = build_modules_index(module_records)

    assert modules_index == {
        "pkg_a/__init__.py": "pkg_a",
        "pkg_a/core.py": "pkg_a.core",
        "pkg_a/use_core.py": "pkg_a.use_core",
    }


def test_build_symbols_index() -> None:
    modules_index = {
        "pkg_a/core.py": "pkg_a.core",
        "pkg_a/use_core.py": "pkg_a.use_core",
    }
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg_a/core.py",
            "symbol_id": "sym:pkg_a/core.py::pkg_a.core.compute_value@L12:C0",
            "qualified_name": "pkg_a.core.compute_value",
            "name": "compute_value",
            "kind": "function",
        },
        {
            "path": "pkg_a/core.py",
            "symbol_id": "sym:pkg_a/core.py::pkg_a.core.Greeter@L4:C0",
            "qualified_name": "pkg_a.core.Greeter",
            "name": "Greeter",
            "kind": "class",
        },
        {
            "path": "outside.py",
            "symbol_id": "sym:outside.py::outside.fn@L1:C0",
            "qualified_name": "outside.fn",
            "name": "fn",
            "kind": "function",
        },
    ]

    symbols_index = build_symbols_index(symbol_records, modules_index)

    assert set(symbols_index.keys()) == {"pkg_a.core"}
    assert [symbol.name for symbol in symbols_index["pkg_a.core"]] == [
        "Greeter",
        "compute_value",
    ]


def test_build_name_table_local_defs(tmp_path: Path) -> None:
    file_path = _write_python_file(
        tmp_path, "pkg/mod.py", "def local_fn():\n    return 1\n"
    )
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbols_index = {
        "pkg.mod": [
            build_symbols_index(
                [
                    {
                        "path": "pkg/mod.py",
                        "symbol_id": "sym:pkg/mod.py::pkg.mod.local_fn@L1:C0",
                        "qualified_name": "pkg.mod.local_fn",
                        "name": "local_fn",
                        "kind": "function",
                    }
                ],
                modules_index,
            )["pkg.mod"][0]
        ]
    }

    table = build_name_table(
        file_path.relative_to(tmp_path).as_posix(),
        modules_index,
        symbols_index,
        extract_imports(file_path),
    )

    assert "local_fn" in table
    assert table["local_fn"].qualified_name == "pkg.mod.local_fn"
    assert table["local_fn"].strategy == "module_local_def"


def test_build_name_table_import_from(tmp_path: Path) -> None:
    file_path = _write_python_file(
        tmp_path,
        "pkg/use_mod.py",
        "from pkg.mod import func\n",
    )
    modules_index = {
        "pkg/use_mod.py": "pkg.use_mod",
        "pkg/mod.py": "pkg.mod",
    }
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.func@L1:C0",
            "qualified_name": "pkg.mod.func",
            "name": "func",
            "kind": "function",
        }
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)

    table = build_name_table(
        "pkg/use_mod.py",
        modules_index,
        symbols_index,
        extract_imports(file_path),
    )

    assert "func" in table
    assert table["func"].qualified_name == "pkg.mod.func"
    assert table["func"].strategy == "module_import_from"


def test_build_name_table_import_module(tmp_path: Path) -> None:
    file_path = _write_python_file(
        tmp_path,
        "pkg/use_mod.py",
        "import pkg.mod as mod\n",
    )
    modules_index = {
        "pkg/use_mod.py": "pkg.use_mod",
        "pkg/mod.py": "pkg.mod",
    }
    symbols_index = build_symbols_index([], modules_index)

    table = build_name_table(
        "pkg/use_mod.py",
        modules_index,
        symbols_index,
        extract_imports(file_path),
    )

    assert "mod" in table
    assert table["mod"].qualified_name == "pkg.mod"
    assert table["mod"].strategy == "module_import_module"


def test_resolve_call_local_def(tmp_path: Path) -> None:
    file_path = _write_python_file(tmp_path, "pkg/mod.py", "def foo():\n    return 1\n")
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.foo@L1:C0",
            "qualified_name": "pkg.mod.foo",
            "name": "foo",
            "kind": "function",
        }
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)
    table = build_name_table(
        "pkg/mod.py",
        modules_index,
        symbols_index,
        extract_imports(file_path),
    )

    resolved_to, resolved_base_to, member, strategy, confidence = resolve_call(
        "foo",
        table,
        modules_index,
    )

    assert resolved_to is not None
    assert resolved_to.qualified_name == "pkg.mod.foo"
    assert resolved_base_to is None
    assert member is None
    assert strategy == "module_local_def"
    assert confidence > 0


def test_resolve_call_import_from(tmp_path: Path) -> None:
    file_path = _write_python_file(
        tmp_path,
        "pkg/use_mod.py",
        "from pkg.mod import func\n",
    )
    modules_index = {
        "pkg/use_mod.py": "pkg.use_mod",
        "pkg/mod.py": "pkg.mod",
    }
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.func@L1:C0",
            "qualified_name": "pkg.mod.func",
            "name": "func",
            "kind": "function",
        }
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)
    table = build_name_table(
        "pkg/use_mod.py",
        modules_index,
        symbols_index,
        extract_imports(file_path),
    )

    resolved_to, resolved_base_to, member, strategy, confidence = resolve_call(
        "func",
        table,
        modules_index,
    )

    assert resolved_to is not None
    assert resolved_to.symbol_id == "sym:pkg/mod.py::pkg.mod.func@L1:C0"
    assert resolved_base_to is None
    assert member is None
    assert strategy == "module_import_from"
    assert confidence > 0


def test_resolve_call_unresolved() -> None:
    resolved_to, resolved_base_to, member, strategy, confidence = resolve_call(
        "does_not_exist",
        {},
        {},
    )

    assert resolved_to is None
    assert resolved_base_to is None
    assert member is None
    assert strategy == "dynamic_unresolvable"
    assert confidence == 0


def test_resolve_call_dotted(tmp_path: Path) -> None:
    file_path = _write_python_file(
        tmp_path,
        "pkg/use_mod.py",
        "import pkg.mod as mod\n",
    )
    modules_index = {
        "pkg/use_mod.py": "pkg.use_mod",
        "pkg/mod.py": "pkg.mod",
    }
    symbols_index = build_symbols_index([], modules_index)
    table = build_name_table(
        "pkg/use_mod.py",
        modules_index,
        symbols_index,
        extract_imports(file_path),
    )

    resolved_to, resolved_base_to, member, strategy, confidence = resolve_call(
        "mod.func",
        table,
        modules_index,
    )

    assert resolved_to is None
    assert resolved_base_to is not None
    assert resolved_base_to.qualified_name == "pkg.mod"
    assert member == "func"
    assert strategy == "module_import_module"
    assert confidence > 0


def test_refs_generator_is_byte_deterministic(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)

    out_dir_one = tmp_path / "out_one"
    out_dir_two = tmp_path / "out_two"
    _run_resolution_pipeline(repo_root, out_dir_one)
    _run_resolution_pipeline(repo_root, out_dir_two)

    assert (out_dir_one / REFS_JSONL).read_bytes() == (
        out_dir_two / REFS_JSONL
    ).read_bytes()


def test_calls_generator_is_byte_deterministic(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)

    out_dir_one = tmp_path / "out_one"
    out_dir_two = tmp_path / "out_two"
    _run_resolution_pipeline(repo_root, out_dir_one)
    _run_resolution_pipeline(repo_root, out_dir_two)

    assert (out_dir_one / CALLS_JSONL).read_bytes() == (
        out_dir_two / CALLS_JSONL
    ).read_bytes()


def test_refs_records_have_required_fields(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    refs = _read_jsonl(out_dir / REFS_JSONL)

    assert refs
    required_fields = {
        "schema_version",
        "ref_id",
        "ref_kind",
        "src_span",
        "module",
        "expr",
        "evidence",
    }
    for record in refs:
        assert required_fields.issubset(record.keys())


def test_calls_records_have_required_fields(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    assert calls
    required_fields = {
        "schema_version",
        "ref_id",
        "src_span",
        "callee_expr",
        "module",
        "evidence",
    }
    for record in calls:
        assert required_fields.issubset(record.keys())


def test_calls_is_subset_of_refs(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    refs = _read_jsonl(out_dir / REFS_JSONL)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    ref_ids = {str(record["ref_id"]) for record in refs}
    call_ids = {str(record["ref_id"]) for record in calls}
    assert call_ids.issubset(ref_ids)


def test_ref_id_format(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    refs = _read_jsonl(out_dir / REFS_JSONL)

    pattern = re.compile(r"ref:[^\n]+@L\d+:C\d+:[a-z_]+:.+")
    for record in refs:
        assert pattern.fullmatch(str(record["ref_id"]))


def test_mini_repo_resolves_internal_import(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    use_core_calls = [
        record for record in calls if _src_span_path(record) == "pkg_a/use_core.py"
    ]
    assert use_core_calls

    resolved_qualified = {
        qualified_name
        for record in use_core_calls
        if (qualified_name := _resolved_qualified_name(record)) is not None
    }
    assert "pkg_a.core.Greeter" in resolved_qualified
    assert "pkg_a.core.compute_value" in resolved_qualified


def test_mini_repo_external_calls_unresolved(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    _write_python_file(repo_root, "pkg_a/external_calls.py", "print('hello')\n")
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    print_calls = [
        record
        for record in calls
        if str(record.get("callee_expr", "")) == "print"
        and _src_span_path(record) == "pkg_a/external_calls.py"
    ]
    assert print_calls
    assert all(record.get("resolved_to") is None for record in print_calls)


def test_calls_records_sort_key_is_stable(tmp_path: Path) -> None:
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    sort_keys: list[tuple[str, int, int, str]] = []
    for record in calls:
        src_span = record.get("src_span")
        assert isinstance(src_span, dict)
        sort_keys.append(
            (
                str(src_span.get("path", "")),
                _to_int(src_span.get("start_line", 0)),
                _to_int(src_span.get("start_col", 0)),
                str(record.get("callee_expr", "")),
            )
        )
    assert sort_keys == sorted(sort_keys)
