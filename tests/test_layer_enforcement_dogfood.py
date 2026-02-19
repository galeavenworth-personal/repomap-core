from __future__ import annotations

from pathlib import Path

from rules.config import load_config
from rules.layers import build_allowed_deps, classify_layer, is_violation


def test_load_real_config_has_expected_layers() -> None:
    config = load_config(Path("."))

    layer_names = {layer.name for layer in config.layers.layer}

    assert layer_names == {"foundation", "verification", "interface"}
    assert len(config.layers.rules) == 3
    assert config.layers.unclassified == "allow"


def test_sentinel_file_classification() -> None:
    config = load_config(Path("."))

    assert classify_layer("src/cli.py", config.layers) == "interface"
    assert classify_layer("src/verify/verify.py", config.layers) == "verification"
    assert classify_layer("src/rules/config.py", config.layers) == "foundation"
    assert classify_layer("src/utils.py", config.layers) == "foundation"
    assert classify_layer("src/contract/__init__.py", config.layers) == "foundation"


def test_every_layer_has_rule_entry() -> None:
    """Every layer defined in config must have an explicit rule entry.

    Uses equality (==) not subset check, so a new layer added without
    a corresponding rule will fail this test.
    """
    config = load_config(Path("."))

    layer_names = {layer.name for layer in config.layers.layer}
    allowed_deps = build_allowed_deps(config.layers)

    assert layer_names == set(allowed_deps.keys())
    assert allowed_deps["foundation"] == {"foundation"}


def test_all_src_files_classified() -> None:
    config = load_config(Path("."))

    unclassified_files = [
        path.as_posix()
        for path in Path("src").rglob("*.py")
        if classify_layer(path.as_posix(), config.layers) is None
    ]

    assert unclassified_files == []


def test_violation_detection_with_real_config() -> None:
    """Exercise is_violation() with real config — closes Phase 3 showstopper.

    Tests the actual enforcement code path that was previously untested:
    - foundation -> interface: VIOLATION (foundation depends on nothing)
    - interface -> foundation: ALLOWED (interface may depend on foundation)
    - foundation -> (unclassified): NOT a violation (unclassified="allow")
    """
    config = load_config(Path("."))
    allowed_deps = build_allowed_deps(config.layers)
    unclassified = config.layers.unclassified

    # foundation importing from interface is a violation
    assert is_violation("foundation", "interface", allowed_deps, unclassified) is True

    # interface importing from foundation is allowed
    assert is_violation("interface", "foundation", allowed_deps, unclassified) is False

    # foundation importing from verification is a violation
    assert (
        is_violation("foundation", "verification", allowed_deps, unclassified) is True
    )

    # verification importing from foundation is allowed
    assert (
        is_violation("verification", "foundation", allowed_deps, unclassified) is False
    )

    # same-layer import within foundation is allowed (foundation to=["foundation"])
    assert is_violation("foundation", "foundation", allowed_deps, unclassified) is False

    # unclassified source layer -> any target: not a violation when allow mode
    assert is_violation(None, "foundation", allowed_deps, unclassified) is False
