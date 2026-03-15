"""Unit tests for the punch card engine (.kilocode/tools/punch_engine.py).

Covers:
- _insert_checkpoint always writes both missing_punches and violations columns
- Deterministic child task ID resolution via kilo serve session API
- 3-tier resolve_task_id strategy (explicit → API → mtime heuristic)
- Warning telemetry when falling back to mtime heuristic
- CLI argument parsing via build_parser()
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
_insert_checkpoint = punch_engine._insert_checkpoint
resolve_task_id = punch_engine.resolve_task_id
resolve_child_from_session_api = punch_engine.resolve_child_from_session_api
build_parser = punch_engine.build_parser

# A valid UUID v4 for testing
_CHILD_UUID = "01961f3a-b8c5-7c2e-9b3e-7a1b2c3d4e5f"
_PARENT_UUID = "01961f3a-0000-7000-8000-000000000001"


# ═══════════════════════════════════════════════════════════════════════════
# Shared fixtures and helpers
# ═══════════════════════════════════════════════════════════════════════════


class _MockHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that serves canned children responses.

    NOTE: Uses class-level response configuration — not safe for pytest-xdist.
    """

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
    """Start a temporary HTTP server mimicking kilo serve.

    NOTE: Uses class-level response configuration — not safe for pytest-xdist.
    """
    # Reset to defaults before each test
    _MockHandler.response_body = b"[]"
    _MockHandler.response_code = 200
    server = HTTPServer(("127.0.0.1", 0), _MockHandler)
    port = server.server_address[1]
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}", server
    server.shutdown()
    # Reset after test to avoid stale state
    _MockHandler.response_body = b"[]"
    _MockHandler.response_code = 200


def _make_patched_resolve(base_url: str):
    """Return a patched resolve_child_from_session_api that routes to base_url."""

    def _patched(
        parent_session_id: str,
        child_index: int = 0,
        **_kwargs: object,
    ) -> str | None:
        return resolve_child_from_session_api(
            parent_session_id,
            child_index=child_index,
            base_url=base_url,
        )

    return _patched


@pytest.fixture()
def fake_tasks(tmp_path: Path):
    """Create a fake TASKS_DIR with a single task directory matching _CHILD_UUID."""
    tasks = tmp_path / "tasks"
    tasks.mkdir()
    (tasks / _CHILD_UUID).mkdir()
    return tasks


# ═══════════════════════════════════════════════════════════════════════════
# 1. _insert_checkpoint always includes violations column
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
# 2. resolve_child_from_session_api — kilo serve API resolution
# ═══════════════════════════════════════════════════════════════════════════


class TestResolveChildFromSessionApi:
    """resolve_child_from_session_api queries the kilo serve children endpoint."""

    def test_returns_child_id_on_success(self, _mock_kilo_server: tuple) -> None:
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = json.dumps([{"id": _CHILD_UUID}]).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result == _CHILD_UUID

    def test_returns_none_on_empty_children(self, _mock_kilo_server: tuple) -> None:
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = b"[]"
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None

    def test_returns_none_on_out_of_range_index(self, _mock_kilo_server: tuple) -> None:
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = json.dumps([{"id": _CHILD_UUID}]).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=5, base_url=base_url
        )
        assert result is None

    def test_returns_second_child_with_index_1(self, _mock_kilo_server: tuple) -> None:
        base_url, _ = _mock_kilo_server
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
        base_url, _ = _mock_kilo_server
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
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = b"not json"
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None

    def test_returns_none_on_non_array_response(self, _mock_kilo_server: tuple) -> None:
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = json.dumps({"id": _CHILD_UUID}).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None

    def test_returns_none_when_child_id_not_uuid(
        self, _mock_kilo_server: tuple
    ) -> None:
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = json.dumps([{"id": "not-a-uuid"}]).encode()
        _MockHandler.response_code = 200
        result = resolve_child_from_session_api(
            _PARENT_UUID, child_index=0, base_url=base_url
        )
        assert result is None


