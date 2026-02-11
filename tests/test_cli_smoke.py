from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from cli import main
from rules.config import ConfigError, load_config, resolve_output_dir

if TYPE_CHECKING:
    from pathlib import Path


def _write_minimal_repo(root: Path) -> None:
    (root / "pkg").mkdir(parents=True, exist_ok=True)
    (root / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (root / "pkg" / "module.py").write_text(
        '"""Minimal module."""\n',
        encoding="utf-8",
    )


def test_cli_generate_smoke(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_minimal_repo(repo_root)

    out_dir = tmp_path / "artifacts"
    exit_code = main(["generate", str(repo_root), "--out-dir", str(out_dir)])

    assert exit_code == 0
    assert out_dir.exists()
    assert any(out_dir.iterdir())


def test_cli_validate_default_artifacts_dir_reports_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_minimal_repo(repo_root)
    default_artifacts_dir = (repo_root / load_config(repo_root).output_dir).resolve()

    monkeypatch.chdir(repo_root)
    exit_code = main(["validate"])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert f"{default_artifacts_dir}:" in captured.err
    assert "Artifacts directory does not exist." in captured.err


def test_cli_validate_includes_path_and_message(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    artifacts_dir = tmp_path / "missing-artifacts"

    exit_code = main(["validate", str(tmp_path), "--artifacts-dir", str(artifacts_dir)])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert f"{artifacts_dir}:" in captured.err
    assert "Artifacts directory does not exist." in captured.err


def test_cli_verify_default_artifacts_dir_reports_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_minimal_repo(repo_root)
    default_artifacts_dir = (repo_root / load_config(repo_root).output_dir).resolve()

    monkeypatch.chdir(repo_root)
    exit_code = main(["verify"])

    assert exit_code == 2
    captured = capsys.readouterr()
    assert f"artifacts-dir: {default_artifacts_dir}" in captured.err
    assert "Artifacts directory does not exist" in captured.err


def test_cli_verify_missing_artifacts_dir_reports_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_minimal_repo(repo_root)

    artifacts_dir = tmp_path / "missing-artifacts"
    exit_code = main(["verify", str(repo_root), "--artifacts-dir", str(artifacts_dir)])

    assert exit_code == 2
    captured = capsys.readouterr()
    assert f"artifacts-dir: {artifacts_dir}" in captured.err
    assert "Artifacts directory does not exist" in captured.err


def test_resolve_output_dir_rejects_escape(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    with pytest.raises(ConfigError, match="escapes the repository root"):
        resolve_output_dir(repo_root, "../outside")
