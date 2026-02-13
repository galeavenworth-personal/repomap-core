from __future__ import annotations

import json
from pathlib import Path

import pytest

from artifacts.generators.deps import DepsGenerator
from artifacts.generators.symbols import SymbolsGenerator
from contract.artifacts import DEPS_EDGELIST, SYMBOLS_JSONL
from utils import path_to_module


def test_path_to_module_canonical_src_package_rules() -> None:
    assert path_to_module("src/repomap_core/__init__.py") == "repomap_core"
    assert path_to_module("src/repomap_core/cli.py") == "repomap_core.cli"
    assert path_to_module("src/repomap_core/scan/files.py") == "repomap_core.scan.files"


def test_path_to_module_fallback_rules_are_deterministic() -> None:
    assert path_to_module("pkg/module.py") == "pkg.module"
    assert path_to_module("pkg/__init__.py") == "pkg"
    assert path_to_module(Path("nested/feature/tool.py")) == "nested.feature.tool"


def test_path_to_module_rejects_empty_module_names() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        path_to_module("__init__.py")

    with pytest.raises(ValueError, match="non-empty"):
        path_to_module("src/__init__.py")


def test_deps_and_symbols_use_same_canonical_module_id(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    module_dir = repo_root / "src" / "repomap_core"
    module_dir.mkdir(parents=True)
    (module_dir / "__init__.py").write_text("", encoding="utf-8")
    (module_dir / "cli.py").write_text(
        "import math\n\n\ndef run() -> float:\n    return math.pi\n",
        encoding="utf-8",
    )

    out_dir = tmp_path / "artifacts"

    SymbolsGenerator().generate(root=repo_root, out_dir=out_dir)
    DepsGenerator().generate(root=repo_root, out_dir=out_dir)

    expected_module = "repomap_core.cli"
    expected_edge = f"{expected_module} -> math"

    edgelist_lines = (out_dir / DEPS_EDGELIST).read_text(encoding="utf-8").splitlines()
    assert expected_edge in edgelist_lines

    symbol_records = [
        json.loads(line)
        for line in (out_dir / SYMBOLS_JSONL).read_text(encoding="utf-8").splitlines()
    ]
    module_record = next(
        record
        for record in symbol_records
        if record["path"] == "src/repomap_core/cli.py" and record["kind"] == "module"
    )
    assert module_record["qualified_name"] == expected_module
