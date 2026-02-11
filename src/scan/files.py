"""File scanning utilities for"""

from __future__ import annotations

from fnmatch import fnmatch
from typing import TYPE_CHECKING, cast

from gitignore_parser import parse_gitignore  # type: ignore[import-untyped]

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from pathlib import Path


def _should_include_file(
    path: Path,
    directory: Path,
    output_dir: str,
    gitignore_matches: Callable[[str], bool] | None,
    include_patterns: list[str] | None,
    exclude_patterns: list[str] | None,
) -> bool:
    """Check if a file should be included based on all filtering rules."""
    if not path.is_file() or path.is_symlink():
        return False

    if not _is_within_root(path, directory):
        return False

    try:
        rel_path = path.relative_to(directory)
    except ValueError:
        return False

    rel_path_str = rel_path.as_posix()

    if output_dir and rel_path.parts and rel_path.parts[0] == output_dir:
        return False

    if gitignore_matches is not None and gitignore_matches(str(path)):
        return False

    if include_patterns and not any(
        fnmatch(rel_path_str, pat) for pat in include_patterns
    ):
        return False

    has_excluded_match = exclude_patterns and any(
        fnmatch(rel_path_str, pat) for pat in exclude_patterns
    )
    return not has_excluded_match


def _is_within_root(path: Path, root: Path) -> bool:
    """Return True when the resolved path stays within the resolved root."""
    try:
        root_resolved = root.resolve()
        path_resolved = path.resolve()
    except OSError:
        return False

    try:
        path_resolved.relative_to(root_resolved)
    except ValueError:
        return False

    return True


def _iter_gitignore_files(root: Path) -> list[Path]:
    """Return sorted list of .gitignore files under root (including root)."""
    gitignore_paths = [root / ".gitignore"]
    gitignore_paths.extend(root.rglob(".gitignore"))
    unique_paths = {path for path in gitignore_paths if path.is_file()}
    return sorted(unique_paths, key=lambda p: p.relative_to(root).as_posix())


def _build_gitignore_matcher(
    root: Path,
    *,
    nested_gitignore: bool,
) -> Callable[[str], bool] | None:
    if not nested_gitignore:
        gitignore_path = root / ".gitignore"
        if gitignore_path.is_file():
            return cast("Callable[[str], bool]", parse_gitignore(gitignore_path))
        return None

    gitignore_paths = _iter_gitignore_files(root)
    if not gitignore_paths:
        return None

    matchers = [parse_gitignore(path) for path in gitignore_paths]

    def matches(path_str: str) -> bool:
        for matcher in matchers:
            try:
                if matcher(path_str):
                    return True
            except ValueError:
                continue
        return False

    return matches


def find_python_files(
    directory: Path,
    *,
    output_dir: str = ".repomap",
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
    nested_gitignore: bool = False,
) -> Iterator[Path]:
    """Find all Python files in a directory, respecting .gitignore.

    Args:
        directory: Directory to search for Python files
        output_dir: Directory name to skip (default ".repomap")
        include_patterns: Optional list of fnmatch patterns; if provided,
            files must match at least one pattern to be included
        exclude_patterns: Optional list of fnmatch patterns; files matching
            any pattern are excluded

    Yields:
        Path objects for each Python file found, sorted lexicographically
        by relative path for deterministic ordering.
    """
    gitignore_matches = _build_gitignore_matcher(
        directory,
        nested_gitignore=nested_gitignore,
    )

    matched_files = [
        path
        for path in directory.rglob("*.py")
        if _should_include_file(
            path,
            directory,
            output_dir,
            gitignore_matches,
            include_patterns,
            exclude_patterns,
        )
    ]

    matched_files.sort(key=lambda p: p.relative_to(directory).as_posix())

    yield from matched_files


__all__ = ["_should_include_file", "find_python_files"]
