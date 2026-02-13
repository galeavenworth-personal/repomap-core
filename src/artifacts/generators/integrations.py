"""Integration detection generator."""

from __future__ import annotations

from pathlib import Path  # noqa: TC003
from typing import TYPE_CHECKING, Any

from artifacts.models.artifacts.integrations import IntegrationRecord
from artifacts.utils import (
    _get_integration_tag,
    _get_output_dir_name,
    _write_jsonl,
)
from contract.artifacts import INTEGRATIONS_STATIC_JSONL
from parse.ast_imports import extract_imports
from scan.files import find_python_files

if TYPE_CHECKING:
    from artifacts.models.artifacts.integrations import IntegrationTag


def _extract_integrations_from_file(
    file_path: Path,
    root: Path,
    integration_rules: dict[str, IntegrationTag] | None = None,
) -> list[IntegrationRecord]:
    """Extract integration records from a single Python file."""
    relative_path = file_path.relative_to(root).as_posix()
    imports = extract_imports(file_path)
    records: list[IntegrationRecord] = []

    for import_type in ("import", "import_from", "import_star"):
        for line, module, name, _level in imports[import_type]:
            if not module:
                continue
            tag = _get_integration_tag(module, extra_rules=integration_rules)
            if tag:
                if name and import_type == "import_from":
                    evidence = f"{import_type}: {module}.{name.split()[0]}"
                else:
                    evidence = f"{import_type}: {module}"
                records.append(
                    IntegrationRecord(
                        path=relative_path,
                        tag=tag,
                        evidence=evidence,
                        line=line,
                    )
                )

    return records


class IntegrationsGenerator:
    """Generator for integration detection artifacts."""

    @property
    def name(self) -> str:
        """Generator name for logging and identification."""
        return "integrations"

    def generate(
        self,
        root: Path,
        out_dir: Path,
        **kwargs: Any,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Generate integrations_static.jsonl from all Python files."""
        include_patterns = kwargs.get("include_patterns")
        exclude_patterns = kwargs.get("exclude_patterns")
        integration_rules = kwargs.get("integration_tags")
        nested_gitignore: bool = kwargs.get("nested_gitignore", False)

        out_dir.mkdir(parents=True, exist_ok=True)

        all_integrations: list[IntegrationRecord] = []

        out_dir_name = _get_output_dir_name(out_dir, root)

        for file_path in find_python_files(
            root,
            output_dir=out_dir_name,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            nested_gitignore=nested_gitignore,
        ):
            integrations = _extract_integrations_from_file(
                file_path,
                root,
                integration_rules,
            )
            all_integrations.extend(integrations)

        all_integrations.sort(key=lambda r: (r.path, r.line or 0, r.tag, r.evidence))

        _write_jsonl(out_dir / INTEGRATIONS_STATIC_JSONL, all_integrations)

        integration_dicts = [r.model_dump() for r in all_integrations]

        return integration_dicts, {}
