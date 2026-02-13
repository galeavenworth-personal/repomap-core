"""Shared utilities for"""

from __future__ import annotations

from pathlib import Path


def path_to_module(file_path: str | Path) -> str:
    """Convert a file path to a Python module name.

    Args:
        file_path: Relative file path (e.g., "src/repomap_core/cli.py" or Path object)

    Returns:
        Module name (e.g., "repomap_core.cli")

    Examples:
        >>> path_to_module("src/repomap_core/cli.py")
        'repomap_core.cli'
        >>> path_to_module("src/repomap_core/__init__.py")
        'repomap_core'
        >>> path_to_module(Path("foo/bar.py"))
        'foo.bar'
    """
    path_str = file_path.as_posix() if isinstance(file_path, Path) else str(file_path)
    normalized_parts = [part for part in path_str.replace("\\", "/").split("/") if part]

    # Canonical rule: Python source under src/<package>/... maps to
    # <package>.<submodules>. This yields package-resolvable module IDs
    # (e.g., src/repomap_core/cli.py -> repomap_core.cli).
    module_parts = (
        normalized_parts[1:]
        if len(normalized_parts) >= 2 and normalized_parts[0] == "src"
        else normalized_parts
    )

    # Deterministic fallback for paths outside src/<package>/...:
    # keep all normalized path segments and apply the same extension/
    # __init__ handling below.
    if module_parts and module_parts[-1].endswith(".py"):
        module_parts[-1] = module_parts[-1][:-3]

    if module_parts and module_parts[-1] == "__init__":
        module_parts = module_parts[:-1]

    return ".".join(module_parts)
