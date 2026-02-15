"""Tree-sitter based call-site extraction for Python files."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tree_sitter import Node

from parse.treesitter_symbols import _get_parser


def _module_symbol_id(relative_path: str) -> str:
    return f"module:{relative_path}"


def _symbol_id(relative_path: str, name: str, start_line: int, start_col: int) -> str:
    return f"symbol:{relative_path}:{name}@L{start_line}:C{start_col}"


def _decode_node_text(source_bytes: bytes, node: Node) -> str:
    return source_bytes[node.start_byte : node.end_byte].decode("utf8", errors="ignore")


def _normalize_callee_expr(source_bytes: bytes, callee_node: Node | None) -> str:
    if callee_node is None:
        return "<complex_expr>"

    if callee_node.type == "identifier":
        return _decode_node_text(source_bytes, callee_node).strip()

    if callee_node.type == "attribute":
        object_node = callee_node.child_by_field_name("object")
        attribute_node = callee_node.child_by_field_name("attribute")

        normalized_object = _normalize_callee_expr(source_bytes, object_node)
        if attribute_node is None or attribute_node.type != "identifier":
            return "<attribute>"

        attr_name = _decode_node_text(source_bytes, attribute_node).strip()
        if normalized_object.startswith("<") and normalized_object.endswith(">"):
            return "<attribute>"
        return f"{normalized_object}.{attr_name}".strip()

    placeholder_map = {
        "subscript": "<subscript>",
        "call": "<call>",
        "lambda": "<lambda>",
    }
    return placeholder_map.get(callee_node.type, f"<{callee_node.type}>")


def _make_src_span(relative_path: str, node: Node) -> dict[str, int | str]:
    return {
        "path": relative_path,
        "start_line": node.start_point[0] + 1,
        "start_col": node.start_point[1] + 1,
        "end_line": node.end_point[0] + 1,
        "end_col": node.end_point[1] + 1,
    }


def _extract_name(source_bytes: bytes, node: Node | None, default: str) -> str:
    if node is None:
        return default
    text = _decode_node_text(source_bytes, node).strip()
    return text or default


def _traverse_calls(
    node: Node,
    *,
    source_bytes: bytes,
    relative_path: str,
    scope_stack: list[str],
    out_records: list[dict[str, Any]],
) -> None:
    pushed = False
    node_start_line = node.start_point[0] + 1
    node_start_col = node.start_point[1]

    if node.type == "class_definition":
        class_name = _extract_name(
            source_bytes,
            node.child_by_field_name("name"),
            "<class>",
        )
        scope_stack.append(
            _symbol_id(relative_path, class_name, node_start_line, node_start_col)
        )
        pushed = True
    elif node.type == "function_definition":
        function_name = _extract_name(
            source_bytes,
            node.child_by_field_name("name"),
            "<function>",
        )
        scope_stack.append(
            _symbol_id(relative_path, function_name, node_start_line, node_start_col)
        )
        pushed = True
    elif node.type == "lambda":
        scope_stack.append(
            _symbol_id(relative_path, "<lambda>", node_start_line, node_start_col)
        )
        pushed = True

    if node.type == "call":
        callee_node = node.child_by_field_name("function")
        callee_expr = _normalize_callee_expr(source_bytes, callee_node).strip()
        out_records.append(
            {
                "callee_expr": callee_expr,
                "src_span": _make_src_span(relative_path, node),
                "enclosing_symbol_id": scope_stack[-1],
            }
        )

    for child in node.children:
        _traverse_calls(
            child,
            source_bytes=source_bytes,
            relative_path=relative_path,
            scope_stack=scope_stack,
            out_records=out_records,
        )

    if pushed:
        scope_stack.pop()


def extract_calls_treesitter(file_path: str, repo_root: str) -> list[dict[str, Any]]:
    """Extract all call sites from a Python file using Tree-sitter.

    Returns list of dicts with keys: callee_expr, src_span, enclosing_symbol_id.
    Each src_span has: path (relative), start_line, start_col, end_line, end_col
    (all 1-based).
    """
    parser = _get_parser()

    file_obj = Path(file_path)
    root_obj = Path(repo_root)

    try:
        root_resolved = root_obj.resolve()
        file_resolved = file_obj.resolve(strict=False)
        file_resolved.relative_to(root_resolved)
    except (OSError, ValueError):
        return []

    try:
        source_bytes = file_resolved.read_bytes()
    except OSError:
        return []

    try:
        relative_path = file_resolved.relative_to(root_resolved).as_posix()
    except ValueError:
        return []

    tree = parser.parse(source_bytes)
    root_node = tree.root_node

    records: list[dict[str, Any]] = []
    scope_stack = [_module_symbol_id(relative_path)]
    _traverse_calls(
        root_node,
        source_bytes=source_bytes,
        relative_path=relative_path,
        scope_stack=scope_stack,
        out_records=records,
    )
    return records


__all__ = ["extract_calls_treesitter"]
