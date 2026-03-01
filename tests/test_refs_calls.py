from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from artifacts.generators.calls import CallsGenerator
from artifacts.generators.calls_raw import CallsRawGenerator
from artifacts.generators.modules import ModulesGenerator
from artifacts.generators.refs import RefsGenerator
from artifacts.generators.symbols import SymbolsGenerator
from contract.artifacts import CALLS_JSONL, CALLS_RAW_JSONL, REFS_JSONL, build_ref_id
from parse.ast_imports import extract_imports
from parse.name_resolution import (
    build_modules_index,
    build_name_table,
    build_symbols_index,
    resolve_call,
    resolve_call_class_context,
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


def test_build_name_table_trivial_alias_resolves_outside_repo_cwd(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "repo"
    file_path = _write_python_file(
        repo_root,
        "pkg/use_mod.py",
        "from pkg.mod import func\nalias = func\nalias()\n",
    )
    _write_python_file(repo_root, "pkg/mod.py", "def func():\n    return 1\n")

    modules_index = {
        "pkg/use_mod.py": "pkg.use_mod",
        "pkg/mod.py": "pkg.mod",
    }
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.func@L1:C1",
            "qualified_name": "pkg.mod.func",
            "name": "func",
            "kind": "function",
        }
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir(parents=True, exist_ok=True)
    original_cwd = Path.cwd()
    try:
        os.chdir(elsewhere)
        table = build_name_table(
            "pkg/use_mod.py",
            modules_index,
            symbols_index,
            extract_imports(file_path),
            repo_root=repo_root,
        )
    finally:
        os.chdir(original_cwd)

    resolved_to, resolved_base_to, member, strategy, confidence = resolve_call(
        "alias",
        table,
        modules_index,
    )

    assert resolved_to is not None
    assert resolved_to.qualified_name == "pkg.mod.func"
    assert resolved_base_to is None
    assert member is None
    assert strategy == "module_alias_assignment"
    assert confidence > 0


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


def test_resolve_call_dotted_import_without_asname(tmp_path: Path) -> None:
    file_path = _write_python_file(
        tmp_path,
        "pkg/use_mod.py",
        "import pkg.mod\n",
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
        "pkg.mod.func",
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


def test_refs_enclosing_symbol_id_is_canonical_symbol_id(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "class C:\n"
        "    def method(self):\n"
        "        return helper()\n\n"
        "def helper():\n"
        "    return 1\n",
    )

    out_dir = tmp_path / "artifacts"
    _run_resolution_pipeline(repo_root, out_dir)
    refs = _read_jsonl(out_dir / REFS_JSONL)

    helper_call = next(
        record
        for record in refs
        if _src_span_path(record) == "pkg/mod.py"
        and str(record.get("expr", "")) == "helper"
    )

    enclosing_symbol_id = helper_call.get("enclosing_symbol_id")
    assert isinstance(enclosing_symbol_id, str)
    assert enclosing_symbol_id.startswith("sym:")
    assert enclosing_symbol_id == "sym:pkg/mod.py::pkg.mod.C.method@L2:C5"


def test_ref_id_matches_build_ref_id_contract(tmp_path: Path) -> None:
    """ref_id values in refs.jsonl match what build_ref_id produces."""
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    refs = _read_jsonl(out_dir / REFS_JSONL)

    assert refs
    for record in refs:
        src_span = record["src_span"]
        assert isinstance(src_span, dict)
        expected_ref_id = build_ref_id(
            path=str(src_span["path"]),
            start_line=int(src_span["start_line"]),
            start_col=int(src_span["start_col"]),
            ref_kind=str(record["ref_kind"]),
            expr=str(record["expr"]),
        )
        assert record["ref_id"] == expected_ref_id


def test_calls_ref_id_matches_build_ref_id_contract(tmp_path: Path) -> None:
    """ref_id values in calls.jsonl match what build_ref_id produces."""
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    assert calls
    for record in calls:
        src_span = record["src_span"]
        assert isinstance(src_span, dict)
        expected_ref_id = build_ref_id(
            path=str(src_span["path"]),
            start_line=int(src_span["start_line"]),
            start_col=int(src_span["start_col"]),
            ref_kind="call",
            expr=str(record["callee_expr"]),
        )
        assert record["ref_id"] == expected_ref_id


def test_calls_raw_ref_id_matches_build_ref_id_contract(tmp_path: Path) -> None:
    """ref_id values in calls_raw.jsonl match what build_ref_id produces."""
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    calls_raw = _read_jsonl(out_dir / CALLS_RAW_JSONL)

    assert calls_raw
    for record in calls_raw:
        src_span = record["src_span"]
        assert isinstance(src_span, dict)
        expected_ref_id = build_ref_id(
            path=str(src_span["path"]),
            start_line=int(src_span["start_line"]),
            start_col=int(src_span["start_col"]),
            ref_kind="call",
            expr=str(record["callee_expr"]),
        )
        assert record["ref_id"] == expected_ref_id


def test_callee_expr_excludes_arguments(tmp_path: Path) -> None:
    """callee_expr in calls.jsonl does not include argument text."""
    repo_root = tmp_path / "repo"
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "def f():\n    result = some_func(arg1, arg2, key=val)\n",
    )

    out_dir = tmp_path / "artifacts"
    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    some_func_calls = [r for r in calls if str(r.get("callee_expr", "")) == "some_func"]
    assert some_func_calls
    for record in some_func_calls:
        callee_expr = str(record["callee_expr"])
        assert "arg1" not in callee_expr
        assert "arg2" not in callee_expr
        assert "key=" not in callee_expr


def test_expr_has_no_filesystem_prefix(tmp_path: Path) -> None:
    """expr and ref_id in refs.jsonl must not contain absolute filesystem paths."""
    fixture_root = Path(__file__).parent / "fixtures" / "mini_repo"
    repo_root = tmp_path / "repo"
    shutil.copytree(fixture_root, repo_root)
    out_dir = tmp_path / "artifacts"

    _run_resolution_pipeline(repo_root, out_dir)
    refs = _read_jsonl(out_dir / REFS_JSONL)

    assert refs
    for record in refs:
        expr = str(record.get("expr", ""))
        ref_id = str(record.get("ref_id", ""))
        # No absolute paths in expr
        assert not expr.startswith("/"), f"expr starts with /: {expr}"
        assert "C:\\" not in expr, f"expr contains Windows path: {expr}"
        # ref_id path component should be relative
        assert not ref_id.startswith("ref:/"), f"ref_id has absolute path: {ref_id}"


# ---------------------------------------------------------------------------
# Tier 2: class-context resolution tests
# ---------------------------------------------------------------------------


def _build_class_context_indexes(
    modules_index: dict[str, str],
    symbol_records: list[dict[str, object]],
) -> tuple[dict[str, list[Any]], dict[str, str]]:
    """Helper to build symbols_index and modules_index for class-context tests."""
    symbols_index = build_symbols_index(symbol_records, modules_index)
    return symbols_index, modules_index


def test_resolve_self_method(tmp_path: Path) -> None:
    """self.method() resolves to enclosing class method."""
    _write_python_file(
        tmp_path,
        "pkg/mod.py",
        "class Foo:\n"
        "    def bar(self):\n"
        "        return 1\n"
        "    def baz(self):\n"
        "        return self.bar()\n",
    )
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo@L1:C1",
            "qualified_name": "pkg.mod.Foo",
            "name": "Foo",
            "kind": "class",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo.bar@L2:C5",
            "qualified_name": "pkg.mod.Foo.bar",
            "name": "bar",
            "kind": "method",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo.baz@L4:C5",
            "qualified_name": "pkg.mod.Foo.baz",
            "name": "baz",
            "kind": "method",
        },
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)

    # enclosing_symbol_id for baz method
    enclosing = "sym:pkg/mod.py::pkg.mod.Foo.baz@L4:C5"

    result = resolve_call_class_context(
        "self.bar",
        enclosing,
        {},  # name_table not needed for self resolution
        modules_index,
        symbols_index,
    )

    assert result is not None
    resolved_to, resolved_base_to, member, strategy, confidence = result
    assert resolved_to is not None
    assert resolved_to.qualified_name == "pkg.mod.Foo.bar"
    assert resolved_to.symbol_id == "sym:pkg/mod.py::pkg.mod.Foo.bar@L2:C5"
    assert resolved_to.resolution == "method"
    assert resolved_base_to is None
    assert member is None
    assert strategy == "class_self_method"
    assert confidence == 70


