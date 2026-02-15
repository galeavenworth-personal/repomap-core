from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from artifacts.generators import deps as deps_module
from artifacts.generators import integrations as integrations_module
from artifacts.generators import modules as modules_module
from artifacts.generators import calls_raw as calls_raw_module
from artifacts.generators import refs as refs_module
from artifacts.generators import symbols as symbols_module
from artifacts.generators.calls import CallsGenerator
from artifacts.generators.calls_raw import CallsRawGenerator
from artifacts.generators.deps import DepsGenerator
from artifacts.generators.integrations import IntegrationsGenerator
from artifacts.generators.modules import ModulesGenerator
from artifacts.generators.refs import RefsGenerator
from artifacts.generators.symbols import SymbolsGenerator
from scan import files as scan_files


def _write_repo_fixture(repo_root: Path) -> None:
    repo_root.mkdir()
    (repo_root / "nested").mkdir()
    (repo_root / "pkg").mkdir()
    (repo_root / "pkg" / "keep.py").write_text("print('keep')\n", encoding="utf-8")
    (repo_root / "nested" / "skip.py").write_text("print('skip')\n", encoding="utf-8")
    (repo_root / "nested" / ".gitignore").write_text("skip.py\n", encoding="utf-8")


def _run_generators(
    repo_root: Path,
    out_dir: Path,
    *,
    nested_gitignore: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> list[list[str]]:
    observed: list[list[str]] = []
    original_find = scan_files.find_python_files

    def _spy_find_python_files(
        directory: Path,
        *,
        output_dir: str = ".repomap",
        include_patterns: list[str] | None = None,
        exclude_patterns: list[str] | None = None,
        nested_gitignore: bool = False,
    ) -> Iterator[Path]:
        files_list = list(
            original_find(
                directory,
                output_dir=output_dir,
                include_patterns=include_patterns,
                exclude_patterns=exclude_patterns,
                nested_gitignore=nested_gitignore,
            )
        )
        observed.append([path.relative_to(directory).as_posix() for path in files_list])
        yield from files_list

    monkeypatch.setattr(scan_files, "find_python_files", _spy_find_python_files)
    monkeypatch.setattr(deps_module, "find_python_files", _spy_find_python_files)
    monkeypatch.setattr(symbols_module, "find_python_files", _spy_find_python_files)
    monkeypatch.setattr(modules_module, "find_python_files", _spy_find_python_files)
    monkeypatch.setattr(
        integrations_module, "find_python_files", _spy_find_python_files
    )
    monkeypatch.setattr(calls_raw_module, "find_python_files", _spy_find_python_files)
    monkeypatch.setattr(refs_module, "find_python_files", _spy_find_python_files)

    SymbolsGenerator().generate(
        root=repo_root,
        out_dir=out_dir,
        nested_gitignore=nested_gitignore,
    )
    DepsGenerator().generate(
        root=repo_root,
        out_dir=out_dir,
        nested_gitignore=nested_gitignore,
    )
    IntegrationsGenerator().generate(
        root=repo_root,
        out_dir=out_dir,
        nested_gitignore=nested_gitignore,
    )
    ModulesGenerator().generate(
        root=repo_root,
        out_dir=out_dir,
        nested_gitignore=nested_gitignore,
    )
    CallsRawGenerator().generate(
        root=repo_root,
        out_dir=out_dir,
        nested_gitignore=nested_gitignore,
    )
    RefsGenerator().generate(
        root=repo_root,
        out_dir=out_dir,
        nested_gitignore=nested_gitignore,
    )
    CallsGenerator().generate(
        root=repo_root,
        out_dir=out_dir,
        nested_gitignore=nested_gitignore,
    )

    return observed


@pytest.mark.parametrize("nested_gitignore", [False, True])
def test_generator_filelist_parity(
    tmp_path: Path,
    nested_gitignore: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo_root = tmp_path / "repo"
    _write_repo_fixture(repo_root)
    out_dir = tmp_path / "artifacts"

    observed = _run_generators(
        repo_root,
        out_dir,
        nested_gitignore=nested_gitignore,
        monkeypatch=monkeypatch,
    )

    assert len(observed) == 6
    assert (
        observed[0]
        == observed[1]
        == observed[2]
        == observed[3]
        == observed[4]
        == observed[5]
    )

    if nested_gitignore:
        assert "nested/skip.py" not in observed[0]
    else:
        assert "nested/skip.py" in observed[0]
