from __future__ import annotations

from pathlib import Path

import pytest

from rules.config import ConfigError, load_config


def _write_config(repo_root: Path, toml_content: str) -> None:
    (repo_root / "repomap.toml").write_text(toml_content, encoding="utf-8")


def test_semantic_section_rejected(tmp_path: Path) -> None:
    _write_config(
        tmp_path,
        """
[semantic]
enabled = true
""".strip(),
    )

    with pytest.raises(ConfigError):
        load_config(tmp_path)


def test_analyzers_section_rejected(tmp_path: Path) -> None:
    _write_config(
        tmp_path,
        """
[analyzers]
enabled = true
""".strip(),
    )

    with pytest.raises(ConfigError):
        load_config(tmp_path)


def test_unknown_top_level_key_rejected(tmp_path: Path) -> None:
    _write_config(tmp_path, "bogus_key = true")

    with pytest.raises(ConfigError):
        load_config(tmp_path)


def test_valid_config_accepted(tmp_path: Path) -> None:
    _write_config(tmp_path, 'exclude = [".venv/**"]')

    config = load_config(tmp_path)

    assert config.exclude == [".venv/**"]


def test_empty_config_accepted(tmp_path: Path) -> None:
    _write_config(tmp_path, "")

    config = load_config(tmp_path)

    assert config.output_dir == ".repomap"
    assert config.include == []
    assert config.exclude == []