def test_resolve_self_method_partial(tmp_path: Path) -> None:
    """self.unknown_method() partially resolves to the class."""
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo@L1:C1",
            "qualified_name": "pkg.mod.Foo",
            "name": "Foo",
            "kind": "class",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo.baz@L4:C5",
            "qualified_name": "pkg.mod.Foo.baz",
            "name": "baz",
            "kind": "method",
        },
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)
    enclosing = "sym:pkg/mod.py::pkg.mod.Foo.baz@L4:C5"

    result = resolve_call_class_context(
        "self.unknown_method",
        enclosing,
        {},
        modules_index,
        symbols_index,
    )

    assert result is not None
    resolved_to, resolved_base_to, member, strategy, confidence = result
    assert resolved_to is None
    assert resolved_base_to is not None
    assert resolved_base_to.qualified_name == "pkg.mod.Foo"
    assert member == "unknown_method"
    assert strategy == "class_self_method"


def test_resolve_cls_method(tmp_path: Path) -> None:
    """cls.method() resolves to enclosing class method."""
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo@L1:C1",
            "qualified_name": "pkg.mod.Foo",
            "name": "Foo",
            "kind": "class",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo.create@L3:C5",
            "qualified_name": "pkg.mod.Foo.create",
            "name": "create",
            "kind": "method",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo.factory@L6:C5",
            "qualified_name": "pkg.mod.Foo.factory",
            "name": "factory",
            "kind": "method",
        },
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)
    enclosing = "sym:pkg/mod.py::pkg.mod.Foo.factory@L6:C5"

    result = resolve_call_class_context(
        "cls.create",
        enclosing,
        {},
        modules_index,
        symbols_index,
    )

    assert result is not None
    resolved_to, resolved_base_to, member, strategy, confidence = result
    assert resolved_to is not None
    assert resolved_to.qualified_name == "pkg.mod.Foo.create"
    assert resolved_to.resolution == "method"
    assert strategy == "class_cls_method"
    assert confidence == 70


