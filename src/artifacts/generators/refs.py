"""Resolved references artifact generator."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from artifacts.models.artifacts.refs import RefEvidence, RefRecord, SourceSpan
from artifacts.utils import _get_output_dir_name, _write_jsonl
from contract.artifacts import CALLS_RAW_JSONL, MODULES_JSONL, REFS_JSONL, SYMBOLS_JSONL
from parse.ast_imports import extract_imports
from parse.name_resolution import (
    build_modules_index,
    build_name_table,
    build_symbols_index,
    resolve_call,
)
from scan.files import find_python_files

_RAW_ENCLOSING_PATTERN = re.compile(
    r"^(?:symbol:|module:)(?P<path>.+?)@L(?P<line>\d+):C(?P<col>\d+)$"
)


def _normalize_enclosing_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def _candidate_coordinates(line: int, col: int) -> list[tuple[int, int]]:
    candidates: list[tuple[int, int]] = []
    for candidate in [
        (line, col),
        (line, col - 1),
        (line - 1, col),
        (line - 1, col - 1),
        (line, col + 1),
        (line + 1, col),
        (line + 1, col + 1),
    ]:
        if candidate[0] < 1 or candidate[1] < 1:
            continue
        if candidate in candidates:
            continue
        candidates.append(candidate)
    return candidates


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    """Load records from a JSONL file."""
    records: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def _build_symbols_by_span(
    symbol_records: list[dict[str, Any]],
) -> dict[tuple[str, int, int], str]:
    """Build (path, line, col) -> canonical symbol_id lookup from symbols.jsonl."""
    symbols_by_span: dict[tuple[str, int, int], str] = {}
    for record in symbol_records:
        path = record.get("path")
        start_line = record.get("start_line")
        start_col = record.get("start_col")
        symbol_id = record.get("symbol_id")

        if not isinstance(path, str):
            continue
        if not isinstance(start_line, int) or not isinstance(start_col, int):
            continue
        if not isinstance(symbol_id, str):
            continue

        symbols_by_span[(_normalize_enclosing_path(path), start_line, start_col)] = (
            symbol_id
        )

    return symbols_by_span


def _canonicalize_enclosing_id(
    raw_id: str | None,
    symbols_by_span: dict[tuple[str, int, int], str],
) -> str | None:
    """Canonicalize legacy enclosing symbol IDs to sym:* IDs when possible."""
    if not isinstance(raw_id, str) or not raw_id:
        return None

    match = _RAW_ENCLOSING_PATTERN.match(raw_id)
    if not match:
        return raw_id

    path = _normalize_enclosing_path(match.group("path"))
    if raw_id.startswith("symbol:") and ":" in path:
        candidate_path, _symbol_name = path.rsplit(":", 1)
        if "/" in candidate_path or candidate_path.endswith(".py"):
            path = candidate_path
    line = int(match.group("line"))
    col = int(match.group("col"))
    for candidate_line, candidate_col in _candidate_coordinates(line, col):
        canonical = symbols_by_span.get((path, candidate_line, candidate_col))
        if canonical is not None:
            return canonical

    return raw_id


class RefsGenerator:
    """Generates refs.jsonl artifact from calls_raw + name-resolution indices."""

    @property
    def name(self) -> str:
        """Generator name for logging and identification."""
        return "refs"

    def generate(
        self,
        root: Path,
        out_dir: Path,
        **kwargs: Any,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Generate refs artifact."""
        include_patterns: list[str] | None = kwargs.get("include_patterns")
        exclude_patterns: list[str] | None = kwargs.get("exclude_patterns")
        nested_gitignore: bool = kwargs.get("nested_gitignore", False)

        out_dir.mkdir(parents=True, exist_ok=True)

        module_records = _load_jsonl(out_dir / MODULES_JSONL)
        symbol_records = _load_jsonl(out_dir / SYMBOLS_JSONL)
        calls_raw_records = _load_jsonl(out_dir / CALLS_RAW_JSONL)

        modules_index = build_modules_index(module_records)
        symbols_index = build_symbols_index(symbol_records, modules_index)
        symbols_by_span = _build_symbols_by_span(symbol_records)

        calls_by_path: dict[str, list[dict[str, Any]]] = {}
        for record in calls_raw_records:
            src_span_obj = record.get("src_span")
            if not isinstance(src_span_obj, dict):
                continue
            path = src_span_obj.get("path")
            if isinstance(path, str):
                calls_by_path.setdefault(path, []).append(record)

        out_dir_name = _get_output_dir_name(out_dir, root)
        refs: list[RefRecord] = []

        for file_path in find_python_files(
            root,
            output_dir=out_dir_name,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            nested_gitignore=nested_gitignore,
        ):
            relative_path = file_path.relative_to(root).as_posix()
            module_name = modules_index.get(relative_path)
            if module_name is None:
                continue

            imports = extract_imports(file_path)
            name_table = build_name_table(
                relative_path,
                modules_index,
                symbols_index,
                imports,
                repo_root=root,
            )

            for call_record in calls_by_path.get(relative_path, []):
                src_span_obj = call_record.get("src_span")
                callee_expr_obj = call_record.get("callee_expr")
                raw_enclosing_obj = call_record.get("enclosing_symbol_id")

                if not isinstance(src_span_obj, dict):
                    continue
                if not isinstance(callee_expr_obj, str):
                    continue

                callee_expr = callee_expr_obj.strip()
                if not callee_expr:
                    continue

                src_span = SourceSpan(**src_span_obj)

                (
                    resolved_to,
                    resolved_base_to,
                    member,
                    strategy,
                    confidence,
                ) = resolve_call(callee_expr, name_table, modules_index)

                enclosing_symbol_id = _canonicalize_enclosing_id(
                    raw_enclosing_obj if isinstance(raw_enclosing_obj, str) else None,
                    symbols_by_span,
                )

                refs.append(
                    RefRecord(
                        ref_id=(
                            f"ref:{src_span.path}"
                            f"@L{src_span.start_line}"
                            f":C{src_span.start_col}"
                            f":call:{callee_expr}"
                        ),
                        ref_kind="call",
                        src_span=src_span,
                        module=module_name,
                        enclosing_symbol_id=enclosing_symbol_id,
                        expr=callee_expr,
                        resolved_to=resolved_to,
                        evidence=RefEvidence(
                            strategy=strategy,
                            confidence=confidence,
                        ),
                        resolved_base_to=resolved_base_to,
                        member=member,
                    )
                )

        refs.sort(
            key=lambda record: (
                record.src_span.path,
                record.src_span.start_line,
                record.src_span.start_col,
                record.ref_kind,
                record.enclosing_symbol_id or "",
                record.expr,
            )
        )

        _write_jsonl(out_dir / REFS_JSONL, refs)

        ref_dicts = [record.model_dump() for record in refs]
        return ref_dicts, {}


__all__ = [
    "REFS_JSONL",
    "RefsGenerator",
    "_canonicalize_enclosing_id",
]
