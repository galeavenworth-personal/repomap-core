from __future__ import annotations

import json
from pathlib import Path

import pytest

from artifacts.generators.calls_raw import CallsRawGenerator
from contract.artifacts import CALLS_RAW_JSONL
from parse.treesitter_calls import extract_calls_treesitter


def _write_python_file(repo_root: Path, relative_path: str, source: str) -> Path:
    path = repo_root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    return path


def _read_jsonl(path: Path) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line:
            out.append(json.loads(line))
    return out


@pytest.mark.parametrize(
    ("source", "expected_callee_expr"),
    [
        ("foo()\n", "foo"),
        ("a.b.c()\n", "a.b.c"),
        ("MyClass()\n", "MyClass"),
        ("obj.method()\n", "obj.method"),
    ],
)
def test_extract_calls_treesitter_normalizes_callee_expressions(
    tmp_path: Path,
    source: str,
    expected_callee_expr: str,
) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    file_path = _write_python_file(repo_root, "sample.py", source)

    records = extract_calls_treesitter(str(file_path), str(repo_root))

    assert len(records) == 1
    assert records[0]["callee_expr"] == expected_callee_expr


def test_extract_calls_treesitter_enclosing_scope_module_level(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    file_path = _write_python_file(repo_root, "sample.py", "foo()\n")

    records = extract_calls_treesitter(str(file_path), str(repo_root))

    assert len(records) == 1
    assert str(records[0]["enclosing_symbol_id"]).startswith("module:")
    assert records[0]["enclosing_symbol_id"] == "module:sample.py"


def test_extract_calls_treesitter_enclosing_scope_function(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    file_path = _write_python_file(
        repo_root,
        "sample.py",
        "def outer():\n    foo()\n",
    )

    records = extract_calls_treesitter(str(file_path), str(repo_root))

    assert len(records) == 1
    assert records[0]["enclosing_symbol_id"] == "symbol:sample.py:outer@L1:C0"


def test_extract_calls_treesitter_enclosing_scope_class_method(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    file_path = _write_python_file(
        repo_root,
        "sample.py",
        "class C:\n    def method(self):\n        foo()\n",
    )

    records = extract_calls_treesitter(str(file_path), str(repo_root))

    assert len(records) == 1
    assert records[0]["enclosing_symbol_id"] == "symbol:sample.py:method@L2:C4"


def test_extract_calls_treesitter_same_line_lambdas_have_distinct_enclosing_ids(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    file_path = _write_python_file(
        repo_root,
        "sample.py",
        "x = (lambda: foo(), lambda: bar())\n",
    )

    records = extract_calls_treesitter(str(file_path), str(repo_root))

    assert len(records) == 2
    ids = [str(record["enclosing_symbol_id"]) for record in records]
    assert ids[0] != ids[1]
    assert ids[0] == "symbol:sample.py:<lambda>@L1:C5"
    assert ids[1] == "symbol:sample.py:<lambda>@L1:C20"


def test_calls_raw_generator_is_byte_deterministic(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "def run():\n    foo()\n    obj.method()\n",
    )

    out_dir_one = tmp_path / "out_one"
    out_dir_two = tmp_path / "out_two"
    CallsRawGenerator().generate(root=repo_root, out_dir=out_dir_one)
    CallsRawGenerator().generate(root=repo_root, out_dir=out_dir_two)

    assert (out_dir_one / CALLS_RAW_JSONL).read_bytes() == (
        out_dir_two / CALLS_RAW_JSONL
    ).read_bytes()


def test_calls_raw_records_have_required_shape_and_evidence(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_python_file(
        repo_root,
        "pkg/mod.py",
        "def run():\n    foo()\n",
    )
    out_dir = tmp_path / "artifacts"

    CallsRawGenerator().generate(root=repo_root, out_dir=out_dir)
    records = _read_jsonl(out_dir / CALLS_RAW_JSONL)

    assert records
    required_keys = {
        "schema_version",
        "ref_id",
        "src_span",
        "callee_expr",
        "enclosing_symbol_id",
        "resolved_to",
        "evidence",
    }
    for record in records:
        assert required_keys.issubset(record.keys())
        assert record["resolved_to"] is None
        evidence = record["evidence"]
        assert isinstance(evidence, dict)
        assert evidence["strategy"] == "syntax_only"