def test_resolve_super_method(tmp_path: Path) -> None:
    """super().method() resolves to base class method with single base."""
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Base@L1:C1",
            "qualified_name": "pkg.mod.Base",
            "name": "Base",
            "kind": "class",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Base.run@L2:C5",
            "qualified_name": "pkg.mod.Base.run",
            "name": "run",
            "kind": "method",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Child@L5:C1",
            "qualified_name": "pkg.mod.Child",
            "name": "Child",
            "kind": "class",
            "base_classes": ["Base"],
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Child.run@L6:C5",
            "qualified_name": "pkg.mod.Child.run",
            "name": "run",
            "kind": "method",
        },
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)
    enclosing = "sym:pkg/mod.py::pkg.mod.Child.run@L6:C5"

    # Name table needs Base to resolve the base class name
    from parse.name_resolution import NameBinding

    name_table = {
        "Base": NameBinding(
            local_name="Base",
            target_symbol_id="sym:pkg/mod.py::pkg.mod.Base@L1:C1",
            qualified_name="pkg.mod.Base",
            resolution="class",
            confidence=90,
            strategy="module_local_def",
            target_path="pkg/mod.py",
            target_module="pkg.mod",
        ),
    }

    result = resolve_call_class_context(
        "super().run",
        enclosing,
        name_table,
        modules_index,
        symbols_index,
    )

    assert result is not None
    resolved_to, resolved_base_to, member, strategy, confidence = result
    assert resolved_to is not None
    assert resolved_to.qualified_name == "pkg.mod.Base.run"
    assert resolved_to.symbol_id == "sym:pkg/mod.py::pkg.mod.Base.run@L2:C5"
    assert resolved_to.resolution == "method"
    assert strategy == "class_super_method"
    assert confidence == 65


