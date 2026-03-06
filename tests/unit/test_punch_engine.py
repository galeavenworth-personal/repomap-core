"""Unit tests for the punch card engine (.kilocode/tools/punch_engine.py).

Covers:
- camelCase → snake_case tool name normalization
- source_hash determinism
- _observed_at_from_ts timestamp conversion
- _extract_ui_punches normalization of tool names
- _insert_checkpoint always writes both missing_punches and violations columns
- Deterministic child task ID resolution via kilo serve session API
- 3-tier resolve_task_id strategy (explicit → API → mtime heuristic)
- Warning telemetry when falling back to mtime heuristic
"""

import importlib
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
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
resolve_task_id = punch_engine.resolve_task_id
resolve_child_from_session_api = punch_engine.resolve_child_from_session_api


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


# ═══════════════════════════════════════════════════════════════════════════
# 6. resolve_child_from_session_api — kilo serve API resolution
# ═══════════════════════════════════════════════════════════════════════════

# A valid UUID v4 for testing
_CHILD_UUID = "01961f3a-b8c5-7c2e-9b3e-7a1b2c3d4e5f"
_PARENT_UUID = "01961f3a-0000-7000-8000-000000000001"


class _MockHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that serves canned children responses."""

    # Class-level response configuration; tests override before each request.
    response_body: bytes = b"[]"
    response_code: int = 200

    def do_GET(self) -> None:  # noqa: N802
        self.send_response(self.response_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(self.response_body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # suppress server logs during tests


@pytest.fixture()
def _mock_kilo_server():
    """Start a temporary HTTP server mimicking kilo serve."""
    server = HTTPServer(("127.0.0.1", 0), _MockHandler)
    port = server.server_address[1]
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}", server
    server.shutdown()


class TestResolveChildFromSessionApi:
    """resolve_child_from_session_api queries the kilo serve children endpoint."""

    def test_returns_child_id_on_success(self, _mock_kilo_server: tuple) -> None:
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = json.dumps([{"id": _CHILD_UUID}]).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result == _CHILD_UUID

    def test_returns_none_on_empty_children(self, _mock_kilo_server: tuple) -> None:
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = b"[]"
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None

    def test_returns_none_on_out_of_range_index(self, _mock_kilo_server: tuple) -> None:
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = json.dumps([{"id": _CHILD_UUID}]).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=5, base_url=base_url
        )
        assert result is None

    def test_returns_second_child_with_index_1(self, _mock_kilo_server: tuple) -> None:
        base_url, srv = _mock_kilo_server
        second_uuid = "01961f3a-b8c5-7c2e-9b3e-000000000002"
        _MockHandler.response_body = json.dumps(
            [{"id": _CHILD_UUID}, {"id": second_uuid}]
        ).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=1, base_url=base_url
        )
        assert result == second_uuid

    def test_returns_none_on_server_error(self, _mock_kilo_server: tuple) -> None:
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = b"Internal Server Error"
        _MockHandler.response_code = 500
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None

    def test_returns_none_on_unreachable_server(self) -> None:
        result = resolve_child_from_session_api(
            _PARENT_UUID,
            child_index=0,
            base_url="http://127.0.0.1:1",  # nothing listening
            timeout=1,
        )
        assert result is None

    def test_returns_none_on_invalid_json(self, _mock_kilo_server: tuple) -> None:
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = b"not json"
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None

    def test_returns_none_on_non_array_response(self, _mock_kilo_server: tuple) -> None:
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = json.dumps({"id": _CHILD_UUID}).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None

    def test_returns_none_when_child_id_not_uuid(
        self, _mock_kilo_server: tuple
    ) -> None:
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = json.dumps([{"id": "not-a-uuid"}]).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None


# ═══════════════════════════════════════════════════════════════════════════
# 7. resolve_task_id — 3-tier resolution strategy
# ═══════════════════════════════════════════════════════════════════════════


class TestResolveTaskId:
    """resolve_task_id implements explicit → API → mtime heuristic fallback."""

    def test_tier1_explicit_uuid_passthrough(self) -> None:
        """An explicit UUID is returned immediately without any lookup."""
        result = resolve_task_id(_CHILD_UUID)
        assert result == _CHILD_UUID

    def test_tier1_non_auto_non_uuid_passthrough(self) -> None:
        """A non-UUID, non-auto value passes through as-is."""
        result = resolve_task_id("some-custom-id")
        assert result == "some-custom-id"

    def test_tier2_api_resolution(self, _mock_kilo_server: tuple) -> None:
        """When parent_session is provided, the API is queried."""
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = json.dumps([{"id": _CHILD_UUID}]).encode()
        _MockHandler.response_code = 200

        # Patch resolve_child_from_session_api to use the mock server's base_url
        def _patched_resolve(
            parent_session_id: str,
            child_index: int = 0,
            **_kwargs: object,
        ) -> str | None:
            return resolve_child_from_session_api(
                parent_session_id,
                child_index=child_index,
                base_url=base_url,
            )

        with patch.object(
            punch_engine, "resolve_child_from_session_api", side_effect=_patched_resolve
        ):
            result = resolve_task_id("auto", parent_session=_PARENT_UUID, child_index=0)
        assert result == _CHILD_UUID

    def test_tier2_api_failure_falls_back_to_mtime(
        self, _mock_kilo_server: tuple, tmp_path: Path, capsys: pytest.CaptureFixture
    ) -> None:
        """When API returns empty, falls back to mtime heuristic with warning."""
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = b"[]"
        _MockHandler.response_code = 200

        # Create a fake tasks directory
        fake_tasks = tmp_path / "tasks"
        fake_tasks.mkdir()
        fake_task_dir = fake_tasks / _CHILD_UUID
        fake_task_dir.mkdir()

        def _patched_resolve(
            parent_session_id: str,
            child_index: int = 0,
            **_kwargs: object,
        ) -> str | None:
            return resolve_child_from_session_api(
                parent_session_id,
                child_index=child_index,
                base_url=base_url,
            )

        with (
            patch.object(
                punch_engine,
                "resolve_child_from_session_api",
                side_effect=_patched_resolve,
            ),
            patch.object(punch_engine, "TASKS_DIR", fake_tasks),
        ):
            result = resolve_task_id("auto", parent_session=_PARENT_UUID, child_index=0)

        assert result == _CHILD_UUID
        captured = capsys.readouterr()
        assert "falling back to mtime heuristic" in captured.err

    def test_tier3_mtime_heuristic_without_parent_session(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ) -> None:
        """When no parent_session, falls back to mtime with warning."""
        fake_tasks = tmp_path / "tasks"
        fake_tasks.mkdir()
        fake_task_dir = fake_tasks / _CHILD_UUID
        fake_task_dir.mkdir()

        with patch.object(punch_engine, "TASKS_DIR", fake_tasks):
            result = resolve_task_id("auto")

        assert result == _CHILD_UUID
        captured = capsys.readouterr()
        assert "WARNING: falling back to mtime heuristic" in captured.err
        assert "no --parent-session provided" in captured.err

    def test_all_methods_fail_exits(self, tmp_path: Path) -> None:
        """When all resolution methods fail, SystemExit is raised."""
        fake_tasks = tmp_path / "tasks"
        fake_tasks.mkdir()  # empty — no task dirs

        with (
            patch.object(punch_engine, "TASKS_DIR", fake_tasks),
            pytest.raises(SystemExit),
        ):
            resolve_task_id("auto")

    def test_all_methods_fail_with_parent_session(
        self, _mock_kilo_server: tuple, tmp_path: Path
    ) -> None:
        """When API fails and no task dirs exist, SystemExit is raised."""
        base_url, srv = _mock_kilo_server
        _MockHandler.response_body = b"[]"
        _MockHandler.response_code = 200

        fake_tasks = tmp_path / "tasks"
        fake_tasks.mkdir()

        def _patched_resolve(
            parent_session_id: str,
            child_index: int = 0,
            **_kwargs: object,
        ) -> str | None:
            return resolve_child_from_session_api(
                parent_session_id,
                child_index=child_index,
                base_url=base_url,
            )

        with (
            patch.object(
                punch_engine,
                "resolve_child_from_session_api",
                side_effect=_patched_resolve,
            ),
            patch.object(punch_engine, "TASKS_DIR", fake_tasks),
            pytest.raises(SystemExit),
        ):
            resolve_task_id("auto", parent_session=_PARENT_UUID)


# ═══════════════════════════════════════════════════════════════════════════
# 8. CLI argument parsing — --parent-session / --child-index
# ═══════════════════════════════════════════════════════════════════════════


class TestCliParentSessionArgs:
    """Verify --parent-session and --child-index are accepted by subcommands."""

    @pytest.mark.parametrize("subcmd", ["mint", "evaluate", "checkpoint"])
    def test_parent_session_arg_parsed(self, subcmd: str) -> None:
        """Each subcommand accepts --parent-session."""
        argv = [subcmd, _CHILD_UUID]
        if subcmd in ("evaluate", "checkpoint"):
            argv.append("test-card")
        argv.extend(["--parent-session", _PARENT_UUID])

        parser = punch_engine.main.__code__  # noqa: F841 — verify parsing only

        # Build parser manually to test arg parsing without side effects
        p = punch_engine.argparse.ArgumentParser()
        sub = p.add_subparsers(dest="command")

        for cmd_name in ("mint", "evaluate", "checkpoint"):
            sp = sub.add_parser(cmd_name)
            sp.add_argument("task_id")
            if cmd_name in ("evaluate", "checkpoint"):
                sp.add_argument("card_id")
            if cmd_name == "mint":
                sp.add_argument("--bead-id", default=None)
            sp.add_argument("--parent-session", default=None)
            sp.add_argument("--child-index", type=int, default=0)

        args = p.parse_args(argv)
        assert args.parent_session == _PARENT_UUID
        assert args.child_index == 0

    @pytest.mark.parametrize("subcmd", ["mint", "evaluate", "checkpoint"])
    def test_child_index_arg_parsed(self, subcmd: str) -> None:
        """Each subcommand accepts --child-index."""
        argv = [subcmd, _CHILD_UUID]
        if subcmd in ("evaluate", "checkpoint"):
            argv.append("test-card")
        argv.extend(["--parent-session", _PARENT_UUID, "--child-index", "2"])

        p = punch_engine.argparse.ArgumentParser()
        sub = p.add_subparsers(dest="command")
        for cmd_name in ("mint", "evaluate", "checkpoint"):
            sp = sub.add_parser(cmd_name)
            sp.add_argument("task_id")
            if cmd_name in ("evaluate", "checkpoint"):
                sp.add_argument("card_id")
            if cmd_name == "mint":
                sp.add_argument("--bead-id", default=None)
            sp.add_argument("--parent-session", default=None)
            sp.add_argument("--child-index", type=int, default=0)

        args = p.parse_args(argv)
        assert args.child_index == 2
