"""Summary builders for artifact generation."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from artifacts.models.artifacts.dependencies import LayerViolation
    from rules.config import LayersConfig


def compute_fan_stats(
    edges: list[tuple[str, str]],
) -> tuple[dict[str, int], dict[str, int]]:
    """Compute fan-in and fan-out statistics from edges."""
    fan_in: dict[str, int] = {}
    fan_out: dict[str, int] = {}

    for source, target in edges:
        fan_out[source] = fan_out.get(source, 0) + 1
        fan_in[target] = fan_in.get(target, 0) + 1

    return fan_in, fan_out


def compute_layer_violations(
    edges: list[tuple[str, str]],
    layers_config: LayersConfig,
    module_to_path: dict[str, str],
) -> list[LayerViolation]:
    """Compute layer violations from dependency edges."""
    from artifacts.models.artifacts.dependencies import LayerViolation
    from rules.layers import (
        build_allowed_deps,
        classify_layer,
        is_violation,
    )

    if not layers_config.layer or not layers_config.rules:
        return []

    allowed_deps = build_allowed_deps(layers_config)
    violations: list[LayerViolation] = []

    for source_module, target_module in edges:
        source_path = module_to_path.get(source_module)
        if source_path is None:
            continue

        from_layer = classify_layer(source_path, layers_config)

        to_layer: str | None = None
        target_path = module_to_path.get(target_module)
        if target_path is not None:
            to_layer = classify_layer(target_path, layers_config)

        if from_layer is not None and is_violation(
            from_layer, to_layer, allowed_deps, layers_config.unclassified
        ):
            violations.append(
                LayerViolation(
                    from_file=source_path,
                    to_module=target_module,
                    from_layer=from_layer,
                    to_layer=to_layer,
                )
            )

    violations.sort(
        key=lambda v: (v.from_file, v.to_module, v.from_layer, v.to_layer or "")
    )
    return violations
