"""Layer classification and violation detection."""

from __future__ import annotations

from fnmatch import fnmatch
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from rules.config import LayersConfig

UnclassifiedBehavior = Literal["allow", "deny", "ignore"]


def classify_layer(path: str, layers_config: LayersConfig) -> str | None:
    """Classify a file path into an architectural layer.

    Uses first-match-wins semantics: the first layer definition whose
    glob patterns match the path determines the layer.
    """
    for layer_def in layers_config.layer:
        for glob_pattern in layer_def.globs:
            if fnmatch(path, glob_pattern):
                return layer_def.name
    return None


def build_allowed_deps(layers_config: LayersConfig) -> dict[str, set[str]]:
    """Build a mapping of layer -> set of allowed dependency layers."""
    allowed: dict[str, set[str]] = {}
    for rule in layers_config.rules:
        allowed[rule.from_layer] = set(rule.to)
    return allowed


def is_violation(
    from_layer: str | None,
    to_layer: str | None,
    allowed_deps: dict[str, set[str]],
    unclassified: UnclassifiedBehavior,
) -> bool:
    """Check if a dependency from one layer to another is a violation."""
    if from_layer is None or to_layer is None:
        if unclassified in {"allow", "ignore"}:
            return False
        return from_layer is not None

    if from_layer not in allowed_deps:
        return False

    return to_layer not in allowed_deps[from_layer]
