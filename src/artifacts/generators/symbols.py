"""Symbols artifact generator."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from artifacts.utils import _get_output_dir_name, _write_jsonl
from parse.treesitter_symbols import extract_symbols_treesitter
from rules.layers import classify_layer
from scan.files import find_python_files
from utils import path_to_module

if TYPE_CHECKING:
    from pathlib import Path

    from artifacts.models.artifacts.symbols import SymbolRecord
    from rules.config import LayersConfig

from contract.artifacts import SYMBOLS_JSONL


class SymbolsGenerator:
    """Generates symbols.jsonl artifact from Python source files."""

    @property
    def name(self) -> str:
        """Generator name for logging and identification."""
        return "symbols"

    def generate(
        self,
        root: Path,
        out_dir: Path,
        **kwargs: Any,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Generate symbols artifact."""
        layers_config: LayersConfig | None = kwargs.get("layers_config")
        include_patterns: list[str] | None = kwargs.get("include_patterns")
        exclude_patterns: list[str] | None = kwargs.get("exclude_patterns")

        out_dir.mkdir(parents=True, exist_ok=True)

        all_symbols: list[SymbolRecord] = []

        out_dir_name = _get_output_dir_name(out_dir, root)

        for file_path in find_python_files(
            root,
            output_dir=out_dir_name,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
        ):
            relative_path = file_path.relative_to(root).as_posix()
            module_name = path_to_module(relative_path)
            symbols = extract_symbols_treesitter(file_path, relative_path, module_name)

            layer = None
            if layers_config and layers_config.layer:
                layer = classify_layer(relative_path, layers_config)

            for symbol in symbols:
                symbol.layer = layer
                all_symbols.append(symbol)

        all_symbols.sort(key=lambda s: (s.path, s.start_line, s.start_col))

        _write_jsonl(out_dir / SYMBOLS_JSONL, all_symbols)

        symbol_dicts = [s.model_dump() for s in all_symbols]

        return symbol_dicts, {}
