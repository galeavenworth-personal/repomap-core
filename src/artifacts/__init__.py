"""Artifact generation entry points."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

    from rules.config import RepoMapConfig


def generate_all_artifacts(
    *,
    root: Path,
    out_dir: Path | None = None,
    config: RepoMapConfig | None = None,
) -> dict[str, object]:
    """Generate artifacts via lazy import to avoid package import cycles."""
    from artifacts.write import generate_all_artifacts as _generate_all_artifacts

    return _generate_all_artifacts(root=root, out_dir=out_dir, config=config)


__all__ = ["generate_all_artifacts"]
