"""Unit tests for the punch card engine (.kilocode/tools/punch_engine.py).

Covers:
- camelCase → snake_case tool name normalization
- source_hash determinism
- _observed_at_from_ts timestamp conversion
- _extract_ui_punches normalization of tool names
- _insert_checkpoint always writes both missing_punches and violations columns
"""

import importlib
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Import punch_engine from the .kilocode/tools directory.
# It's not a package, so we inject its parent onto sys.path temporarily.
# ---------------------------------------------------------------------------
_TOOLS_DIR = Path(__file__).resolve().parents[2] / ".kilocode" / "tools"
sys.path.insert(0, str(_TOOLS_DIR))
punch_engine = importlib.import_module("punch_engine")
sys.path.pop(0)

# Expose symbols under test
_normalize_tool_name = punch_engine._normalize_tool_name
_build_source_hash = punch_engine._build_source_hash
_observed_at_from_ts = punch_engine._observed_at_from_ts
_extract_ui_punches = punch_engine._extract_ui_punches
_emit_punch = punch_engine._emit_punch
_insert_checkpoint = punch_engine._insert_checkpoint


# ═══════════════════════════════════════════════════════════════════════════
# 1. Tool-name normalization
# ═══════════════════════════════════════════════════════════════════════════


class TestNormalizeToolName:
    """_normalize_tool_name converts camelCase UI tool names to snake_case."""

    @pytest.mark.parametrize(
        "camel,expected",
        [
            ("editFile", "edit_file"),
            ("applyDiff", "apply_diff"),
            ("writeToFile", "write_to_file"),
            ("readFile", "read_file"),
            ("newTask", "new_task"),
            ("listFiles", "list_files"),
            ("searchFiles", "search_files"),
            ("listCodeDefinitionNames", "list_code_definition_names"),
            ("browserAction", "browser_action"),
            ("useMcpTool", "use_mcp_tool"),
            ("accessMcpResource", "access_mcp_resource"),
            ("insertContent", "insert_content"),
            # Already snake_case — should pass through
            ("edit_file", "edit_file"),
            ("apply_diff", "apply_diff"),
            ("read_file", "read_file"),
            # Single word — no change
            ("read", "read"),
            ("edit", "edit"),
            # Empty string — edge case
            ("", ""),
        ],
    )
    def test_known_tool_names(self, camel: str, expected: str) -> None:
        assert _normalize_tool_name(camel) == expected

    def test_idempotent_on_snake_case(self) -> None:
        """Normalizing already-snake_case names should be a no-op."""
        for name in ("edit_file", "write_to_file", "apply_diff", "read_file"):
            assert _normalize_tool_name(name) == name


# ═══════════════════════════════════════════════════════════════════════════
# 2. Source hash determinism
# ═══════════════════════════════════════════════════════════════════════════


class TestBuildSourceHash:
    """_build_source_hash must be deterministic for identical inputs."""

    def test_same_inputs_same_hash(self) -> None:
        h1 = _build_source_hash(
            "task-1", "tool_call", "edit_file", "2026-01-01T00:00:00+00:00"
        )
        h2 = _build_source_hash(
            "task-1", "tool_call", "edit_file", "2026-01-01T00:00:00+00:00"
        )
        assert h1 == h2

    def test_different_inputs_different_hash(self) -> None:
        h1 = _build_source_hash(
            "task-1", "tool_call", "edit_file", "2026-01-01T00:00:00+00:00"
        )
        h2 = _build_source_hash(
            "task-2", "tool_call", "edit_file", "2026-01-01T00:00:00+00:00"
        )
        assert h1 != h2

    def test_hash_is_sha256_hex(self) -> None:
        h = _build_source_hash("t", "p", "k", "2026-01-01T00:00:00+00:00")
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)

    def test_punch_key_difference_changes_hash(self) -> None:
        h1 = _build_source_hash(
            "t", "tool_call", "editFile", "2026-01-01T00:00:00+00:00"
        )
        h2 = _build_source_hash(
            "t", "tool_call", "edit_file", "2026-01-01T00:00:00+00:00"
        )
        assert h1 != h2, "Normalized vs raw name must produce different hashes"


