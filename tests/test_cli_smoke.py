from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path

import pytest

from cli import main
from rules.config import ConfigError, load_config, resolve_output_dir

_PUNCH_ENGINE_PATH = (
    Path(__file__).parent.parent / ".kilocode" / "tools" / "punch_engine.py"
)
_punch_spec = importlib.util.spec_from_file_location(
    "kilocode_punch_engine", _PUNCH_ENGINE_PATH
)
assert _punch_spec is not None
assert _punch_spec.loader is not None
_punch_engine = importlib.util.module_from_spec(_punch_spec)
_punch_spec.loader.exec_module(_punch_engine)


def _write_minimal_repo(root: Path) -> None:
    (root / "pkg").mkdir(parents=True, exist_ok=True)
    (root / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (root / "pkg" / "module.py").write_text(
        '"""Minimal module."""\n',
        encoding="utf-8",
    )


def _copy_mini_repo_fixture(root: Path) -> None:
    fixture_repo = Path(__file__).parent / "fixtures" / "mini_repo"
    shutil.copytree(fixture_repo, root)


def test_cli_generate_smoke(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    repo_root.mkdir()
    _write_minimal_repo(repo_root)

    out_dir = tmp_path / "artifacts"
    exit_code = main(["generate", str(repo_root), "--out-dir", str(out_dir)])

    assert exit_code == 0
    assert out_dir.exists()
    assert any(out_dir.iterdir())


def test_readme_generate_default_output_dir_from_fixture(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    _copy_mini_repo_fixture(repo_root)

    assert not (repo_root / ".repomap").exists(), "output dir must not pre-exist"
    exit_code = main(["generate", str(repo_root)])

    default_out_dir = repo_root / ".repomap"
    assert exit_code == 0
    assert default_out_dir.exists()
    assert any(default_out_dir.iterdir())


def test_readme_generate_out_dir_flag_from_fixture(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    _copy_mini_repo_fixture(repo_root)

    custom_out_dir = tmp_path / "custom-artifacts"
    assert not custom_out_dir.exists(), "custom output dir must not pre-exist"
    exit_code = main(["generate", str(repo_root), "--out-dir", str(custom_out_dir)])

    assert exit_code == 0
    assert custom_out_dir.exists()
    assert any(custom_out_dir.iterdir())


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


def test_punch_resolve_task_id_passthrough_uuid() -> None:
    task_id = "123e4567-e89b-12d3-a456-426614174000"
    assert _punch_engine.resolve_task_id(task_id) == task_id


def test_punch_resolve_task_id_auto_uses_vscode_dirs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_id = "123e4567-e89b-12d3-a456-426614174000"
    monkeypatch.setattr(_punch_engine, "get_current_task_id", lambda: task_id)

    assert _punch_engine.resolve_task_id("auto") == task_id


def test_punch_resolve_task_id_auto_errors_when_no_discovery(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(_punch_engine, "get_current_task_id", lambda: None)

    with pytest.raises(SystemExit) as exc_info:
        _punch_engine.resolve_task_id("auto")

    assert exc_info.value.code == 1
    assert "task_id 'auto' requested but discovery failed" in capsys.readouterr().err
