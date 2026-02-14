from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from contract.artifacts import (
    ARTIFACT_SCHEMA_VERSION,
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    SYMBOLS_JSONL,
    TIER1_ARTIFACT_SPECS,
)
from contract.validation import (
    ValidationMessage,
    ValidationResult,
    _jsonl_model_for_artifact,
    validate_artifacts,
)


def _write_valid_artifacts(d: Path) -> None:
    """Write minimal valid Tier-1 artifacts to directory d."""
    d.mkdir(parents=True, exist_ok=True)

    symbol_record = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "path": "pkg/mod.py",
        "kind": "function",
        "name": "f",
        "qualified_name": "pkg.mod.f",
        "start_line": 1,
        "start_col": 0,
        "end_line": 1,
        "end_col": 10,
        "docstring_present": False,
    }
    (d / SYMBOLS_JSONL).write_text(json.dumps(symbol_record) + "\n", encoding="utf-8")

    integration_record = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "path": "pkg/mod.py",
        "tag": "http",
        "evidence": "requests.get(...)",
    }
    (d / INTEGRATIONS_STATIC_JSONL).write_text(
        json.dumps(integration_record) + "\n", encoding="utf-8"
    )

    deps_summary = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "node_count": 1,
        "edge_count": 1,
    }
    (d / DEPS_SUMMARY_JSON).write_text(json.dumps(deps_summary), encoding="utf-8")

    (d / DEPS_EDGELIST).write_text("pkg.mod -> requests\n", encoding="utf-8")


def _messages_contain(messages: list[ValidationMessage], needle: str) -> bool:
    """Return True when any validation message contains the given substring."""
    return any(needle in message.message for message in messages)


# Group 1: Data class tests


def test_validation_message_location_with_line() -> None:
    """ValidationMessage.location returns path:line when line is present."""
    msg = ValidationMessage("symbols", Path("x.jsonl"), "bad", line=7)
    assert msg.location() == "x.jsonl:7"


def test_validation_message_location_without_line() -> None:
    """ValidationMessage.location returns only path when line is missing."""
    msg = ValidationMessage("symbols", Path("x.jsonl"), "bad")
    assert msg.location() == "x.jsonl"


def test_validation_message_to_dict() -> None:
    """ValidationMessage.to_dict returns the expected payload."""
    msg = ValidationMessage("symbols", Path("x.jsonl"), "bad", line=3)
    assert msg.to_dict() == {
        "artifact": "symbols",
        "path": "x.jsonl",
        "line": 3,
        "message": "bad",
    }


def test_validation_result_ok_when_no_errors() -> None:
    """ValidationResult.ok is true when no errors are present."""
    result = ValidationResult()
    assert result.ok is True


def test_validation_result_not_ok_when_errors() -> None:
    """ValidationResult.ok is false when at least one error exists."""
    result = ValidationResult(errors=[ValidationMessage("x", Path("a"), "boom")])
    assert result.ok is False


# Group 2: Directory handling


def test_missing_directory() -> None:
    """validate_artifacts reports a missing artifacts directory."""
    result = validate_artifacts(Path("/nonexistent"))
    assert result.ok is False
    assert _messages_contain(result.errors, "Artifacts directory does not exist")


def test_not_a_directory(tmp_path: Path) -> None:
    """validate_artifacts reports a path that is not a directory."""
    file_path = tmp_path / "not-a-dir"
    file_path.write_text("x", encoding="utf-8")

    result = validate_artifacts(file_path)

    assert result.ok is False
    assert _messages_contain(result.errors, "Artifacts path is not a directory")


def test_missing_artifact_files(tmp_path: Path) -> None:
    """validate_artifacts reports each required artifact when directory is empty."""
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert len(result.errors) == len(TIER1_ARTIFACT_SPECS)
    assert all("Required artifact file is missing" in m.message for m in result.errors)


# Group 3: Happy path