def test_resolve_super_method_multiple_bases_returns_none() -> None:
    """super().method() with multiple bases is not resolved (MRO-dependent)."""
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.A@L1:C1",
            "qualified_name": "pkg.mod.A",
            "name": "A",
            "kind": "class",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.B@L3:C1",
            "qualified_name": "pkg.mod.B",
            "name": "B",
            "kind": "class",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.C@L5:C1",
            "qualified_name": "pkg.mod.C",
            "name": "C",
            "kind": "class",
            "base_classes": ["A", "B"],
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.C.run@L6:C5",
            "qualified_name": "pkg.mod.C.run",
            "name": "run",
            "kind": "method",
        },
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)
    enclosing = "sym:pkg/mod.py::pkg.mod.C.run@L6:C5"

    result = resolve_call_class_context(
        "super().run",
        enclosing,
        {},
        modules_index,
        symbols_index,
    )

    assert result is None


def test_resolve_classname_method(tmp_path: Path) -> None:
    """ClassName.method() resolves when ClassName is in the name table as a class."""
    file_path = _write_python_file(
        tmp_path,
        "pkg/mod.py",
        "class Foo:\n    def bar(self):\n        return 1\n",
    )
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo@L1:C1",
            "qualified_name": "pkg.mod.Foo",
            "name": "Foo",
            "kind": "class",
        },
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo.bar@L2:C5",
            "qualified_name": "pkg.mod.Foo.bar",
            "name": "bar",
            "kind": "method",
        },
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)

    table = build_name_table(
        "pkg/mod.py",
        modules_index,
        symbols_index,
        extract_imports(file_path),
    )

    result = resolve_call_class_context(
        "Foo.bar",
        None,  # enclosing doesn't matter for ClassName.method()
        table,
        modules_index,
        symbols_index,
    )

    assert result is not None
    resolved_to, resolved_base_to, member, strategy, confidence = result
    assert resolved_to is not None
    assert resolved_to.qualified_name == "pkg.mod.Foo.bar"
    assert resolved_to.resolution == "method"
    assert strategy == "class_static_method"
    assert confidence == 75


def test_resolve_classname_method_partial(tmp_path: Path) -> None:
    """ClassName.unknown_method() partially resolves to the class."""
    file_path = _write_python_file(
        tmp_path,
        "pkg/mod.py",
        "class Foo:\n    def bar(self):\n        return 1\n",
    )
    modules_index = {"pkg/mod.py": "pkg.mod"}
    symbol_records: list[dict[str, object]] = [
        {
            "path": "pkg/mod.py",
            "symbol_id": "sym:pkg/mod.py::pkg.mod.Foo@L1:C1",
            "qualified_name": "pkg.mod.Foo",
            "name": "Foo",
            "kind": "class",
        },
    ]
    symbols_index = build_symbols_index(symbol_records, modules_index)

    table = build_name_table(
        "pkg/mod.py",
        modules_index,
        symbols_index,
        extract_imports(file_path),
    )

    result = resolve_call_class_context(
        "Foo.unknown",
        None,
        table,
        modules_index,
        symbols_index,
    )

    assert result is not None
    resolved_to, resolved_base_to, member, strategy, confidence = result
    assert resolved_to is None
    assert resolved_base_to is not None
    assert resolved_base_to.qualified_name == "pkg.mod.Foo"
    assert member == "unknown"
    assert strategy == "class_static_method"


def test_resolve_self_no_enclosing_class_returns_none() -> None:
    """self.method() outside a class returns None."""
    result = resolve_call_class_context(
        "self.bar",
        None,
        {},
        {},
        {},
    )
    assert result is None


def test_resolve_class_context_non_class_patterns_return_none() -> None:
    """Non-class-context patterns return None."""
    # Single identifier
    assert resolve_call_class_context("foo", None, {}, {}, {}) is None
    # Empty expression
    assert resolve_call_class_context("", None, {}, {}, {}) is None