# ═══════════════════════════════════════════════════════════════════════════
# 3. Timestamp conversion
# ═══════════════════════════════════════════════════════════════════════════


class TestObservedAtFromTs:
    """_observed_at_from_ts converts ms epoch to ISO and SQL strings."""

    def test_epoch_zero(self) -> None:
        iso, sql = _observed_at_from_ts(0)
        assert iso == "1970-01-01T00:00:00+00:00"
        assert sql == "1970-01-01 00:00:00"

    def test_known_timestamp(self) -> None:
        # 2026-03-01 12:00:00 UTC in milliseconds
        ts_ms = 1772222400000
        iso, sql = _observed_at_from_ts(ts_ms)
        assert "2026" in iso
        assert "2026" in sql
        assert "+00:00" in iso

    def test_returns_tuple_of_strings(self) -> None:
        iso, sql = _observed_at_from_ts(1000000000000)
        assert isinstance(iso, str)
        assert isinstance(sql, str)


# ═══════════════════════════════════════════════════════════════════════════
# 4. _extract_ui_punches normalizes tool names
# ═══════════════════════════════════════════════════════════════════════════


class TestExtractUiPunchesNormalization:
    """_extract_ui_punches must emit normalized (snake_case) punch keys."""

    @staticmethod
    def _make_tool_msg(tool_name: str, ts: int = 1000000) -> dict:
        """Build a minimal ui_message for a tool call."""
        import json

        return {
            "ts": ts,
            "ask": "tool",
            "text": json.dumps({"tool": tool_name}),
        }

    @staticmethod
    def _make_new_task_msg(mode: str, ts: int = 1000000) -> dict:
        import json

        return {
            "ts": ts,
            "ask": "tool",
            "text": json.dumps({"tool": "newTask", "mode": mode}),
        }

    def test_editFile_normalized(self) -> None:
        msgs = [self._make_tool_msg("editFile")]
        punches = _extract_ui_punches("task-1", msgs)
        assert len(punches) == 1
        punch_type, punch_key, _, _ = punches[0]
        assert punch_type == "tool_call"
        assert punch_key == "edit_file"

    def test_applyDiff_normalized(self) -> None:
        msgs = [self._make_tool_msg("applyDiff")]
        punches = _extract_ui_punches("task-1", msgs)
        assert punches[0][1] == "apply_diff"

    def test_writeToFile_normalized(self) -> None:
        msgs = [self._make_tool_msg("writeToFile")]
        punches = _extract_ui_punches("task-1", msgs)
        assert punches[0][1] == "write_to_file"

    def test_readFile_normalized(self) -> None:
        msgs = [self._make_tool_msg("readFile")]
        punches = _extract_ui_punches("task-1", msgs)
        assert punches[0][1] == "read_file"

    def test_newTask_mode_normalized(self) -> None:
        msgs = [self._make_new_task_msg("processOrchestrator")]
        punches = _extract_ui_punches("task-1", msgs)
        assert len(punches) == 1
        punch_type, punch_key, _, _ = punches[0]
        assert punch_type == "child_spawn"
        assert punch_key == "process_orchestrator"

    def test_already_snake_case_passthrough(self) -> None:
        msgs = [self._make_tool_msg("read_file")]
        punches = _extract_ui_punches("task-1", msgs)
        assert punches[0][1] == "read_file"

    def test_multiple_tools_all_normalized(self) -> None:
        msgs = [
            self._make_tool_msg("editFile", ts=1000),
            self._make_tool_msg("writeToFile", ts=2000),
            self._make_tool_msg("applyDiff", ts=3000),
        ]
        punches = _extract_ui_punches("task-1", msgs)
        keys = [p[1] for p in punches]
        assert keys == ["edit_file", "write_to_file", "apply_diff"]

    def test_completion_result_unchanged(self) -> None:
        msgs = [{"ts": 1000, "say": "completion_result"}]
        punches = _extract_ui_punches("task-1", msgs)
        assert len(punches) == 1
        assert punches[0][0] == "step_complete"
        assert punches[0][1] == "task_exit"


