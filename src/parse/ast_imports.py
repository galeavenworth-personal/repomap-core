"""AST-based import analysis for"""

from __future__ import annotations

import ast
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path


def _process_import_node(
    node: ast.Import, imports: dict[str, list[tuple[int, str, str, int]]]
) -> None:
    """Process a standard import node (import x)."""
    for name in node.names:
        imports["import"].append((node.lineno, name.name, name.asname or "", 0))


def _get_import_type(name: ast.alias, is_relative: bool) -> str:
    """Determine the import type based on name and relativity."""
    if name.name == "*":
        return "import_star"
    return "relative_import" if is_relative else "import_from"


def _format_alias(name: ast.alias) -> str:
    """Format the alias string for an import name."""
    if name.asname:
        return f"{name.name} as {name.asname}"
    return name.name


def _process_import_from_node(
    node: ast.ImportFrom, imports: dict[str, list[tuple[int, str, str, int]]]
) -> None:
    """Process a from-import node (from x import y)."""
    module = node.module or ""
    is_relative = node.level > 0

    for name in node.names:
        import_type = _get_import_type(name, is_relative)
        alias = _format_alias(name)
        imports[import_type].append((node.lineno, module, alias, node.level))


def extract_imports(file_path: Path) -> dict[str, list[tuple[int, str, str, int]]]:
    """Extract import statements from a Python file using AST.

    Args:
        file_path: Path to the Python file to analyze

    Returns:
        Dictionary with import types as keys and lists of
        (line_number, module, name, level) tuples as values.
        Level is 0 for absolute imports, 1+ for relative imports.
    """
    imports: dict[str, list[tuple[int, str, str, int]]] = {
        "import": [],
        "import_from": [],
        "import_star": [],
        "relative_import": [],
    }

    try:
        with file_path.open(encoding="utf-8") as file:
            tree = ast.parse(file.read(), str(file_path))

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                _process_import_node(node, imports)
            elif isinstance(node, ast.ImportFrom):
                _process_import_from_node(node, imports)

    except (SyntaxError, UnicodeDecodeError):
        # Invalid syntax or encoding: treat as no imports to keep scans deterministic.
        return imports

    return imports


def resolve_relative_import(
    importing_module: str,
    relative_module: str,
    level: int,
) -> str:
    """Resolve a relative import to an absolute module name.

    Args:
        importing_module: The module doing the import (e.g., "pkg.sub.mod")
        relative_module: The relative module name (e.g., "foo" from ".foo")
        level: Number of dots (1 for ".", 2 for "..", etc.)

    Returns:
        Absolute module name (e.g., "pkg.sub.foo")

    Examples:
        >>> resolve_relative_import("pkg.sub.mod", "foo", 1)
        'pkg.sub.foo'
        >>> resolve_relative_import("pkg.sub.mod", "", 1)
        'pkg.sub'
        >>> resolve_relative_import("pkg.sub.mod", "bar", 2)
        'pkg.bar'
    """
    parts = importing_module.split(".")

    if level > len(parts):
        return relative_module or importing_module

    base_parts = parts[: len(parts) - level]

    if relative_module:
        return ".".join([*base_parts, relative_module])
    if base_parts:
        return ".".join(base_parts)
    return importing_module
