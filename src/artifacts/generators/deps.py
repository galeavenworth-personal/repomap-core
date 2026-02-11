"""Dependency graph generator for repomap_core artifacts."""

from __future__ import annotations

from pathlib import Path  # noqa: TC003
from typing import TYPE_CHECKING, Any

from artifacts.models.artifacts.dependencies import (
    DepsSummary,
    LayerViolation,
)
from artifacts.summaries.builders import (
    compute_fan_stats,
    compute_layer_violations,
)
from artifacts.utils import _get_output_dir_name, _write_json
from contract.artifacts import DEPS_EDGELIST, DEPS_SUMMARY_JSON
from graph.algos import find_cycles
from parse.ast_imports import extract_imports, resolve_relative_import
from scan.files import find_python_files
from utils import path_to_module

if TYPE_CHECKING:
    from rules.config import LayersConfig


def _extract_edges_from_file(
    file_path: Path,
    root: Path,
) -> list[tuple[str, str]]:
    """Extract dependency edges from a single Python file."""
    relative_path = file_path.relative_to(root).as_posix()
    source_module = path_to_module(relative_path)
    imports = extract_imports(file_path)

    edges: list[tuple[str, str]] = []

    for _line, module, _alias, _level in imports["import"]:
        edges.append((source_module, module))

    for _line, module, _name, _level in imports["import_from"]:
        if module:
            edges.append((source_module, module))

    for _line, module, _name, _level in imports["import_star"]:
        if module:
            edges.append((source_module, module))

    for _line, module, name, level in imports["relative_import"]:
        target_module = module if module else name.split()[0]
        resolved = resolve_relative_import(source_module, target_module, level=level)
        edges.append((source_module, resolved))

    return edges


class DepsGenerator:
    """Generator for dependency graph artifacts."""

    @property
    def name(self) -> str:
        """Generator name for logging and identification."""
        return "deps"

    def generate(
        self,
        root: Path,
        out_dir: Path,
        **kwargs: Any,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Generate deps.edgelist and deps_summary.json from all Python files."""
        top_n: int = kwargs.get("top_n", 10)
        layers_config: LayersConfig | None = kwargs.get("layers_config")
        include_patterns: list[str] | None = kwargs.get("include_patterns")
        exclude_patterns: list[str] | None = kwargs.get("exclude_patterns")
        nested_gitignore: bool = kwargs.get("nested_gitignore", False)

        out_dir.mkdir(parents=True, exist_ok=True)

        out_dir_name = _get_output_dir_name(out_dir, root)

        all_edges: list[tuple[str, str]] = []
        module_to_path: dict[str, str] = {}
        for file_path in find_python_files(
            root,
            output_dir=out_dir_name,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            nested_gitignore=nested_gitignore,
        ):
            relative_path = file_path.relative_to(root).as_posix()
            source_module = path_to_module(relative_path)
            module_to_path[source_module] = relative_path
            edges = _extract_edges_from_file(file_path, root)
            all_edges.extend(edges)

        unique_edges = sorted(set(all_edges))

        graph: dict[str, set[str]] = {}
        for source, target in unique_edges:
            if source not in graph:
                graph[source] = set()
            if target not in graph:
                graph[target] = set()
            graph[source].add(target)

        cycles = find_cycles(graph)
        sorted_cycles = [sorted(cycle) for cycle in cycles]
        sorted_cycles.sort()

        fan_in, fan_out = compute_fan_stats(unique_edges)

        all_nodes = set(module_to_path)
        for source, target in unique_edges:
            all_nodes.add(source)
            all_nodes.add(target)

        top_modules = sorted(fan_in.keys(), key=lambda m: (-fan_in[m], m))[:top_n]

        layer_violations: list[LayerViolation] = []
        if layers_config:
            layer_violations = compute_layer_violations(
                unique_edges, layers_config, module_to_path
            )

        edgelist_path = out_dir / DEPS_EDGELIST
        with edgelist_path.open("w", encoding="utf-8") as f:
            for source, target in unique_edges:
                f.write(f"{source} -> {target}\n")

        summary = DepsSummary(
            node_count=len(all_nodes),
            edge_count=len(unique_edges),
            cycles=sorted_cycles,
            fan_in=dict(sorted(fan_in.items())),
            fan_out=dict(sorted(fan_out.items())),
            top_modules=top_modules,
            layer_violations=layer_violations,
        )
        _write_json(out_dir / DEPS_SUMMARY_JSON, summary)

        return [], summary.model_dump()


__all__ = [
    "DEPS_EDGELIST",
    "DEPS_SUMMARY_JSON",
    "DepsGenerator",
    "_extract_edges_from_file",
]