def test_end_to_end_self_method_resolution(tmp_path: Path) -> None:
    """Full pipeline resolves self.method() in calls.jsonl."""
    repo_root = tmp_path / "repo"
    _write_python_file(
        repo_root,
        "pkg/__init__.py",
        "",
    )
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "class Foo:\n"
        "    def bar(self):\n"
        "        return 1\n"
        "    def baz(self):\n"
        "        return self.bar()\n",
    )

    out_dir = tmp_path / "artifacts"
    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    self_bar_calls = [r for r in calls if str(r.get("callee_expr", "")) == "self.bar"]
    assert self_bar_calls, (
        f"Expected self.bar call, got calls: {[r.get('callee_expr') for r in calls]}"
    )

    record = self_bar_calls[0]
    assert record.get("resolved_to") is not None
    resolved_to = record["resolved_to"]
    assert isinstance(resolved_to, dict)
    assert resolved_to["qualified_name"] == "pkg.mod.Foo.bar"
    assert resolved_to["resolution"] == "method"

    evidence = record.get("evidence")
    assert isinstance(evidence, dict)
    assert evidence["strategy"] == "class_self_method"
    assert evidence["confidence"] == 70


def test_end_to_end_super_method_resolution(tmp_path: Path) -> None:
    """Full pipeline resolves super().method() in calls.jsonl."""
    repo_root = tmp_path / "repo"
    _write_python_file(
        repo_root,
        "pkg/__init__.py",
        "",
    )
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "class Base:\n"
        "    def run(self):\n"
        "        return 1\n"
        "\n"
        "class Child(Base):\n"
        "    def run(self):\n"
        "        return super().run()\n",
    )

    out_dir = tmp_path / "artifacts"
    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    super_run_calls = [
        r for r in calls if str(r.get("callee_expr", "")) == "super().run"
    ]
    assert super_run_calls, (
        f"Expected super().run call, got calls: {[r.get('callee_expr') for r in calls]}"
    )

    record = super_run_calls[0]
    assert record.get("resolved_to") is not None
    resolved_to = record["resolved_to"]
    assert isinstance(resolved_to, dict)
    assert resolved_to["qualified_name"] == "pkg.mod.Base.run"
    assert resolved_to["resolution"] == "method"

    evidence = record.get("evidence")
    assert isinstance(evidence, dict)
    assert evidence["strategy"] == "class_super_method"
    assert evidence["confidence"] == 65


def test_end_to_end_classname_method_resolution(tmp_path: Path) -> None:
    """Full pipeline resolves ClassName.method() in calls.jsonl."""
    repo_root = tmp_path / "repo"
    _write_python_file(
        repo_root,
        "pkg/__init__.py",
        "",
    )
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "class Foo:\n"
        "    def bar(self):\n"
        "        return 1\n"
        "\n"
        "def use_foo():\n"
        "    return Foo.bar(None)\n",
    )

    out_dir = tmp_path / "artifacts"
    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    foo_bar_calls = [r for r in calls if str(r.get("callee_expr", "")) == "Foo.bar"]
    assert foo_bar_calls, (
        f"Expected Foo.bar call, got calls: {[r.get('callee_expr') for r in calls]}"
    )

    record = foo_bar_calls[0]
    assert record.get("resolved_to") is not None
    resolved_to = record["resolved_to"]
    assert isinstance(resolved_to, dict)
    assert resolved_to["qualified_name"] == "pkg.mod.Foo.bar"
    assert resolved_to["resolution"] == "method"

    evidence = record.get("evidence")
    assert isinstance(evidence, dict)
    assert evidence["strategy"] == "class_static_method"
    assert evidence["confidence"] == 75


