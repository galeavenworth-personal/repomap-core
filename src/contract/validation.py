"""Validation helpers for Tier-1 contract artifacts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

import orjson
from pydantic import ValidationError

from contract.artifacts import (
    ARTIFACT_SCHEMA_VERSION,
    TIER1_ARTIFACT_SPECS,
)
from contract.models import DepsSummary, IntegrationRecord, SymbolRecord

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
    artifacts_dir: Path, *, strict_schema_version: bool = False
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
            )
        elif spec.format == "json":
            _validate_deps_summary(
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

    return result


def _jsonl_model_for_artifact(artifact_name: str) -> type[_SchemaModel]:
    if artifact_name == "symbols":
        return SymbolRecord
    if artifact_name == "integrations":
        return IntegrationRecord
    msg = f"Unknown jsonl artifact: {artifact_name}"
    raise ValueError(msg)


def _validate_jsonl(
    artifact_name: str,
    path: Path,
    model: type[_SchemaModel],
    result: ValidationResult,
    *,
    strict_schema_version: bool,
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


def _validate_deps_summary(
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
                message="Expected JSON object for deps_summary.json.",
            )
        )
        return

    data = dict(raw)
    if "cycles" not in data and "strongly_connected_components" in data:
        data["cycles"] = data.get("strongly_connected_components")
        data.pop("strongly_connected_components", None)

    schema_present = "schema_version" in data
    try:
        summary = DepsSummary.model_validate(data)
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
        summary.schema_version,
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


__all__ = [
    "ValidationMessage",
    "ValidationResult",
    "validate_artifacts",
]
