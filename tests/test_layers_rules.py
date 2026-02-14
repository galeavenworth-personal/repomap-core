from __future__ import annotations

from rules.config import LayersConfig
from rules.layers import build_allowed_deps, classify_layer, is_violation


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


def test_classify_layer_first_match_wins_with_overlapping_globs() -> None:
    config = _layers_config(
        layer=[
            {"name": "A", "globs": ["src/**"]},
            {"name": "B", "globs": ["src/core/**"]},
        ],
        rules=[],
    )

    assert classify_layer("src/core/x.py", config) == "A"


def test_classify_layer_returns_none_when_no_glob_matches() -> None:
    config = _layers_config(
        layer=[{"name": "core", "globs": ["src/core/**"]}],
        rules=[],
    )

    assert classify_layer("tests/test_layers_rules.py", config) is None


def test_build_allowed_deps_overwrites_duplicate_from_layer_rule_last_wins() -> None:
    config = _layers_config(
        layer=[],
        rules=[
            {"from": "core", "to": ["foundation"]},
            {"from": "core", "to": ["interface"]},
        ],
    )

    assert build_allowed_deps(config) == {"core": {"interface"}}


def test_is_violation_unclassified_allow_no_violation_when_either_side_unclassified() -> (
    None
):
    allowed_deps = {"core": {"foundation"}}

    assert is_violation(None, "core", allowed_deps, "allow") is False
    assert is_violation("core", None, allowed_deps, "allow") is False


def test_is_violation_unclassified_ignore_behaves_like_allow_for_unclassified_edges() -> (
    None
):
    allowed_deps = {"core": {"foundation"}}

    assert is_violation(None, "core", allowed_deps, "ignore") is False
    assert is_violation("core", None, allowed_deps, "ignore") is False


def test_is_violation_unclassified_deny_is_asymmetric() -> None:
    allowed_deps = {"core": {"foundation"}}

    assert is_violation(None, "core", allowed_deps, "deny") is False
    assert is_violation("core", None, allowed_deps, "deny") is True


def test_is_violation_missing_from_layer_rule_is_permissive() -> None:
    allowed_deps = {"core": {"foundation"}}

    assert is_violation("unknown", "ui", allowed_deps, "allow") is False


def test_is_violation_detects_disallowed_dependency_when_rule_present() -> None:
    allowed_deps = {"core": {"foundation"}}

    assert is_violation("core", "ui", allowed_deps, "allow") is True
