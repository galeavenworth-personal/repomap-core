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

    def __init__(self, root: Path, out_dir: Path) -> None:
        self.root = root
        self.out_dir = out_dir

    def generate(self, **kwargs: Any) -> str:
        """Generate modules artifact."""
        include_patterns: list[str] | None = kwargs.get("include_patterns")
        exclude_patterns: list[str] | None = kwargs.get("exclude_patterns")
        nested_gitignore: bool = kwargs.get("nested_gitignore", False)

        self.out_dir.mkdir(parents=True, exist_ok=True)

        out_dir_name = _get_output_dir_name(self.out_dir, self.root)

        records: list[dict[str, str | bool]] = []
        for file_path in find_python_files(
            self.root,
            output_dir=out_dir_name,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            nested_gitignore=nested_gitignore,
        ):
            relative_path = file_path.relative_to(self.root).as_posix()
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

        _write_jsonl(self.out_dir / MODULES_JSONL, records)

        return MODULES_JSONL


__all__ = ["MODULES_JSONL", "ModulesGenerator"]
