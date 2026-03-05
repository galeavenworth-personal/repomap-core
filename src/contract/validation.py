"""Validation helpers for Tier-1 contract artifacts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

import orjson
from pydantic import ValidationError

from artifacts.models.artifacts.calls_raw import CallRawRecord
from artifacts.models.artifacts.calls import CallRecord
from artifacts.models.artifacts.refs import RefRecord
from artifacts.models.artifacts.refs_summary import RefsSummary
from contract.artifacts import (
    ARTIFACT_SCHEMA_VERSION,
    TIER1_ARTIFACT_SPECS,
)
from contract.models import (
    DepsSummary,
    IntegrationRecord,
    ModuleRecord,
    SymbolRecord,
)

if TYPE_CHECKING:
    from pathlib import Path


class _SchemaModel(Protocol):
    schema_version: int

    @classmethod
    def model_validate(cls, obj: Any) -> _SchemaModel: ...


@dataclass(frozen=True)
class ValidationMessage:
    artifact: str
    path: Path
    message: str
    line: int | None = None

    def location(self) -> str:
        if self.line is None:
            return str(self.path)
        return f"{self.path}:{self.line}"

    def to_dict(self) -> dict[str, object]:
        return {
            "artifact": self.artifact,
            "path": str(self.path),
            "line": self.line,
            "message": self.message,
        }


@dataclass
class ValidationResult:
    errors: list[ValidationMessage] = field(default_factory=list)
    warnings: list[ValidationMessage] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def validate_artifacts(
    artifacts_dir: Path,
    *,
    strict_schema_version: bool = False,
    cross_artifact: bool = True,
) -> ValidationResult:
    result = ValidationResult()

    if not artifacts_dir.exists():
        result.errors.append(
            ValidationMessage(
                artifact="artifacts_dir",
                path=artifacts_dir,
                message="Artifacts directory does not exist.",
            )
        )
        return result

    if not artifacts_dir.is_dir():
        result.errors.append(
            ValidationMessage(
                artifact="artifacts_dir",
                path=artifacts_dir,
                message="Artifacts path is not a directory.",
            )
        )
        return result

    # Cross-artifact index: populated during per-artifact validation.
    cross_index = _CrossArtifactIndex() if cross_artifact else None

    for artifact_name, spec in TIER1_ARTIFACT_SPECS.items():
        path = artifacts_dir / spec.filename
        if not path.exists():
            result.errors.append(
                ValidationMessage(
                    artifact=artifact_name,
                    path=path,
                    message="Required artifact file is missing.",
                )
            )
            continue

        if spec.format == "jsonl":
            model = _jsonl_model_for_artifact(artifact_name)
            _validate_jsonl(
                artifact_name,
                path,
                model,
                result,
                strict_schema_version=strict_schema_version,
                cross_index=cross_index,
            )
        elif spec.format == "json":
            _validate_json_artifact(
                artifact_name,
                path,
                result,
                strict_schema_version=strict_schema_version,
            )
        elif spec.format == "edgelist":
            _validate_edgelist(artifact_name, path, result)
        else:
            result.errors.append(
                ValidationMessage(
                    artifact=artifact_name,
                    path=path,
                    message=f"Unsupported artifact format: {spec.format}.",
                )
            )

    # Cross-artifact invariant checks.
    if cross_index is not None:
        _validate_cross_artifact_invariants(cross_index, artifacts_dir, result)

    return result


@dataclass
class _CrossArtifactIndex:
    """Index built during per-artifact validation for cross-artifact checks."""

    # All symbol_id values from symbols.jsonl.
    symbol_ids: set[str] = field(default_factory=set)
    # All module names from modules.jsonl (module field → path).
    module_names: set[str] = field(default_factory=set)
    # (artifact_name, ref_id, symbol_id) tuples from resolved_to in refs/calls.
    resolved_to_symbol_ids: list[tuple[str, str, str]] = field(default_factory=list)
    # (artifact_name, ref_id, module) tuples from refs/calls module fields.
    record_modules: list[tuple[str, str, str]] = field(default_factory=list)
    # (artifact_name, ref_id, dst_module) tuples from resolved_to.dst_module.
    resolved_to_dst_modules: list[tuple[str, str, str]] = field(default_factory=list)


def _jsonl_model_for_artifact(artifact_name: str) -> type[_SchemaModel]:
    if artifact_name == "symbols":
        return SymbolRecord
    if artifact_name == "modules":
        return ModuleRecord
    if artifact_name == "integrations":
        return IntegrationRecord
    if artifact_name == "calls_raw":
        return CallRawRecord
    if artifact_name == "refs":
        return RefRecord
    if artifact_name == "calls":
        return CallRecord
    msg = f"Unknown jsonl artifact: {artifact_name}"
    raise ValueError(msg)


def _validate_jsonl(
    artifact_name: str,
    path: Path,
    model: type[_SchemaModel],
    result: ValidationResult,
    *,
    strict_schema_version: bool,
    cross_index: _CrossArtifactIndex | None = None,
) -> None:
    try:
        handle = path.open("rb")
    except OSError as exc:
        result.errors.append(
            ValidationMessage(
                artifact=artifact_name,
                path=path,
                message=f"Failed to read file: {exc}.",
            )
        )
        return

    missing_schema_emitted = False
    mismatch_schema_emitted = False
    seen_symbol_ids: set[str] | None = set() if artifact_name == "symbols" else None
    duplicate_symbol_ids: set[str] = set()
    with handle:
        for line_number, raw_line in enumerate(handle, 1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                data = orjson.loads(line)
            except orjson.JSONDecodeError as exc:
                result.errors.append(
                    ValidationMessage(
                        artifact=artifact_name,
                        path=path,
                        line=line_number,
                        message=f"Invalid JSON: {exc}.",
                    )
                )
                continue

            schema_present = isinstance(data, dict) and "schema_version" in data
            try:
                record = model.model_validate(data)
            except ValidationError as exc:
                result.errors.append(
                    ValidationMessage(
                        artifact=artifact_name,
                        path=path,
                        line=line_number,
                        message=f"Schema validation failed: {exc}.",
                    )
                )
                continue

            if seen_symbol_ids is not None:
                symbol_id = getattr(record, "symbol_id", None)
                if isinstance(symbol_id, str):
                    if symbol_id in seen_symbol_ids:
                        duplicate_symbol_ids.add(symbol_id)
                    else:
                        seen_symbol_ids.add(symbol_id)

            # Populate cross-artifact index.
            if cross_index is not None:
                _index_record(cross_index, artifact_name, record)

            if not schema_present:
                if not missing_schema_emitted:
                    _check_schema_version(
                        artifact_name,
                        path,
                        line_number,
                        schema_present,
                        record.schema_version,
                        result,
                        strict_schema_version=strict_schema_version,
                    )
                    missing_schema_emitted = True
                continue

            if (
                record.schema_version != ARTIFACT_SCHEMA_VERSION
                and not mismatch_schema_emitted
            ):
                _check_schema_version(
                    artifact_name,
                    path,
                    line_number,
                    schema_present,
                    record.schema_version,
                    result,
                    strict_schema_version=strict_schema_version,
                )
                mismatch_schema_emitted = True

    # Feed collected symbol_ids into the cross-artifact index.
    if seen_symbol_ids is not None and cross_index is not None:
        cross_index.symbol_ids.update(seen_symbol_ids)

    for symbol_id in sorted(duplicate_symbol_ids):
        result.errors.append(
            ValidationMessage(
                artifact=artifact_name,
                path=path,
                message=f"Duplicate symbol_id in symbols.jsonl: {symbol_id}",
            )
        )


def _json_model_for_artifact(
    artifact_name: str,
) -> type[DepsSummary] | type[RefsSummary]:
    """Return the Pydantic model for a JSON-format artifact."""
    if artifact_name == "deps_summary":
        return DepsSummary
    if artifact_name == "refs_summary":
        return RefsSummary
    msg = f"Unknown json artifact: {artifact_name}"
    raise ValueError(msg)


def _validate_json_artifact(
    artifact_name: str,
    path: Path,
    result: ValidationResult,
    *,
    strict_schema_version: bool,
) -> None:
    try:
        raw = orjson.loads(path.read_bytes())
    except (OSError, orjson.JSONDecodeError) as exc:
        result.errors.append(
            ValidationMessage(
                artifact=artifact_name,
                path=path,
                message=f"Invalid JSON: {exc}.",
            )
        )
        return

    if not isinstance(raw, dict):
        result.errors.append(
            ValidationMessage(
                artifact=artifact_name,
                path=path,
                message=f"Expected JSON object for {TIER1_ARTIFACT_SPECS[artifact_name].filename}.",
            )
        )
        return

    data = dict(raw)

    # Legacy compat for deps_summary.
    if artifact_name == "deps_summary":
        if "cycles" not in data and "strongly_connected_components" in data:
            data["cycles"] = data.get("strongly_connected_components")
            data.pop("strongly_connected_components", None)

    model = _json_model_for_artifact(artifact_name)
    schema_present = "schema_version" in data
    try:
        record = model.model_validate(data)
    except ValidationError as exc:
        result.errors.append(
            ValidationMessage(
                artifact=artifact_name,
                path=path,
                message=f"Schema validation failed: {exc}.",
            )
        )
        return

    _check_schema_version(
        artifact_name,
        path,
        None,
        schema_present,
        record.schema_version,
        result,
        strict_schema_version=strict_schema_version,
    )


def _validate_edgelist(
    artifact_name: str, path: Path, result: ValidationResult
) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError as exc:
        result.errors.append(
            ValidationMessage(
                artifact=artifact_name,
                path=path,
                message=f"Failed to read file: invalid UTF-8 ({exc}).",
            )
        )
        return
    except OSError as exc:
        result.errors.append(
            ValidationMessage(
                artifact=artifact_name,
                path=path,
                message=f"Failed to read file: {exc}.",
            )
        )
        return

    for line_number, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line:
            continue
        if "->" not in line:
            result.errors.append(
                ValidationMessage(
                    artifact=artifact_name,
                    path=path,
                    line=line_number,
                    message="Malformed edgelist line (expected 'source -> target').",
                )
            )
            continue
        source, target = line.split("->", 1)
        if not source.strip() or not target.strip():
            result.errors.append(
                ValidationMessage(
                    artifact=artifact_name,
                    path=path,
                    line=line_number,
                    message="Malformed edgelist line (empty source or target).",
                )
            )


def _check_schema_version(
    artifact_name: str,
    path: Path,
    line: int | None,
    schema_present: bool,
    schema_version: int,
    result: ValidationResult,
    *,
    strict_schema_version: bool,
) -> None:
    if schema_present and schema_version != ARTIFACT_SCHEMA_VERSION:
        result.errors.append(
            ValidationMessage(
                artifact=artifact_name,
                path=path,
                line=line,
                message=(
                    "Schema version mismatch: "
                    f"expected {ARTIFACT_SCHEMA_VERSION}, got {schema_version}."
                ),
            )
        )
        return

    if not schema_present:
        message = f"Missing schema_version; defaulted to {ARTIFACT_SCHEMA_VERSION}."
        if strict_schema_version:
            result.errors.append(
                ValidationMessage(
                    artifact=artifact_name,
                    path=path,
                    line=line,
                    message=message,
                )
            )
        else:
            result.warnings.append(
                ValidationMessage(
                    artifact=artifact_name,
                    path=path,
                    line=line,
                    message=message,
                )
            )


def _index_resolution(
    cross_index: _CrossArtifactIndex,
    artifact_name: str,
    ref_id: str,
    resolution: object,
) -> None:
    """Index symbol_id and dst_module from a single resolution object."""
    if resolution is None:
        return
    sym_id = getattr(resolution, "symbol_id", None)
    # Skip synthetic external IDs (ext:*) — they won't be in symbols.jsonl.
    if isinstance(sym_id, str) and not sym_id.startswith("ext:"):
        cross_index.resolved_to_symbol_ids.append((artifact_name, ref_id, sym_id))
    dst_mod = getattr(resolution, "dst_module", None)
    if isinstance(dst_mod, str):
        cross_index.resolved_to_dst_modules.append((artifact_name, ref_id, dst_mod))


def _index_record(
    cross_index: _CrossArtifactIndex,
    artifact_name: str,
    record: _SchemaModel,
) -> None:
    """Populate the cross-artifact index from a validated record."""
    # Collect module names from modules.jsonl.
    if artifact_name == "modules":
        module_name = getattr(record, "module", None)
        if isinstance(module_name, str):
            cross_index.module_names.add(module_name)
        return

    # For refs / calls: collect module, resolved_to.symbol_id, resolved_to.dst_module.
    if artifact_name in ("refs", "calls"):
        ref_id = getattr(record, "ref_id", "")

        module_val = getattr(record, "module", None)
        if isinstance(module_val, str):
            cross_index.record_modules.append((artifact_name, ref_id, module_val))

        _index_resolution(
            cross_index, artifact_name, ref_id, getattr(record, "resolved_to", None)
        )
        _index_resolution(
            cross_index,
            artifact_name,
            ref_id,
            getattr(record, "resolved_base_to", None),
        )


def _report_dangling(
    known: set[str],
    entries: list[tuple[str, str, str]],
    artifacts_dir: Path,
    result: ValidationResult,
    msg_template: str,
) -> None:
    """Find values in *entries* missing from *known* and append errors."""
    dangling: set[str] = set()
    for _artifact, _ref, value in entries:
        if value not in known:
            dangling.add(value)
    for value in sorted(dangling):
        result.errors.append(
            ValidationMessage(
                artifact="cross_artifact",
                path=artifacts_dir,
                message=msg_template.format(value),
            )
        )


def _validate_cross_artifact_invariants(
    cross_index: _CrossArtifactIndex,
    artifacts_dir: Path,
    result: ValidationResult,
) -> None:
    """Check invariants that span multiple artifact files."""
    # INV-1: resolved_to.symbol_id must exist in symbols.jsonl (when internal).
    if cross_index.symbol_ids:
        _report_dangling(
            cross_index.symbol_ids,
            cross_index.resolved_to_symbol_ids,
            artifacts_dir,
            result,
            "resolved_to.symbol_id references unknown symbol: {}",
        )

    # INV-2: module field in refs/calls must exist in modules.jsonl.
    if cross_index.module_names:
        _report_dangling(
            cross_index.module_names,
            cross_index.record_modules,
            artifacts_dir,
            result,
            "Record module references unknown module: {}",
        )

    # INV-3: resolved_to.dst_module must exist in modules.jsonl.
    if cross_index.module_names:
        _report_dangling(
            cross_index.module_names,
            cross_index.resolved_to_dst_modules,
            artifacts_dir,
            result,
            "resolved_to.dst_module references unknown module: {}",
        )


__all__ = [
    "ValidationMessage",
    "ValidationResult",
    "validate_artifacts",
]
