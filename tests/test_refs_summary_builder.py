"""Tests for the refs_summary builder."""

from __future__ import annotations

from typing import Any

from artifacts.models.artifacts.refs_summary import RefsSummary
from artifacts.summaries.refs_summary_builder import build_refs_summary


def _make_ref(
    *,
    ref_kind: str = "call",
    resolved_to: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Helper to build a minimal ref dict."""
    return {
        "schema_version": 2,
        "ref_id": "ref:test",
        "ref_kind": ref_kind,
        "src_span": {
            "path": "a.py",
            "start_line": 1,
            "start_col": 0,
            "end_line": 1,
            "end_col": 5,
        },
        "module": "a",
        "enclosing_symbol_id": None,
        "expr": "foo",
        "resolved_to": resolved_to,
        "evidence": {"strategy": "scope", "confidence": 80},
    }


def _make_call(
    *,
    resolved_to: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Helper to build a minimal call dict."""
    return {
        "schema_version": 2,
        "ref_id": "ref:test:call",
        "src_span": {
            "path": "a.py",
            "start_line": 1,
            "start_col": 0,
            "end_line": 1,
            "end_col": 5,
        },
        "callee_expr": "foo()",
        "module": "a",
        "enclosing_symbol_id": None,
        "resolved_to": resolved_to,
        "resolved_base_to": None,
        "member": None,
        "evidence": {"strategy": "scope", "confidence": 80},
    }


def _make_resolved_to(
    *,
    symbol_id: str = "sym:a.Foo",
    resolution: str = "local",
    confidence: int = 90,
) -> dict[str, Any]:
    """Helper to build a resolved_to payload."""
    return {
        "symbol_id": symbol_id,
        "qualified_name": "a.Foo",
        "resolution": resolution,
        "confidence": confidence,
        "path": "a.py",
        "dst_module": "a",
    }


# ── Empty inputs ──────────────────────────────────────────────────────


class TestEmptyInputs:
    def test_empty_refs_and_calls(self) -> None:
        result = build_refs_summary([], [])
        assert isinstance(result, RefsSummary)
        assert result.total_refs == 0
        assert result.total_calls == 0
        assert result.refs_resolved == 0
        assert result.refs_unresolved == 0
        assert result.calls_resolved == 0
        assert result.calls_unresolved == 0
        assert result.resolution_rate_refs == 0.0
        assert result.resolution_rate_calls == 0.0
        assert result.by_ref_kind == {}
        assert result.resolution_counts.internal == 0
        assert result.resolution_counts.external == 0
        assert result.resolution_counts.unresolved == 0
        assert result.avg_confidence_refs == 0.0
        assert result.avg_confidence_calls == 0.0

    def test_empty_refs_with_calls(self) -> None:
        call = _make_call(resolved_to=_make_resolved_to())
        result = build_refs_summary([], [call])
        assert result.total_refs == 0
        assert result.total_calls == 1
        assert result.calls_resolved == 1

    def test_refs_with_empty_calls(self) -> None:
        ref = _make_ref(resolved_to=_make_resolved_to())
        result = build_refs_summary([ref], [])
        assert result.total_refs == 1
        assert result.total_calls == 0
        assert result.refs_resolved == 1


# ── Unresolved-only ──────────────────────────────────────────────────


class TestUnresolvedOnly:
    def test_all_refs_unresolved(self) -> None:
        refs = [_make_ref(), _make_ref(), _make_ref()]
        result = build_refs_summary(refs, [])
        assert result.total_refs == 3
        assert result.refs_resolved == 0
        assert result.refs_unresolved == 3
        assert result.resolution_rate_refs == 0.0
        assert result.avg_confidence_refs == 0.0
        assert result.resolution_counts.unresolved == 3

    def test_all_calls_unresolved(self) -> None:
        calls = [_make_call(), _make_call()]
        result = build_refs_summary([], calls)
        assert result.total_calls == 2
        assert result.calls_resolved == 0
        assert result.calls_unresolved == 2
        assert result.resolution_rate_calls == 0.0
        assert result.avg_confidence_calls == 0.0
        assert result.resolution_counts.unresolved == 2

    def test_all_unresolved_combined(self) -> None:
        refs = [_make_ref(), _make_ref()]
        calls = [_make_call()]
        result = build_refs_summary(refs, calls)
        assert result.resolution_counts.internal == 0
        assert result.resolution_counts.external == 0
        assert result.resolution_counts.unresolved == 3


# ── Fully resolved ───────────────────────────────────────────────────


class TestFullyResolved:
    def test_all_refs_resolved_internal(self) -> None:
        resolved = _make_resolved_to(resolution="local", confidence=85)
        refs = [_make_ref(resolved_to=resolved), _make_ref(resolved_to=resolved)]
        result = build_refs_summary(refs, [])
        assert result.refs_resolved == 2
        assert result.refs_unresolved == 0
        assert result.resolution_rate_refs == 1.0
        assert result.resolution_counts.internal == 2
        assert result.resolution_counts.external == 0
        assert result.avg_confidence_refs == 85.0

    def test_all_calls_resolved_external(self) -> None:
        resolved = _make_resolved_to(resolution="external", confidence=70)
        calls = [_make_call(resolved_to=resolved)]
        result = build_refs_summary([], calls)
        assert result.calls_resolved == 1
        assert result.calls_unresolved == 0
        assert result.resolution_rate_calls == 1.0
        assert result.resolution_counts.external == 1
        assert result.resolution_counts.internal == 0
        assert result.avg_confidence_calls == 70.0

    def test_stdlib_is_external(self) -> None:
        resolved = _make_resolved_to(resolution="stdlib", confidence=95)
        refs = [_make_ref(resolved_to=resolved)]
        result = build_refs_summary(refs, [])
        assert result.resolution_counts.external == 1
        assert result.resolution_counts.internal == 0

    def test_project_resolution_is_internal(self) -> None:
        resolved = _make_resolved_to(resolution="project", confidence=80)
        refs = [_make_ref(resolved_to=resolved)]
        result = build_refs_summary(refs, [])
        assert result.resolution_counts.internal == 1
        assert result.resolution_counts.external == 0

    def test_scope_resolution_is_internal(self) -> None:
        resolved = _make_resolved_to(resolution="scope", confidence=75)
        refs = [_make_ref(resolved_to=resolved)]
        result = build_refs_summary(refs, [])
        assert result.resolution_counts.internal == 1
        assert result.resolution_counts.external == 0


# ── Mixed scenarios ──────────────────────────────────────────────────


class TestMixed:
    def test_mixed_resolved_and_unresolved_refs(self) -> None:
        resolved = _make_resolved_to(confidence=80)
        refs = [_make_ref(resolved_to=resolved), _make_ref()]
        result = build_refs_summary(refs, [])
        assert result.total_refs == 2
        assert result.refs_resolved == 1
        assert result.refs_unresolved == 1
        assert result.resolution_rate_refs == 0.5
        assert result.avg_confidence_refs == 80.0

    def test_mixed_resolved_and_unresolved_calls(self) -> None:
        resolved = _make_resolved_to(confidence=60)
        calls = [_make_call(resolved_to=resolved), _make_call()]
        result = build_refs_summary([], calls)
        assert result.total_calls == 2
        assert result.calls_resolved == 1
        assert result.calls_unresolved == 1
        assert result.resolution_rate_calls == 0.5
        assert result.avg_confidence_calls == 60.0

    def test_mixed_internal_and_external(self) -> None:
        internal = _make_resolved_to(resolution="local", confidence=90)
        external = _make_resolved_to(resolution="external", confidence=70)
        stdlib = _make_resolved_to(resolution="stdlib", confidence=95)
        refs = [
            _make_ref(resolved_to=internal),
            _make_ref(resolved_to=external),
            _make_ref(resolved_to=stdlib),
            _make_ref(),  # unresolved
        ]
        calls = [
            _make_call(resolved_to=internal),
            _make_call(),  # unresolved
        ]
        result = build_refs_summary(refs, calls)
        assert result.total_refs == 4
        assert result.total_calls == 2
        assert result.refs_resolved == 3
        assert result.refs_unresolved == 1
        assert result.calls_resolved == 1
        assert result.calls_unresolved == 1
        # internal: 1 ref (local) + 1 call (local) = 2
        assert result.resolution_counts.internal == 2
        # external: 1 ref (external) + 1 ref (stdlib) = 2
        assert result.resolution_counts.external == 2
        # unresolved: 1 ref + 1 call = 2
        assert result.resolution_counts.unresolved == 2

    def test_avg_confidence_across_multiple_resolved(self) -> None:
        r1 = _make_resolved_to(confidence=80)
        r2 = _make_resolved_to(confidence=100)
        refs = [_make_ref(resolved_to=r1), _make_ref(resolved_to=r2)]
        result = build_refs_summary(refs, [])
        assert result.avg_confidence_refs == 90.0

    def test_avg_confidence_calls_across_multiple(self) -> None:
        c1 = _make_resolved_to(confidence=60)
        c2 = _make_resolved_to(confidence=80)
        c3 = _make_resolved_to(confidence=100)
        calls = [
            _make_call(resolved_to=c1),
            _make_call(resolved_to=c2),
            _make_call(resolved_to=c3),
        ]
        result = build_refs_summary([], calls)
        assert result.avg_confidence_calls == 80.0


# ── by_ref_kind breakdown ────────────────────────────────────────────


class TestByRefKind:
    def test_single_kind(self) -> None:
        resolved = _make_resolved_to()
        refs = [
            _make_ref(ref_kind="call", resolved_to=resolved),
            _make_ref(ref_kind="call"),
        ]
        result = build_refs_summary(refs, [])
        assert "call" in result.by_ref_kind
        assert result.by_ref_kind["call"].total == 2
        assert result.by_ref_kind["call"].resolved == 1
        assert result.by_ref_kind["call"].unresolved == 1

    def test_multiple_kinds(self) -> None:
        resolved = _make_resolved_to()
        refs = [
            _make_ref(ref_kind="call", resolved_to=resolved),
            _make_ref(ref_kind="attribute", resolved_to=resolved),
            _make_ref(ref_kind="attribute"),
            _make_ref(ref_kind="import", resolved_to=resolved),
        ]
        result = build_refs_summary(refs, [])
        assert set(result.by_ref_kind.keys()) == {"attribute", "call", "import"}
        assert result.by_ref_kind["call"].total == 1
        assert result.by_ref_kind["call"].resolved == 1
        assert result.by_ref_kind["attribute"].total == 2
        assert result.by_ref_kind["attribute"].resolved == 1
        assert result.by_ref_kind["attribute"].unresolved == 1
        assert result.by_ref_kind["import"].total == 1

    def test_by_ref_kind_sorted_keys(self) -> None:
        resolved = _make_resolved_to()
        refs = [
            _make_ref(ref_kind="zebra", resolved_to=resolved),
            _make_ref(ref_kind="alpha"),
            _make_ref(ref_kind="middle", resolved_to=resolved),
        ]
        result = build_refs_summary(refs, [])
        keys = list(result.by_ref_kind.keys())
        assert keys == sorted(keys)


# ── Determinism ──────────────────────────────────────────────────────


class TestDeterminism:
    def test_repeated_calls_produce_identical_output(self) -> None:
        resolved_local = _make_resolved_to(resolution="local", confidence=85)
        resolved_ext = _make_resolved_to(resolution="external", confidence=70)
        refs = [
            _make_ref(ref_kind="call", resolved_to=resolved_local),
            _make_ref(ref_kind="attribute", resolved_to=resolved_ext),
            _make_ref(ref_kind="call"),
            _make_ref(ref_kind="import", resolved_to=resolved_local),
        ]
        calls = [
            _make_call(resolved_to=resolved_local),
            _make_call(),
        ]

        result1 = build_refs_summary(refs, calls)
        result2 = build_refs_summary(refs, calls)

        assert result1.model_dump() == result2.model_dump()

    def test_model_dump_has_sorted_by_ref_kind_keys(self) -> None:
        resolved = _make_resolved_to()
        refs = [
            _make_ref(ref_kind="zebra", resolved_to=resolved),
            _make_ref(ref_kind="alpha"),
            _make_ref(ref_kind="beta", resolved_to=resolved),
        ]
        result = build_refs_summary(refs, [])
        dumped = result.model_dump()
        by_kind_keys = list(dumped["by_ref_kind"].keys())
        assert by_kind_keys == sorted(by_kind_keys)


# ── Resolution rate edge cases ───────────────────────────────────────


class TestResolutionRateEdgeCases:
    def test_resolution_rate_with_zero_total(self) -> None:
        result = build_refs_summary([], [])
        assert result.resolution_rate_refs == 0.0
        assert result.resolution_rate_calls == 0.0

    def test_resolution_rate_all_resolved(self) -> None:
        resolved = _make_resolved_to()
        refs = [_make_ref(resolved_to=resolved)]
        calls = [_make_call(resolved_to=resolved)]
        result = build_refs_summary(refs, calls)
        assert result.resolution_rate_refs == 1.0
        assert result.resolution_rate_calls == 1.0

    def test_resolution_rate_partial(self) -> None:
        resolved = _make_resolved_to()
        refs = [
            _make_ref(resolved_to=resolved),
            _make_ref(),
            _make_ref(),
        ]
        result = build_refs_summary(refs, [])
        expected = 1.0 / 3.0
        assert abs(result.resolution_rate_refs - expected) < 1e-10


# ── Schema version ───────────────────────────────────────────────────


class TestSchemaVersion:
    def test_schema_version_present(self) -> None:
        result = build_refs_summary([], [])
        assert result.schema_version == 2
