"""Resolved calls artifact generator."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from artifacts.models.artifacts.calls import CallRecord
from artifacts.models.artifacts.refs import RefEvidence, ResolvedTo, SourceSpan
from artifacts.utils import _load_jsonl, _write_jsonl
from contract.artifacts import CALLS_JSONL, REFS_JSONL


class CallsGenerator:
    """Generates calls.jsonl as projection of refs.jsonl call records."""

    @property
    def name(self) -> str:
        """Generator name for logging and identification."""
        return "calls"

    def generate(
        self,
        root: Path,
        out_dir: Path,
        **kwargs: Any,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Generate calls artifact."""
        del root, kwargs
        out_dir.mkdir(parents=True, exist_ok=True)

        refs_records = _load_jsonl(out_dir / REFS_JSONL)

        calls: list[CallRecord] = []
        for record in refs_records:
            if record.get("ref_kind") != "call":
                continue

            ref_id = record.get("ref_id")
            src_span_obj = record.get("src_span")
            callee_expr = record.get("expr")
            module = record.get("module")
            enclosing_symbol_id = record.get("enclosing_symbol_id")
            resolved_to_obj = record.get("resolved_to")
            resolved_base_to_obj = record.get("resolved_base_to")
            member_obj = record.get("member")
            evidence_obj = record.get("evidence")

            if not isinstance(ref_id, str):
                continue
            if not isinstance(src_span_obj, dict):
                continue
            if not isinstance(callee_expr, str):
                continue
            if not isinstance(module, str):
                continue
            if enclosing_symbol_id is not None and not isinstance(
                enclosing_symbol_id, str
            ):
                continue
            if not isinstance(evidence_obj, dict):
                continue

            resolved_to = (
                ResolvedTo(**resolved_to_obj)
                if isinstance(resolved_to_obj, dict)
                else None
            )
            resolved_base_to = (
                ResolvedTo(**resolved_base_to_obj)
                if isinstance(resolved_base_to_obj, dict)
                else None
            )
            member = member_obj if isinstance(member_obj, str) else None

            calls.append(
                CallRecord(
                    ref_id=ref_id,
                    src_span=SourceSpan(**src_span_obj),
                    callee_expr=callee_expr,
                    module=module,
                    enclosing_symbol_id=enclosing_symbol_id,
                    resolved_to=resolved_to,
                    resolved_base_to=resolved_base_to,
                    member=member,
                    evidence=RefEvidence(**evidence_obj),
                )
            )

        _write_jsonl(out_dir / CALLS_JSONL, calls)

        call_dicts = [record.model_dump() for record in calls]
        return call_dicts, {}


__all__ = ["CALLS_JSONL", "CallsGenerator"]
