from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

from scan.files import find_python_files

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.skipif(
    os.name == "nt",
    reason="Symlink semantics vary on Windows test runners.",
)
def test_find_python_files_skips_symlinked_dirs(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    (repo_root / "pkg").mkdir()
    (repo_root / "pkg" / "module.py").write_text("print('ok')\n", encoding="utf-8")

    external_root = tmp_path / "external"
    external_root.mkdir()
    (external_root / "leak.py").write_text("print('leak')\n", encoding="utf-8")

    symlink_dir = repo_root / "linked"
    symlink_dir.symlink_to(external_root, target_is_directory=True)

    results = [
        path.relative_to(repo_root).as_posix() for path in find_python_files(repo_root)
    ]

    assert "pkg/module.py" in results
    assert "linked/leak.py" not in results
