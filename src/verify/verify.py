"""Determinism verification for repomap-core artifacts."""

from __future__ import annotations

import filecmp
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from artifacts.write import generate_all_artifacts


@dataclass(frozen=True)
class DeterminismResult:
    ok: bool
    mismatches: tuple[str, ...] = field(default_factory=tuple)
    missing: tuple[str, ...] = field(default_factory=tuple)
    extra: tuple[str, ...] = field(default_factory=tuple)


def _list_files(root: Path) -> set[Path]:
    return {path for path in root.rglob("*") if path.is_file()}


def _list_relative_files(root: Path) -> set[Path]:
    return {path.relative_to(root) for path in _list_files(root)}


def verify_determinism(*, root: Path, artifacts_dir: Path) -> DeterminismResult:
    """Verify that repomap-core artifacts are deterministic.

    Regenerates deterministic artifacts into a temporary directory and compares
    them byte-for-byte against the existing artifacts directory. File set
    comparisons are performed on relative paths to avoid root-dependent
    mismatches.

    Args:
        root: Repository root to analyze.
        artifacts_dir: Directory containing existing artifacts to verify.

    Returns:
        DeterminismResult with ok status and lists of missing, extra, and
        mismatched relative paths.

    Raises:
        FileNotFoundError: If artifacts_dir does not exist.
        NotADirectoryError: If artifacts_dir is not a directory.
    """
    if not artifacts_dir.exists():
        msg = f"Artifacts directory does not exist: {artifacts_dir}"
        raise FileNotFoundError(msg)
    if not artifacts_dir.is_dir():
        msg = f"Artifacts path is not a directory: {artifacts_dir}"
        raise NotADirectoryError(msg)
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        generate_all_artifacts(root=root, out_dir=temp_path)

        original_files = _list_relative_files(artifacts_dir)
        regenerated_files = _list_relative_files(temp_path)

        missing = sorted(str(path) for path in original_files - regenerated_files)
        extra = sorted(str(path) for path in regenerated_files - original_files)

        mismatches: list[str] = []
        for path in sorted(original_files & regenerated_files):
            regenerated_path = temp_path / path
            original_path = artifacts_dir / path
            if not filecmp.cmp(original_path, regenerated_path, shallow=False):
                mismatches.append(str(path))

        mismatches = sorted(mismatches)

    ok = not missing and not extra and not mismatches
    return DeterminismResult(
        ok=ok,
        mismatches=tuple(mismatches),
        missing=tuple(missing),
        extra=tuple(extra),
    )