def test_valid_artifacts_pass(tmp_path: Path) -> None:
    """A complete valid artifact set produces no errors or warnings."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)

    result = validate_artifacts(artifacts_dir)

    assert result.ok is True
    assert result.errors == []
    assert result.warnings == []


# Group 4: JSONL validation


def test_jsonl_invalid_json(tmp_path: Path) -> None:
    """Invalid JSON in JSONL produces a line-level JSON error."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    (artifacts_dir / SYMBOLS_JSONL).write_text("{not-json}\n", encoding="utf-8")

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "Invalid JSON")


def test_jsonl_pydantic_failure(tmp_path: Path) -> None:
    """Schema-invalid JSONL records produce schema validation errors."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    (artifacts_dir / SYMBOLS_JSONL).write_text(
        json.dumps({"schema_version": ARTIFACT_SCHEMA_VERSION}) + "\n",
        encoding="utf-8",
    )

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "Schema validation failed")


def test_jsonl_missing_schema_version_lenient(tmp_path: Path) -> None:
    """Missing schema_version is a warning in lenient mode."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    symbol_without_version = {
        "path": "pkg/mod.py",
        "kind": "function",
        "name": "f",
        "qualified_name": "pkg.mod.f",
        "start_line": 1,
        "start_col": 0,
        "end_line": 1,
        "end_col": 10,
        "docstring_present": False,
    }
    (artifacts_dir / SYMBOLS_JSONL).write_text(
        json.dumps(symbol_without_version) + "\n", encoding="utf-8"
    )

    result = validate_artifacts(artifacts_dir)

    assert result.ok is True
    assert result.errors == []
    assert _messages_contain(result.warnings, "Missing schema_version")


def test_jsonl_missing_schema_version_strict(tmp_path: Path) -> None:
    """Missing schema_version is an error in strict mode."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    symbol_without_version = {
        "path": "pkg/mod.py",
        "kind": "function",
        "name": "f",
        "qualified_name": "pkg.mod.f",
        "start_line": 1,
        "start_col": 0,
        "end_line": 1,
        "end_col": 10,
        "docstring_present": False,
    }
    (artifacts_dir / SYMBOLS_JSONL).write_text(
        json.dumps(symbol_without_version) + "\n", encoding="utf-8"
    )

    result = validate_artifacts(artifacts_dir, strict_schema_version=True)

    assert result.ok is False
    assert _messages_contain(result.errors, "Missing schema_version")


def test_jsonl_wrong_schema_version(tmp_path: Path) -> None:
    """Wrong schema_version produces a schema mismatch error."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    wrong_version_symbol = {
        "schema_version": 999,
        "path": "pkg/mod.py",
        "kind": "function",
        "name": "f",
        "qualified_name": "pkg.mod.f",
        "start_line": 1,
        "start_col": 0,
        "end_line": 1,
        "end_col": 10,
        "docstring_present": False,
    }
    (artifacts_dir / SYMBOLS_JSONL).write_text(
        json.dumps(wrong_version_symbol) + "\n", encoding="utf-8"
    )

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "Schema version mismatch")


def test_jsonl_os_error(tmp_path: Path) -> None:
    """JSONL file open OSError is surfaced as a validation error."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    target = artifacts_dir / SYMBOLS_JSONL
    original_open = Path.open

    def _patched_open(self: Path, *args: Any, **kwargs: Any) -> Any:
        if self == target and args and args[0] == "rb":
            raise OSError("boom")
        return original_open(self, *args, **kwargs)

    with patch.object(Path, "open", _patched_open):
        result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "Failed to read file")


def test_jsonl_schema_dedup(tmp_path: Path) -> None:
    """Missing schema_version warning is emitted once per JSONL file."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    symbol_without_version = {
        "path": "pkg/mod.py",
        "kind": "function",
        "name": "f",
        "qualified_name": "pkg.mod.f",
        "start_line": 1,
        "start_col": 0,
        "end_line": 1,
        "end_col": 10,
        "docstring_present": False,
    }
    payload = "\n".join(
        [
            json.dumps(symbol_without_version),
            json.dumps(symbol_without_version),
        ]
    )
    (artifacts_dir / SYMBOLS_JSONL).write_text(payload + "\n", encoding="utf-8")

    result = validate_artifacts(artifacts_dir)

    warnings = [m for m in result.warnings if m.artifact == "symbols"]
    assert len(warnings) == 1
    assert "Missing schema_version" in warnings[0].message


