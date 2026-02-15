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

        symbol = SymbolInfo(
            symbol_id=symbol_id_obj,
            qualified_name=qualified_name_obj,
            name=name_obj,
            kind=kind_obj,
            path=path,
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


__all__ = [
    "ModulesIndex",
    "NameBinding",
    "NameTable",
    "SymbolInfo",
    "SymbolsIndex",
    "build_modules_index",
    "build_name_table",
    "build_symbols_index",
    "resolve_call",
]
