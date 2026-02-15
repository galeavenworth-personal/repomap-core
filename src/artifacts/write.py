from __future__ import annotations

from typing import TYPE_CHECKING

from artifacts.generators import (
    CallsGenerator,
    CallsRawGenerator,
    DepsGenerator,
    IntegrationsGenerator,
    ModulesGenerator,
    RefsGenerator,
    SymbolsGenerator,
)
from artifacts.models.artifacts.calls import CallRecord
from artifacts.models.artifacts.dependencies import DepsSummary
from artifacts.models.artifacts.integrations import IntegrationRecord
from artifacts.models.artifacts.refs import RefRecord
from artifacts.models.artifacts.symbols import SymbolRecord
from contract.artifacts import (
    CALLS_JSONL,
    CALLS_RAW_JSONL,
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    MODULES_JSONL,
    REFS_JSONL,
    SYMBOLS_JSONL,
)
from rules.config import load_config, resolve_output_dir

if TYPE_CHECKING:
    from pathlib import Path

    from rules.config import RepoMapConfig


def generate_all_artifacts(
    *,
    root: Path,
    out_dir: Path | None = None,
    config: RepoMapConfig | None = None,
) -> dict[str, object]:
    """Generate Tier-1 deterministic artifacts for a repository.

    Args:
        root: Root directory of the repository to analyze
        out_dir: Optional output directory for generated artifacts
        config: Optional configuration for layer rules and other settings

    Returns:
        Dictionary with counts and list of generated artifact paths.
    """
    if config is None:
        config = load_config(root)

    if out_dir is None:
        out_dir = resolve_output_dir(root, config.output_dir)

    layers_config = config.layers if config else None
    include_patterns = config.include if config else None
    exclude_patterns = config.exclude if config else None
    nested_gitignore = config.nested_gitignore if config else False

    symbols_gen = SymbolsGenerator()
    symbol_dicts, _ = symbols_gen.generate(
        root=root,
        out_dir=out_dir,
        layers_config=layers_config,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        nested_gitignore=nested_gitignore,
    )
    symbols = [SymbolRecord(**d) for d in symbol_dicts]

    modules_gen = ModulesGenerator()
    modules_gen.generate(
        root=root,
        out_dir=out_dir,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        nested_gitignore=nested_gitignore,
    )

    deps_gen = DepsGenerator()
    _, deps_summary_dict = deps_gen.generate(
        root=root,
        out_dir=out_dir,
        layers_config=layers_config,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        nested_gitignore=nested_gitignore,
    )
    deps_summary = DepsSummary(**deps_summary_dict)

    integrations_gen = IntegrationsGenerator()
    integration_dicts, _ = integrations_gen.generate(
        root=root,
        out_dir=out_dir,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        integration_tags=(config.integration_tags if config else None),
        nested_gitignore=nested_gitignore,
    )
    integrations = [IntegrationRecord(**d) for d in integration_dicts]

    calls_raw_gen = CallsRawGenerator()
    calls_raw_gen.generate(
        root=root,
        out_dir=out_dir,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        nested_gitignore=nested_gitignore,
    )

    refs_gen = RefsGenerator()
    ref_dicts, _ = refs_gen.generate(
        root=root,
        out_dir=out_dir,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        nested_gitignore=nested_gitignore,
    )
    [RefRecord(**d) for d in ref_dicts]

    calls_gen = CallsGenerator()
    call_dicts, _ = calls_gen.generate(
        root=root,
        out_dir=out_dir,
        include_patterns=include_patterns,
        exclude_patterns=exclude_patterns,
        nested_gitignore=nested_gitignore,
    )
    [CallRecord(**d) for d in call_dicts]

    artifacts_list = [
        SYMBOLS_JSONL,
        MODULES_JSONL,
        DEPS_EDGELIST,
        DEPS_SUMMARY_JSON,
        INTEGRATIONS_STATIC_JSONL,
        CALLS_RAW_JSONL,
        REFS_JSONL,
        CALLS_JSONL,
    ]

    return {
        "symbol_count": len(symbols),
        "edge_count": deps_summary.edge_count,
        "node_count": deps_summary.node_count,
        "cycle_count": len(deps_summary.cycles),
        "top_modules_count": len(deps_summary.top_modules),
        "integration_count": len(integrations),
        "artifacts": [str(out_dir / name) for name in artifacts_list],
    }
