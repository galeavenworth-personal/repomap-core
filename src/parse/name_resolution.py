"""Tier-1 deterministic module-level name resolution helpers."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from artifacts.models.artifacts.refs import ResolvedTo
from parse.ast_imports import resolve_relative_import

ModulesIndex = dict[str, str]
SymbolsIndex = dict[str, list["SymbolInfo"]]


@dataclass(frozen=True)
class SymbolInfo:
    """Symbol metadata used for in-memory name resolution."""

    symbol_id: str
    qualified_name: str
    name: str
    kind: str
    path: str
    base_classes: tuple[str, ...] | None = None


@dataclass(frozen=True)
class NameBinding:
    """A single local-name binding in a module-level name table."""

    local_name: str
    target_symbol_id: str | None
    qualified_name: str
    resolution: str
    confidence: int
    strategy: str
    target_path: str | None
    target_module: str | None


NameTable = dict[str, NameBinding]

_STRATEGY_CONFIDENCE: dict[str, int] = {
    "module_local_def": 90,
    "module_import_from": 80,
    "module_import_module": 75,
    "module_alias_assignment": 60,
    "class_self_method": 70,
    "class_cls_method": 70,
    "class_super_method": 65,
    "class_static_method": 75,
}


def _is_internal_path(path: str | None, modules_index: ModulesIndex) -> bool:
    return path is not None and path in modules_index


def _parse_import_name(name_str: str) -> tuple[str, str]:
    """Parse 'name as alias' into (name, alias), defaulting alias=name."""
    if " as " in name_str:
        name, alias = name_str.split(" as ", 1)
        return name.strip(), alias.strip()
    parsed = name_str.strip()
    return parsed, parsed


def _invert_modules_index(modules_index: ModulesIndex) -> dict[str, str]:
    module_to_path: dict[str, str] = {}
    for path, module in sorted(modules_index.items()):
        module_to_path.setdefault(module, path)
    return module_to_path


def _build_symbol_lookup(
    symbols_index: SymbolsIndex,
    modules_index: ModulesIndex,
) -> tuple[dict[str, SymbolInfo], dict[str, SymbolInfo]]:
    by_qualified_name: dict[str, SymbolInfo] = {}
    by_module_name: dict[str, SymbolInfo] = {}
    module_to_path = _invert_modules_index(modules_index)

    for module_name, symbols in sorted(symbols_index.items()):
        for symbol in symbols:
            by_qualified_name.setdefault(symbol.qualified_name, symbol)

        module_path = module_to_path.get(module_name)
        if module_path is not None:
            by_module_name.setdefault(
                module_name,
                SymbolInfo(
                    symbol_id=f"module:{module_path}",
                    qualified_name=module_name,
                    name=module_name.rsplit(".", 1)[-1],
                    kind="module",
                    path=module_path,
                ),
            )

    return by_qualified_name, by_module_name


def _is_top_level_local_def(module_name: str, symbol: SymbolInfo) -> bool:
    if symbol.kind not in {"function", "class"}:
        return False
    prefix = f"{module_name}."
    if not symbol.qualified_name.startswith(prefix):
        return False
    remainder = symbol.qualified_name[len(prefix) :]
    return "." not in remainder


def _extract_trivial_aliases(
    file_path: str,
    repo_root: Path | None = None,
) -> list[tuple[str, str]]:
    """Extract module-scope trivial aliases: `target = source` name-to-name only."""
    source = Path(file_path)
    if not source.is_absolute() and repo_root is not None:
        source = repo_root / source
    try:
        tree = ast.parse(source.read_text(encoding="utf-8"), file_path)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return []

    aliases: list[tuple[str, str]] = []
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1:
            continue
        target_node = node.targets[0]
        if not isinstance(target_node, ast.Name):
            continue
        if not isinstance(node.value, ast.Name):
            continue
        aliases.append((target_node.id, node.value.id))

    return aliases


def _binding_to_resolved(
    binding: NameBinding,
    modules_index: ModulesIndex,
) -> ResolvedTo:
    path = (
        binding.target_path
        if _is_internal_path(binding.target_path, modules_index)
        else None
    )
    dst_module = binding.target_module if path is not None else None
    symbol_id = binding.target_symbol_id or f"ext:{binding.qualified_name}"
    return ResolvedTo(
        symbol_id=symbol_id,
        qualified_name=binding.qualified_name,
        resolution=binding.resolution,
        confidence=binding.confidence,
        path=path,
        dst_module=dst_module,
    )


def build_modules_index(module_records: list[dict[str, Any]]) -> ModulesIndex:
    """Build path -> module mapping from modules artifact records."""
    index: ModulesIndex = {}
    for record in module_records:
        path = record.get("path")
        module = record.get("module")
        if isinstance(path, str) and isinstance(module, str):
            index[path] = module
    return index


def build_symbols_index(
    symbol_records: list[dict[str, Any]],
    modules_index: ModulesIndex,
) -> SymbolsIndex:
    """Build module -> symbols mapping using modules index as authority."""
    index: SymbolsIndex = {}
    for record in symbol_records:
        path = record.get("path")
        if not isinstance(path, str):
            continue
        module_name = modules_index.get(path)
        if module_name is None:
            continue

        symbol_id_obj = record.get("symbol_id")
        qualified_name_obj = record.get("qualified_name")
        name_obj = record.get("name")
        kind_obj = record.get("kind")

        if not isinstance(symbol_id_obj, str):
            continue
        if not isinstance(qualified_name_obj, str):
            continue
        if not isinstance(name_obj, str):
            continue
        if not isinstance(kind_obj, str):
            continue

        base_classes_raw = record.get("base_classes")
        base_classes: tuple[str, ...] | None = None
        if isinstance(base_classes_raw, list):
            base_classes = (
                tuple(b for b in base_classes_raw if isinstance(b, str)) or None
            )

        symbol = SymbolInfo(
            symbol_id=symbol_id_obj,
            qualified_name=qualified_name_obj,
            name=name_obj,
            kind=kind_obj,
            path=path,
            base_classes=base_classes,
        )
        index.setdefault(module_name, []).append(symbol)

    for symbols in index.values():
        symbols.sort(key=lambda s: (s.path, s.qualified_name, s.symbol_id))
    return index


def _add_local_def_bindings(
    table: NameTable,
    module_name: str,
    symbols_index: SymbolsIndex,
) -> None:
    for symbol in symbols_index.get(module_name, []):
        if _is_top_level_local_def(module_name, symbol):
            table[symbol.name] = NameBinding(
                local_name=symbol.name,
                target_symbol_id=symbol.symbol_id,
                qualified_name=symbol.qualified_name,
                resolution=symbol.kind,
                confidence=_STRATEGY_CONFIDENCE["module_local_def"],
                strategy="module_local_def",
                target_path=symbol.path,
                target_module=module_name,
            )


def _add_import_module_bindings(
    table: NameTable,
    imports: dict[str, list[tuple[int, str, str, int]]],
    module_to_path: dict[str, str],
    module_symbols: dict[str, SymbolInfo],
) -> None:
    for _, imported_module, asname, _ in imports.get("import", []):
        if not isinstance(imported_module, str):
            continue
        if isinstance(asname, str) and asname:
            local_name = asname
            target_module = imported_module
        else:
            top_level_module = imported_module.split(".", 1)[0]
            local_name = top_level_module
            target_module = top_level_module
        target_path = module_to_path.get(target_module)
        module_symbol = module_symbols.get(target_module)
        table[local_name] = NameBinding(
            local_name=local_name,
            target_symbol_id=module_symbol.symbol_id if module_symbol else None,
            qualified_name=target_module,
            resolution="module",
            confidence=_STRATEGY_CONFIDENCE["module_import_module"],
            strategy="module_import_module",
            target_path=target_path,
            target_module=target_module if target_path is not None else None,
        )


def _add_import_from_bindings(
    table: NameTable,
    imports: dict[str, list[tuple[int, str, str, int]]],
    symbols_by_qualified_name: dict[str, SymbolInfo],
    modules_index: ModulesIndex,
) -> None:
    for _, imported_module, name_alias, _ in imports.get("import_from", []):
        if not isinstance(imported_module, str) or not isinstance(name_alias, str):
            continue
        imported_name, local_name = _parse_import_name(name_alias)
        qualified_name = (
            f"{imported_module}.{imported_name}" if imported_module else imported_name
        )
        imported_symbol = symbols_by_qualified_name.get(qualified_name)
        table[local_name] = NameBinding(
            local_name=local_name,
            target_symbol_id=(
                imported_symbol.symbol_id if imported_symbol is not None else None
            ),
            qualified_name=qualified_name,
            resolution=(
                imported_symbol.kind if imported_symbol is not None else "imported_name"
            ),
            confidence=_STRATEGY_CONFIDENCE["module_import_from"],
            strategy="module_import_from",
            target_path=imported_symbol.path if imported_symbol is not None else None,
            target_module=(
                modules_index.get(imported_symbol.path)
                if imported_symbol is not None
                else None
            ),
        )


def _add_relative_import_bindings(
    table: NameTable,
    imports: dict[str, list[tuple[int, str, str, int]]],
    module_name: str,
    symbols_by_qualified_name: dict[str, SymbolInfo],
    modules_index: ModulesIndex,
) -> None:
    for _, relative_module, name_alias, level in imports.get("relative_import", []):
        if not isinstance(relative_module, str) or not isinstance(name_alias, str):
            continue
        imported_name, local_name = _parse_import_name(name_alias)
        resolved_module = resolve_relative_import(
            module_name, relative_module, int(level)
        )
        qualified_name = (
            f"{resolved_module}.{imported_name}" if resolved_module else imported_name
        )
        imported_symbol = symbols_by_qualified_name.get(qualified_name)
        table[local_name] = NameBinding(
            local_name=local_name,
            target_symbol_id=(
                imported_symbol.symbol_id if imported_symbol is not None else None
            ),
            qualified_name=qualified_name,
            resolution=(
                imported_symbol.kind if imported_symbol is not None else "imported_name"
            ),
            confidence=_STRATEGY_CONFIDENCE["module_import_from"],
            strategy="module_import_from",
            target_path=imported_symbol.path if imported_symbol is not None else None,
            target_module=(
                modules_index.get(imported_symbol.path)
                if imported_symbol is not None
                else None
            ),
        )


def _add_trivial_alias_bindings(
    table: NameTable,
    file_path: str,
    repo_root: Path | None,
) -> None:
    for alias_name, source_name in _extract_trivial_aliases(file_path, repo_root):
        source_binding = table.get(source_name)
        if source_binding is None:
            continue
        table[alias_name] = NameBinding(
            local_name=alias_name,
            target_symbol_id=source_binding.target_symbol_id,
            qualified_name=source_binding.qualified_name,
            resolution=source_binding.resolution,
            confidence=_STRATEGY_CONFIDENCE["module_alias_assignment"],
            strategy="module_alias_assignment",
            target_path=source_binding.target_path,
            target_module=source_binding.target_module,
        )


def build_name_table(
    file_path: str,
    modules_index: ModulesIndex,
    symbols_index: SymbolsIndex,
    imports: dict[str, list[tuple[int, str, str, int]]],
    repo_root: Path | None = None,
) -> NameTable:
    """Build per-module name table from local defs, imports, and aliases."""
    module_name = modules_index.get(file_path)
    if module_name is None:
        return {}

    module_to_path = _invert_modules_index(modules_index)
    symbols_by_qualified_name, module_symbols = _build_symbol_lookup(
        symbols_index,
        modules_index,
    )

    table: NameTable = {}

    _add_local_def_bindings(table, module_name, symbols_index)
    _add_import_module_bindings(table, imports, module_to_path, module_symbols)
    _add_import_from_bindings(table, imports, symbols_by_qualified_name, modules_index)
    _add_relative_import_bindings(
        table,
        imports,
        module_name,
        symbols_by_qualified_name,
        modules_index,
    )
    _add_trivial_alias_bindings(table, file_path, repo_root)

    return table


def resolve_call(
    callee_expr: str,
    name_table: NameTable,
    modules_index: ModulesIndex,
) -> tuple[ResolvedTo | None, ResolvedTo | None, str | None, str, int]:
    """Resolve call expression against a module name table.

    Returns (resolved_to, resolved_base_to, member, strategy, confidence).
    """
    expr = callee_expr.strip()
    if not expr:
        return None, None, None, "dynamic_unresolvable", 0

    direct = name_table.get(expr)
    if direct is not None:
        resolved = _binding_to_resolved(direct, modules_index)
        return resolved, None, None, direct.strategy, direct.confidence

    parts = expr.split(".")
    if len(parts) == 1:
        return None, None, None, "dynamic_unresolvable", 0

    module_to_path = _invert_modules_index(modules_index)

    prefix_index = -1
    prefix_binding: NameBinding | None = None
    for i in range(len(parts) - 1, 0, -1):
        prefix = ".".join(parts[:i])
        binding = name_table.get(prefix)
        if binding is not None:
            prefix_index = i
            prefix_binding = binding
            break

    if prefix_binding is None:
        return None, None, None, "dynamic_unresolvable", 0

    remaining_parts = parts[prefix_index:]
    assert remaining_parts

    current_module = prefix_binding.qualified_name
    consumed = 0
    for part in remaining_parts:
        candidate = f"{current_module}.{part}"
        if candidate not in module_to_path:
            break
        current_module = candidate
        consumed += 1

    base_binding = prefix_binding
    if consumed > 0:
        module_path = module_to_path[current_module]
        base_binding = NameBinding(
            local_name=".".join(parts[: prefix_index + consumed]),
            target_symbol_id=f"module:{module_path}",
            qualified_name=current_module,
            resolution="module",
            confidence=_STRATEGY_CONFIDENCE["module_import_module"],
            strategy="module_import_module",
            target_path=module_path,
            target_module=current_module,
        )

    unresolved_tail = remaining_parts[consumed:]
    if not unresolved_tail:
        resolved = _binding_to_resolved(base_binding, modules_index)
        return resolved, None, None, base_binding.strategy, base_binding.confidence

    return (
        None,
        _binding_to_resolved(base_binding, modules_index),
        ".".join(unresolved_tail),
        base_binding.strategy,
        base_binding.confidence,
    )


@dataclass(frozen=True)
class ClassContext:
    """Enclosing class context for Tier 2 class-method resolution."""

    class_qualified_name: str
    class_symbol_id: str
    class_path: str
    class_module: str


def _find_enclosing_class(
    enclosing_symbol_id: str | None,
    symbols_index: SymbolsIndex,
) -> ClassContext | None:
    """Determine the enclosing class from an enclosing_symbol_id.

    Walks the symbols index to find a class symbol whose qualified_name
    is a prefix of the enclosing method's qualified_name.
    """
    if not enclosing_symbol_id:
        return None

    # enclosing_symbol_id is like "sym:path::module.Class.method@L...:C..."
    # Extract the qualified_name portion
    if not enclosing_symbol_id.startswith("sym:"):
        return None

    # Format: sym:{path}::{qualified_name}@L{line}:C{col}
    after_sym = enclosing_symbol_id[4:]  # strip "sym:"
    double_colon_pos = after_sym.find("::")
    if double_colon_pos < 0:
        return None
    qname_and_loc = after_sym[double_colon_pos + 2 :]
    at_pos = qname_and_loc.find("@")
    if at_pos < 0:
        return None
    enclosing_qname = qname_and_loc[:at_pos]

    # Walk up qualified name parts to find a class
    parts = enclosing_qname.rsplit(".", 1)
    if len(parts) < 2:
        return None

    # The enclosing class qualified_name would be the parent
    candidate_class_qname = parts[0]

    for _module_name, symbols in symbols_index.items():
        for symbol in symbols:
            if (
                symbol.qualified_name == candidate_class_qname
                and symbol.kind == "class"
            ):
                module_name = _module_name
                return ClassContext(
                    class_qualified_name=symbol.qualified_name,
                    class_symbol_id=symbol.symbol_id,
                    class_path=symbol.path,
                    class_module=module_name,
                )

    return None


def _find_method_in_class(
    class_qname: str,
    method_name: str,
    symbols_index: SymbolsIndex,
) -> SymbolInfo | None:
    """Find a method symbol within a class by qualified name prefix."""
    target_qname = f"{class_qname}.{method_name}"
    for symbols in symbols_index.values():
        for symbol in symbols:
            if symbol.qualified_name == target_qname and symbol.kind == "method":
                return symbol
    return None


def _find_class_by_qname(
    class_qname: str,
    symbols_index: SymbolsIndex,
) -> SymbolInfo | None:
    """Find a class symbol by its qualified name."""
    for symbols in symbols_index.values():
        for symbol in symbols:
            if symbol.qualified_name == class_qname and symbol.kind == "class":
                return symbol
    return None


def _resolve_base_class_qname(
    base_name: str,
    class_module: str,
    name_table: NameTable,
    symbols_index: SymbolsIndex,
) -> str | None:
    """Resolve a base class name to a qualified name.

    The base_name is as written in source (e.g., 'Base', 'pkg.Base').
    First tries the name table (handles imports), then tries module-local lookup.
    """
    binding = name_table.get(base_name)
    if binding is not None:
        return binding.qualified_name

    # Try as a simple name in the same module
    candidate = f"{class_module}.{base_name}"
    for symbols in symbols_index.values():
        for symbol in symbols:
            if symbol.qualified_name == candidate and symbol.kind == "class":
                return candidate

    return None


def resolve_call_class_context(
    callee_expr: str,
    enclosing_symbol_id: str | None,
    name_table: NameTable,
    modules_index: ModulesIndex,
    symbols_index: SymbolsIndex,
) -> tuple[ResolvedTo | None, ResolvedTo | None, str | None, str, int] | None:
    """Tier 2: resolve class-context call patterns.

    Handles:
    - self.method() → enclosing class method (virtual/overridable)
    - cls.method() → enclosing class method (classmethod context)
    - super().method() → base class method (when single base is identifiable)
    - ClassName.method() → class method when ClassName resolves to a known class

    Returns (resolved_to, resolved_base_to, member, strategy, confidence) or
    None if this function does not handle the expression.
    """
    expr = callee_expr.strip()
    if not expr:
        return None

    parts = expr.split(".")
    if len(parts) < 2:
        # Check for ClassName.method() via name_table — ClassName must resolve
        # to a class. But single-part exprs are not class-context patterns.
        return None

    receiver = parts[0]

    # --- self.method() ---
    if receiver == "self" and len(parts) == 2:
        method_name = parts[1]
        class_ctx = _find_enclosing_class(enclosing_symbol_id, symbols_index)
        if class_ctx is None:
            return None

        method_symbol = _find_method_in_class(
            class_ctx.class_qualified_name, method_name, symbols_index
        )
        if method_symbol is not None:
            strategy = "class_self_method"
            confidence = _STRATEGY_CONFIDENCE[strategy]
            return (
                ResolvedTo(
                    symbol_id=method_symbol.symbol_id,
                    qualified_name=method_symbol.qualified_name,
                    resolution="method",
                    confidence=confidence,
                    path=method_symbol.path,
                    dst_module=modules_index.get(method_symbol.path),
                ),
                None,
                None,
                strategy,
                confidence,
            )

        # Method not found on class — partial resolution to the class
        strategy = "class_self_method"
        confidence = _STRATEGY_CONFIDENCE[strategy]
        class_symbol = _find_class_by_qname(
            class_ctx.class_qualified_name, symbols_index
        )
        if class_symbol is not None:
            return (
                None,
                ResolvedTo(
                    symbol_id=class_symbol.symbol_id,
                    qualified_name=class_symbol.qualified_name,
                    resolution="class",
                    confidence=confidence,
                    path=class_symbol.path,
                    dst_module=modules_index.get(class_symbol.path),
                ),
                method_name,
                strategy,
                confidence,
            )

        return None

    # --- cls.method() ---
    if receiver == "cls" and len(parts) == 2:
        method_name = parts[1]
        class_ctx = _find_enclosing_class(enclosing_symbol_id, symbols_index)
        if class_ctx is None:
            return None

        method_symbol = _find_method_in_class(
            class_ctx.class_qualified_name, method_name, symbols_index
        )
        if method_symbol is not None:
            strategy = "class_cls_method"
            confidence = _STRATEGY_CONFIDENCE[strategy]
            return (
                ResolvedTo(
                    symbol_id=method_symbol.symbol_id,
                    qualified_name=method_symbol.qualified_name,
                    resolution="method",
                    confidence=confidence,
                    path=method_symbol.path,
                    dst_module=modules_index.get(method_symbol.path),
                ),
                None,
                None,
                strategy,
                confidence,
            )

        # Partial resolution
        strategy = "class_cls_method"
        confidence = _STRATEGY_CONFIDENCE[strategy]
        class_symbol = _find_class_by_qname(
            class_ctx.class_qualified_name, symbols_index
        )
        if class_symbol is not None:
            return (
                None,
                ResolvedTo(
                    symbol_id=class_symbol.symbol_id,
                    qualified_name=class_symbol.qualified_name,
                    resolution="class",
                    confidence=confidence,
                    path=class_symbol.path,
                    dst_module=modules_index.get(class_symbol.path),
                ),
                method_name,
                strategy,
                confidence,
            )

        return None

    # --- super().method() ---
    if receiver == "super()" and len(parts) == 2:
        method_name = parts[1]
        class_ctx = _find_enclosing_class(enclosing_symbol_id, symbols_index)
        if class_ctx is None:
            return None

        # Find the class to get base_classes
        class_symbol = _find_class_by_qname(
            class_ctx.class_qualified_name, symbols_index
        )
        if class_symbol is None or not class_symbol.base_classes:
            return None

        # Only resolve when there is exactly one base class
        # (multiple inheritance makes super() MRO-dependent)
        if len(class_symbol.base_classes) != 1:
            return None

        base_name = class_symbol.base_classes[0]
        base_qname = _resolve_base_class_qname(
            base_name,
            class_ctx.class_module,
            name_table,
            symbols_index,
        )
        if base_qname is None:
            return None

        base_method = _find_method_in_class(base_qname, method_name, symbols_index)
        if base_method is not None:
            strategy = "class_super_method"
            confidence = _STRATEGY_CONFIDENCE[strategy]
            return (
                ResolvedTo(
                    symbol_id=base_method.symbol_id,
                    qualified_name=base_method.qualified_name,
                    resolution="method",
                    confidence=confidence,
                    path=base_method.path,
                    dst_module=modules_index.get(base_method.path),
                ),
                None,
                None,
                strategy,
                confidence,
            )

        # Partial resolution to the base class
        base_class_symbol = _find_class_by_qname(base_qname, symbols_index)
        if base_class_symbol is not None:
            strategy = "class_super_method"
            confidence = _STRATEGY_CONFIDENCE[strategy]
            return (
                None,
                ResolvedTo(
                    symbol_id=base_class_symbol.symbol_id,
                    qualified_name=base_class_symbol.qualified_name,
                    resolution="class",
                    confidence=confidence,
                    path=base_class_symbol.path,
                    dst_module=modules_index.get(base_class_symbol.path),
                ),
                method_name,
                strategy,
                confidence,
            )

        return None

    # --- ClassName.method() ---
    # Check if the receiver resolves to a class via the name table
    binding = name_table.get(receiver)
    if binding is not None and binding.resolution == "class" and len(parts) == 2:
        method_name = parts[1]
        class_qname = binding.qualified_name

        method_symbol = _find_method_in_class(class_qname, method_name, symbols_index)
        if method_symbol is not None:
            strategy = "class_static_method"
            confidence = _STRATEGY_CONFIDENCE[strategy]
            return (
                ResolvedTo(
                    symbol_id=method_symbol.symbol_id,
                    qualified_name=method_symbol.qualified_name,
                    resolution="method",
                    confidence=confidence,
                    path=method_symbol.path,
                    dst_module=modules_index.get(method_symbol.path),
                ),
                None,
                None,
                strategy,
                confidence,
            )

        # Partial: class resolves but method doesn't
        if binding.target_symbol_id:
            strategy = "class_static_method"
            confidence = _STRATEGY_CONFIDENCE[strategy]
            return (
                None,
                _binding_to_resolved(binding, modules_index),
                method_name,
                strategy,
                confidence,
            )

    return None


__all__ = [
    "ClassContext",
    "ModulesIndex",
    "NameBinding",
    "NameTable",
    "SymbolInfo",
    "SymbolsIndex",
    "build_modules_index",
    "build_name_table",
    "build_symbols_index",
    "resolve_call",
    "resolve_call_class_context",
]
