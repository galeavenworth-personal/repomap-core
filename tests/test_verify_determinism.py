from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from verify.verify import DeterminismResult, verify_determinism

if TYPE_CHECKING:
    from pathlib import Path


def _write_minimal_repo(root: Path) -> None:
    (root / "pkg").mkdir(parents=True, exist_ok=True)
    (root / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (root / "pkg" / "module.py").write_text(
        '"""Minimal module."""\n',
        encoding="utf-8",
    )


def test_verify_determinism_requires_artifacts_dir(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_minimal_repo(repo_root)

    missing_dir = tmp_path / "missing"
    with pytest.raises(FileNotFoundError, match="Artifacts directory does not exist"):
        verify_determinism(root=repo_root, artifacts_dir=missing_dir)


def test_verify_determinism_relative_paths_and_sorted_mismatches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_minimal_repo(repo_root)

    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    for rel_path, content in (
        ("b.txt", "b-original"),
        ("a.txt", "a-original"),
    ):
        path = artifacts_dir / rel_path
        path.write_text(content, encoding="utf-8")

    def _fake_generate_all_artifacts(*, root: Path, out_dir: Path) -> dict[str, object]:
        (out_dir / "a.txt").write_text("a-original", encoding="utf-8")
        (out_dir / "b.txt").write_text("b-regenerated", encoding="utf-8")
        return {"artifacts": [str(out_dir / "a.txt"), str(out_dir / "b.txt")]}

    monkeypatch.setattr(
        "verify.verify.generate_all_artifacts",
        _fake_generate_all_artifacts,
    )

    result = verify_determinism(root=repo_root, artifacts_dir=artifacts_dir)

    assert result == DeterminismResult(
        ok=False,
        mismatches=("b.txt",),
        missing=(),
        extra=(),
    )