# ═══════════════════════════════════════════════════════════════════════════
# 5. _insert_checkpoint always includes violations column
# ═══════════════════════════════════════════════════════════════════════════


class TestInsertCheckpoint:
    """_insert_checkpoint must always use the query with violations column."""

    def test_insert_query_includes_violations_column(self) -> None:
        """Verify the SQL query always includes 'violations' in the column list."""
        queries_issued: list[str] = []

        def mock_dolt_sql(query: str) -> str | None:
            queries_issued.append(query)
            # Return empty CSV for INSERT, and a fake checkpoint_id for SELECT
            if query.strip().upper().startswith("INSERT"):
                return ""
            if query.strip().upper().startswith("SELECT"):
                return "checkpoint_id\n42\n"
            return ""

        with patch.object(punch_engine, "dolt_sql", side_effect=mock_dolt_sql):
            _insert_checkpoint(
                task_id="test-task",
                card_id="test-card",
                status="pass",
                validated_at="2026-01-01 00:00:00",
                missing=[],
                violations=[],
            )

        # The INSERT query should include 'violations' in the column list
        insert_queries = [
            q for q in queries_issued if q.strip().upper().startswith("INSERT")
        ]
        assert len(insert_queries) == 1, f"Expected 1 INSERT, got {len(insert_queries)}"
        assert "violations" in insert_queries[0]
        assert "missing_punches" in insert_queries[0]

    def test_no_fallback_legacy_query(self) -> None:
        """Verify there is no fallback to a legacy query without violations."""
        call_count = 0

        def mock_dolt_sql(query: str) -> str | None:
            nonlocal call_count
            call_count += 1
            if query.strip().upper().startswith("INSERT"):
                # Return None to simulate failure
                return None
            return None

        with patch.object(punch_engine, "dolt_sql", side_effect=mock_dolt_sql):
            result = _insert_checkpoint(
                task_id="test-task",
                card_id="test-card",
                status="fail",
                validated_at="2026-01-01 00:00:00",
                missing=[
                    {"punch_type": "tool_call", "punch_key_pattern": "read_file%"}
                ],
                violations=[],
            )

        # Should return None (failure), with only 1 INSERT attempt (no fallback)
        assert result is None
        # Only 1 call: the INSERT that failed. No second fallback INSERT.
        assert call_count == 1

    def test_violations_json_serialized(self) -> None:
        """Verify violations list is JSON-serialized into the query."""
        queries_issued: list[str] = []

        def mock_dolt_sql(query: str) -> str | None:
            queries_issued.append(query)
            if query.strip().upper().startswith("INSERT"):
                return ""
            if query.strip().upper().startswith("SELECT"):
                return "checkpoint_id\n99\n"
            return ""

        violations_data = [
            {
                "punch_type": "tool_call",
                "punch_key_pattern": "edit_file%",
                "description": "FORBIDDEN",
                "count": "2",
            }
        ]

        with patch.object(punch_engine, "dolt_sql", side_effect=mock_dolt_sql):
            _insert_checkpoint(
                task_id="test-task",
                card_id="test-card",
                status="fail",
                validated_at="2026-01-01 00:00:00",
                missing=[],
                violations=violations_data,
            )

        insert_queries = [
            q for q in queries_issued if q.strip().upper().startswith("INSERT")
        ]
        assert len(insert_queries) == 1
        # The violations JSON must appear in the query
        assert "edit_file%" in insert_queries[0]
        assert "FORBIDDEN" in insert_queries[0]
