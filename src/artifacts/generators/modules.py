"""Module identity artifact generator."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from artifacts.utils import _get_output_dir_name, _write_jsonl
from contract.artifacts import MODULES_JSONL
from scan.files import find_python_files
from utils import path_to_module


class ModulesGenerator:
    """Generates modules.jsonl artifact from Python source files."""

    @property
    def name(self) -> str:
        """Generator name for logging and identification."""
        return "modules"

    def generate(
        self,
        root: Path,
        out_dir: Path,
        include_patterns: list[str] | None = None,
        exclude_patterns: list[str] | None = None,
        nested_gitignore: bool = False,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Generate modules artifact."""
        out_dir.mkdir(parents=True, exist_ok=True)

        out_dir_name = _get_output_dir_name(out_dir, root)

        records: list[dict[str, str | bool]] = []
        for file_path in find_python_files(
            root,
            output_dir=out_dir_name,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            nested_gitignore=nested_gitignore,
        ):
            relative_path = file_path.relative_to(root).as_posix()
            module = path_to_module(relative_path)
            is_package = relative_path.endswith("__init__.py")
            package_root = "src" if relative_path.startswith("src/") else "."

            records.append(
                {
                    "path": relative_path,
                    "module": module,
                    "is_package": is_package,
                    "package_root": package_root,
                }
            )

        records.sort(key=lambda record: (record["path"],))

        _write_jsonl(out_dir / MODULES_JSONL, records)

        return records, {"count": len(records)}


__all__ = ["MODULES_JSONL", "ModulesGenerator"]
