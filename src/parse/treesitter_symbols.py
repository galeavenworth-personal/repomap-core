"""Tree-sitter based symbol extraction for"""

from __future__ import annotations

from typing import TYPE_CHECKING

from tree_sitter import Language, Node, Parser
from tree_sitter_python import language as get_python_language

from artifacts.models.artifacts.symbols import SymbolKind, SymbolRecord

if TYPE_CHECKING:
    from pathlib import Path

_PARSER: Parser | None = None


def _get_parser() -> Parser:
    """Initialize and return the Tree-sitter parser with Python language."""
    global _PARSER
    if _PARSER is None:
        lang = Language(get_python_language())
        _PARSER = Parser(lang)

    return _PARSER


def _has_docstring(node: Node) -> bool:
    """Check if a function/class/module has a docstring as first statement."""
    body = node if node.type == "module" else node.child_by_field_name("body")
    if body is None:
        return False

    for child in body.children:
        if child.type == "expression_statement":
            if child.child_count > 0:
                first_expr = child.children[0]
                if first_expr.type == "string":
                    return True
            break
        if child.is_named and child.type not in ("comment",):
            break

    return False


def _build_qualified_name(
    module_name: str, parent_classes: list[str], name: str
) -> str:
    """Build a fully qualified name for a symbol."""
    if parent_classes:
        return f"{module_name}.{'.'.join(parent_classes)}.{name}"
    return f"{module_name}.{name}"


def _extract_base_classes(node: Node) -> list[str] | None:
    """Extract base class names from a class definition node.

    Returns a list of base class name strings as written in source,
    or None if the class has no base classes.
    """
    superclasses = node.child_by_field_name("superclasses")
    if superclasses is None:
        return None

    bases: list[str] = []
    for child in superclasses.children:
        if child.type in ("(", ")", ","):
            continue
        if child.type == "identifier" and child.text:
            bases.append(child.text.decode("utf8"))
        elif child.type == "attribute" and child.text:
            bases.append(child.text.decode("utf8"))
        elif child.type == "call":
            # e.g. metaclass=ABCMeta or Generic[T] — skip non-simple bases
            func_node = child.child_by_field_name("function")
            if func_node and func_node.text:
                bases.append(func_node.text.decode("utf8"))
        elif child.type == "subscript":
            # e.g. Generic[T] — extract the base name
            value_node = child.child_by_field_name("value")
            if value_node and value_node.text:
                bases.append(value_node.text.decode("utf8"))

    return bases if bases else None


def _create_symbol_record(
    node: Node,
    relative_path: str,
    kind: SymbolKind,
    name: str,
    qualified_name: str,
) -> SymbolRecord:
    """Create a SymbolRecord from a tree-sitter node."""
    start_line = node.start_point[0] + 1
    start_col = node.start_point[1] + 1

    base_classes: list[str] | None = None
    if kind == "class":
        base_classes = _extract_base_classes(node)

    return SymbolRecord(
        path=relative_path,
        kind=kind,
        name=name,
        qualified_name=qualified_name,
        symbol_id=f"sym:{relative_path}::{qualified_name}@L{start_line}:C{start_col}",
        symbol_key=f"symkey:{relative_path}::{qualified_name}::{kind}",
        start_line=start_line,
        start_col=start_col,
        end_line=node.end_point[0] + 1,
        end_col=node.end_point[1] + 1,
        docstring_present=_has_docstring(node),
        base_classes=base_classes,
    )


def _handle_class_definition(
    node: Node,
    symbols: list[SymbolRecord],
    relative_path: str,
    module_name: str,
    parent_classes: list[str],
) -> bool:
    """Process a class definition node. Returns True if handled."""
    name_node = node.child_by_field_name("name")
    if not (name_node and name_node.text):
        return False

    class_name = name_node.text.decode("utf8")
    qualified = _build_qualified_name(module_name, parent_classes, class_name)
    symbols.append(
        _create_symbol_record(node, relative_path, "class", class_name, qualified)
    )

    new_parents = [*parent_classes, class_name]
    for child in node.children:
        _traverse_node(child, symbols, relative_path, module_name, new_parents)
    return True


def _handle_function_definition(
    node: Node,
    symbols: list[SymbolRecord],
    relative_path: str,
    module_name: str,
    parent_classes: list[str],
) -> bool:
    """Process a function definition node. Returns True if handled.

    Note: We intentionally do NOT recurse into function bodies. Nested functions
    inside methods/functions are not indexed to avoid misleading qualified names.
    """
    name_node = node.child_by_field_name("name")
    if not (name_node and name_node.text):
        return False

    func_name = name_node.text.decode("utf8")
    kind: SymbolKind = "method" if parent_classes else "function"
    qualified = _build_qualified_name(module_name, parent_classes, func_name)
    symbols.append(
        _create_symbol_record(node, relative_path, kind, func_name, qualified)
    )

    return True


def _traverse_node(
    node: Node,
    symbols: list[SymbolRecord],
    relative_path: str,
    module_name: str,
    parent_classes: list[str],
) -> None:
    """Traverse the syntax tree and collect symbols."""
    if node.type == "class_definition" and _handle_class_definition(
        node, symbols, relative_path, module_name, parent_classes
    ):
        return

    if node.type == "function_definition" and _handle_function_definition(
        node, symbols, relative_path, module_name, parent_classes
    ):
        return

    for child in node.children:
        _traverse_node(child, symbols, relative_path, module_name, parent_classes)


def extract_symbols_treesitter(
    file_path: Path,
    relative_path: str,
    module_name: str,
) -> list[SymbolRecord]:
    """Extract symbols from a Python file using Tree-sitter.

    Args:
        file_path: Absolute path to the Python file
        relative_path: Path relative to repo root (for output)
        module_name: Module name derived from relative path (e.g., "repomap.cli")

    Returns:
        List of SymbolRecord objects for all symbols in the file.
    """
    parser = _get_parser()

    try:
        source_bytes = file_path.read_bytes()
    except OSError:
        return []

    tree = parser.parse(source_bytes)
    root_node = tree.root_node

    symbols: list[SymbolRecord] = []

    symbols.append(
        SymbolRecord(
            path=relative_path,
            kind="module",
            name=module_name.split(".")[-1] if module_name else "<unknown>",
            qualified_name=module_name,
            symbol_id=f"sym:{relative_path}::{module_name}@L1:C1",
            symbol_key=f"symkey:{relative_path}::{module_name}::module",
            start_line=1,
            start_col=1,
            end_line=root_node.end_point[0] + 1,
            end_col=root_node.end_point[1] + 1,
            docstring_present=_has_docstring(root_node),
        )
    )

    _traverse_node(root_node, symbols, relative_path, module_name, [])

    return symbols
