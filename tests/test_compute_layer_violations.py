from __future__ import annotations

from artifacts.summaries import compute_layer_violations
from rules.config import LayersConfig


def _layers_config(
    *,
    layer: list[dict[str, object]],
    rules: list[dict[str, object]],
    unclassified: str = "allow",
) -> LayersConfig:
    return LayersConfig.model_validate(
        {
            "layer": layer,
            "rules": rules,
            "unclassified": unclassified,
        }
    )


def test_compute_layer_violations_guard_returns_empty_without_layers_or_rules() -> None:
    edges = [("pkg.ui", "pkg.core")]
    module_to_path = {
        "pkg.ui": "src/ui/view.py",
        "pkg.core": "src/core/engine.py",
    }

    config_no_layers = _layers_config(
        layer=[],
        rules=[{"from": "interface", "to": ["foundation"]}],
    )
    config_no_rules = _layers_config(
        layer=[
            {"name": "foundation", "globs": ["src/core/**"]},
            {"name": "interface", "globs": ["src/ui/**"]},
        ],
        rules=[],
    )

    assert compute_layer_violations(edges, config_no_layers, module_to_path) == []
    assert compute_layer_violations(edges, config_no_rules, module_to_path) == []


def test_compute_layer_violations_skips_edge_when_source_module_has_no_path() -> None:
    config = _layers_config(
        layer=[
            {"name": "foundation", "globs": ["src/core/**"]},
            {"name": "interface", "globs": ["src/ui/**"]},
            {"name": "integration", "globs": ["src/integrations/**"]},
        ],
        rules=[{"from": "interface", "to": ["foundation"]}],
    )

    edges = [("pkg.ui", "pkg.int")]
    module_to_path = {
        # source intentionally absent: "pkg.ui"
        "pkg.int": "src/integrations/client.py",
    }

    violations = compute_layer_violations(edges, config, module_to_path)

    assert violations == []


def test_compute_layer_violations_does_not_report_unclassified_sources_even_if_unclassified_deny() -> (
    None
):
    config = _layers_config(
        layer=[
            {"name": "foundation", "globs": ["src/core/**"]},
            {"name": "interface", "globs": ["src/ui/**"]},
        ],
        rules=[{"from": "interface", "to": ["foundation"]}],
        unclassified="deny",
    )

    edges = [("pkg.misc", "pkg.unknown")]
    module_to_path = {
        "pkg.misc": "scripts/tool.py",  # unclassified source
        # target intentionally missing path -> to_layer None
    }

    violations = compute_layer_violations(edges, config, module_to_path)

    assert violations == []


def test_compute_layer_violations_reports_violation_and_sorts_deterministically() -> (
    None
):
    config = _layers_config(
        layer=[
            {"name": "foundation", "globs": ["src/core/**"]},
            {"name": "interface", "globs": ["src/ui/**"]},
            {"name": "integration", "globs": ["src/integrations/**"]},
        ],
        rules=[
            {"from": "interface", "to": ["foundation"]},
            {"from": "integration", "to": ["foundation"]},
        ],
    )

    module_to_path = {
        "pkg.z_ui": "src/ui/z_view.py",
        "pkg.a_ui": "src/ui/a_view.py",
        "pkg.int": "src/integrations/client.py",
        "pkg.misc": "tools/misc.py",  # unclassified target
    }

    edges = [
        ("pkg.z_ui", "pkg.int"),  # interface -> integration (violation)
        (
            "pkg.int",
            "pkg.misc",
        ),  # integration -> unclassified target (allowed with unclassified="allow")
        ("pkg.a_ui", "pkg.int"),  # interface -> integration (violation)
    ]

    violations = compute_layer_violations(edges, config, module_to_path)

    assert [
        (v.from_file, v.to_module, v.from_layer, v.to_layer) for v in violations
    ] == [
        ("src/ui/a_view.py", "pkg.int", "interface", "integration"),
        ("src/ui/z_view.py", "pkg.int", "interface", "integration"),
    ]