# ═══════════════════════════════════════════════════════════════════════════
# 3. resolve_task_id — 3-tier resolution strategy
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
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = json.dumps([{"id": _CHILD_UUID}]).encode()
        _MockHandler.response_code = 200

        with patch.object(
            punch_engine,
            "resolve_child_from_session_api",
            side_effect=_make_patched_resolve(base_url),
        ):
            result = resolve_task_id("auto", parent_session=_PARENT_UUID, child_index=0)
        assert result == _CHILD_UUID

    def test_tier2_api_failure_falls_back_to_mtime(
        self,
        _mock_kilo_server: tuple,
        fake_tasks: Path,
        capsys: pytest.CaptureFixture,
    ) -> None:
        """When API returns empty, falls back to mtime heuristic with warning."""
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = b"[]"
        _MockHandler.response_code = 200

        with (
            patch.object(
                punch_engine,
                "resolve_child_from_session_api",
                side_effect=_make_patched_resolve(base_url),
            ),
            patch.object(punch_engine, "TASKS_DIR", fake_tasks),
        ):
            result = resolve_task_id("auto", parent_session=_PARENT_UUID, child_index=0)

        assert result == _CHILD_UUID
        captured = capsys.readouterr()
        assert "falling back to mtime heuristic" in captured.err

    def test_tier3_mtime_heuristic_without_parent_session(
        self, fake_tasks: Path, capsys: pytest.CaptureFixture
    ) -> None:
        """When no parent_session, falls back to mtime with warning."""
        with patch.object(punch_engine, "TASKS_DIR", fake_tasks):
            result = resolve_task_id("auto")

        assert result == _CHILD_UUID
        captured = capsys.readouterr()
        assert "WARNING: falling back to mtime heuristic" in captured.err
        assert "no --parent-session provided" in captured.err

    def test_all_methods_fail_exits(self, tmp_path: Path) -> None:
        """When all resolution methods fail, SystemExit is raised."""
        empty_tasks = tmp_path / "tasks"
        empty_tasks.mkdir()  # empty — no task dirs

        with (
            patch.object(punch_engine, "TASKS_DIR", empty_tasks),
            pytest.raises(SystemExit),
        ):
            resolve_task_id("auto")

    def test_all_methods_fail_with_parent_session(
        self, _mock_kilo_server: tuple, tmp_path: Path
    ) -> None:
        """When API fails and no task dirs exist, SystemExit is raised."""
        base_url, _ = _mock_kilo_server
        _MockHandler.response_body = b"[]"
        _MockHandler.response_code = 200

        empty_tasks = tmp_path / "tasks"
        empty_tasks.mkdir()

        with (
            patch.object(
                punch_engine,
                "resolve_child_from_session_api",
                side_effect=_make_patched_resolve(base_url),
            ),
            patch.object(punch_engine, "TASKS_DIR", empty_tasks),
            pytest.raises(SystemExit),
        ):
            resolve_task_id("auto", parent_session=_PARENT_UUID)


# ═══════════════════════════════════════════════════════════════════════════
# 4. CLI argument parsing — --parent-session / --child-index
# ═══════════════════════════════════════════════════════════════════════════


class TestCliParentSessionArgs:
    """Verify --parent-session and --child-index are accepted by subcommands."""

    @pytest.mark.parametrize("subcmd", ["evaluate", "checkpoint"])
    def test_parent_session_arg_parsed(self, subcmd: str) -> None:
        """Each subcommand accepts --parent-session."""
        argv = [subcmd, _CHILD_UUID]
        argv.append("test-card")
        argv.extend(["--parent-session", _PARENT_UUID])

        parser = build_parser()
        args = parser.parse_args(argv)
        assert args.parent_session == _PARENT_UUID
        assert args.child_index == 0

    @pytest.mark.parametrize("subcmd", ["evaluate", "checkpoint"])
    def test_child_index_arg_parsed(self, subcmd: str) -> None:
        """Each subcommand accepts --child-index."""
        argv = [subcmd, _CHILD_UUID]
        argv.append("test-card")
        argv.extend(["--parent-session", _PARENT_UUID, "--child-index", "2"])

        parser = build_parser()
        args = parser.parse_args(argv)
        assert args.child_index == 2
