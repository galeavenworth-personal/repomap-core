"""Shared utilities for"""

from __future__ import annotations

from pathlib import Path


def path_to_module(file_path: str | Path) -> str:
    """Convert a file path to a Python module name.

    Args:
        file_path: Relative file path (e.g., "repomap/cli.py" or Path object)

    Returns:
        Module name (e.g., "repomap.cli")

    Examples:
        >>> path_to_module("repomap/cli.py")
        'repomap.cli'
        >>> path_to_module("pkg/__init__.py")
        'pkg'
        >>> path_to_module(Path("foo/bar.py"))
        'foo.bar'
    """
    path_str = file_path.as_posix() if isinstance(file_path, Path) else str(file_path)
    path_str = path_str.replace("\\", "/")

    if path_str.endswith(".py"):
        path_str = path_str[:-3]

    module = path_str.replace("/", ".")

    if module.endswith(".__init__"):
        module = module[:-9]

    return module
