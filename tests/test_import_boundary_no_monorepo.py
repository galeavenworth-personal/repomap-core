from __future__ import annotations

import sys


def test_cli_import_does_not_load_monorepo() -> None:
    before_modules = set(sys.modules)
    import cli  # noqa: F401

    newly_imported = set(sys.modules) - before_modules
    assert not any(
        name == "repomap" or name.startswith("repomap.") for name in newly_imported
    )