def test_jsonl_empty_lines_skipped(tmp_path: Path) -> None:
    """Blank JSONL lines are ignored by validation."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    symbol_record = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "path": "pkg/mod.py",
        "kind": "function",
        "name": "f",
        "qualified_name": "pkg.mod.f",
        "start_line": 1,
        "start_col": 0,
        "end_line": 1,
        "end_col": 10,
        "docstring_present": False,
    }
    (artifacts_dir / SYMBOLS_JSONL).write_text(
        "\n\n" + json.dumps(symbol_record) + "\n\n", encoding="utf-8"
    )

    result = validate_artifacts(artifacts_dir)

    assert result.ok is True


# Group 5: deps_summary


def test_deps_summary_invalid_json(tmp_path: Path) -> None:
    """Invalid deps_summary JSON is reported as an error."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    (artifacts_dir / DEPS_SUMMARY_JSON).write_text("{", encoding="utf-8")

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "Invalid JSON")


def test_deps_summary_non_dict(tmp_path: Path) -> None:
    """A non-object deps_summary payload is rejected."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    (artifacts_dir / DEPS_SUMMARY_JSON).write_text("[]", encoding="utf-8")

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "Expected JSON object")


def test_deps_summary_pydantic_failure(tmp_path: Path) -> None:
    """Schema-invalid deps_summary payload produces validation error."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    bad_summary = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "node_count": "not_an_int",
    }
    (artifacts_dir / DEPS_SUMMARY_JSON).write_text(
        json.dumps(bad_summary), encoding="utf-8"
    )

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "Schema validation failed")


def test_deps_summary_legacy_scc_rename(tmp_path: Path) -> None:
    """Legacy strongly_connected_components key is accepted via rename."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    legacy_summary = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "node_count": 1,
        "edge_count": 0,
        "strongly_connected_components": [],
    }
    (artifacts_dir / DEPS_SUMMARY_JSON).write_text(
        json.dumps(legacy_summary), encoding="utf-8"
    )

    result = validate_artifacts(artifacts_dir)

    assert result.ok is True
    assert result.errors == []


# Group 6: Edgelist


def test_edgelist_non_utf8(tmp_path: Path) -> None:
    """Non-UTF-8 edgelist bytes are reported as decoding errors."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    (artifacts_dir / DEPS_EDGELIST).write_bytes(b"\xff\xfe")

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "invalid UTF-8")


def test_edgelist_missing_arrow(tmp_path: Path) -> None:
    """Edgelist lines missing '->' are rejected."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    (artifacts_dir / DEPS_EDGELIST).write_text("foo bar\n", encoding="utf-8")

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "expected 'source -> target'")


def test_edgelist_empty_source_or_target(tmp_path: Path) -> None:
    """Edgelist lines with empty source or target are rejected."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    (artifacts_dir / DEPS_EDGELIST).write_text("source -> \n", encoding="utf-8")

    result = validate_artifacts(artifacts_dir)

    assert result.ok is False
    assert _messages_contain(result.errors, "empty source or target")


def test_edgelist_empty_lines_skipped(tmp_path: Path) -> None:
    """Blank edgelist lines are ignored by validation."""
    artifacts_dir = tmp_path / "artifacts"
    _write_valid_artifacts(artifacts_dir)
    (artifacts_dir / DEPS_EDGELIST).write_text(
        "\n\nsource -> target\n\n", encoding="utf-8"
    )

    result = validate_artifacts(artifacts_dir)

    assert result.ok is True


# Group 7: Internal edge case


def test_jsonl_model_for_artifact_unknown() -> None:
    """Unknown JSONL artifact names raise ValueError."""
    with pytest.raises(ValueError, match="Unknown jsonl artifact"):
        _jsonl_model_for_artifact("nonexistent")