def test_end_to_end_cls_method_resolution(tmp_path: Path) -> None:
    """Full pipeline resolves cls.method() in calls.jsonl."""
    repo_root = tmp_path / "repo"
    _write_python_file(
        repo_root,
        "pkg/__init__.py",
        "",
    )
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "class Foo:\n"
        "    @classmethod\n"
        "    def create(cls):\n"
        "        return cls()\n"
        "    @classmethod\n"
        "    def factory(cls):\n"
        "        return cls.create()\n",
    )

    out_dir = tmp_path / "artifacts"
    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    cls_create_calls = [
        r for r in calls if str(r.get("callee_expr", "")) == "cls.create"
    ]
    assert cls_create_calls, (
        f"Expected cls.create call, got calls: {[r.get('callee_expr') for r in calls]}"
    )

    record = cls_create_calls[0]
    assert record.get("resolved_to") is not None
    resolved_to = record["resolved_to"]
    assert isinstance(resolved_to, dict)
    assert resolved_to["qualified_name"] == "pkg.mod.Foo.create"
    assert resolved_to["resolution"] == "method"

    evidence = record.get("evidence")
    assert isinstance(evidence, dict)
    assert evidence["strategy"] == "class_cls_method"
    assert evidence["confidence"] == 70


def test_base_classes_extracted_in_symbols(tmp_path: Path) -> None:
    """Symbols artifact includes base_classes for class symbols."""
    repo_root = tmp_path / "repo"
    _write_python_file(
        repo_root,
        "pkg/__init__.py",
        "",
    )
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "class Base:\n    pass\n\nclass Child(Base):\n    pass\n",
    )

    out_dir = tmp_path / "artifacts"
    SymbolsGenerator().generate(root=repo_root, out_dir=out_dir)
    symbols = _read_jsonl(out_dir / "symbols.jsonl")

    class_symbols = [s for s in symbols if s.get("kind") == "class"]
    assert len(class_symbols) == 2

    base_sym = next(s for s in class_symbols if s.get("name") == "Base")
    child_sym = next(s for s in class_symbols if s.get("name") == "Child")

    # Base has no base classes
    assert base_sym.get("base_classes") is None

    # Child has Base as base class
    assert child_sym.get("base_classes") == ["Base"]


def test_determinism_with_class_context_resolution(tmp_path: Path) -> None:
    """Class-context resolution preserves byte determinism."""
    repo_root = tmp_path / "repo"
    _write_python_file(repo_root, "pkg/__init__.py", "")
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "class Foo:\n"
        "    def bar(self):\n"
        "        return 1\n"
        "    def baz(self):\n"
        "        return self.bar()\n",
    )

    out_dir_one = tmp_path / "out_one"
    out_dir_two = tmp_path / "out_two"
    _run_resolution_pipeline(repo_root, out_dir_one)
    _run_resolution_pipeline(repo_root, out_dir_two)

    assert (out_dir_one / REFS_JSONL).read_bytes() == (
        out_dir_two / REFS_JSONL
    ).read_bytes()
    assert (out_dir_one / CALLS_JSONL).read_bytes() == (
        out_dir_two / CALLS_JSONL
    ).read_bytes()


def test_imported_classname_method_resolution(tmp_path: Path) -> None:
    """ClassName.method() resolves when ClassName is imported from another module."""
    repo_root = tmp_path / "repo"
    _write_python_file(repo_root, "pkg/__init__.py", "")
    _write_python_file(
        repo_root,
        "pkg/base.py",
        "class Base:\n    def run(self):\n        return 1\n",
    )
    _write_python_file(
        repo_root,
        "pkg/use.py",
        "from pkg.base import Base\n\ndef call_run():\n    return Base.run(None)\n",
    )

    out_dir = tmp_path / "artifacts"
    _run_resolution_pipeline(repo_root, out_dir)
    calls = _read_jsonl(out_dir / CALLS_JSONL)

    base_run_calls = [
        r
        for r in calls
        if str(r.get("callee_expr", "")) == "Base.run"
        and _src_span_path(r) == "pkg/use.py"
    ]
    assert base_run_calls

    record = base_run_calls[0]
    assert record.get("resolved_to") is not None
    resolved_to = record["resolved_to"]
    assert isinstance(resolved_to, dict)
    assert resolved_to["qualified_name"] == "pkg.base.Base.run"
    assert resolved_to["resolution"] == "method"
    evidence = record.get("evidence")
    assert isinstance(evidence, dict)
    assert evidence["strategy"] == "class_static_method"
