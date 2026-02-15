"""Raw call-site artifact generator."""

from __future__ import annotations

from typing import Any

from artifacts.models.artifacts.calls_raw import CallEvidence, CallRawRecord
from artifacts.utils import _get_output_dir_name, _write_jsonl
from contract.artifacts import CALLS_RAW_JSONL
from parse.treesitter_calls import extract_calls_treesitter
from scan.files import find_python_files


class CallsRawGenerator:
    """Generates calls_raw.jsonl artifact from Python source files."""

    @property
    def name(self) -> str:
        """Generator name for logging and identification."""
        return "calls_raw"

    def generate(
        self,
        root,
        out_dir,
        include_patterns: list[str] | None = None,
        exclude_patterns: list[str] | None = None,
        nested_gitignore: bool = False,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Generate calls_raw artifact."""
        out_dir.mkdir(parents=True, exist_ok=True)

        out_dir_name = _get_output_dir_name(out_dir, root)
        records: list[CallRawRecord] = []

        for file_path in find_python_files(
            root,
            output_dir=out_dir_name,
            include_patterns=include_patterns,
            exclude_patterns=exclude_patterns,
            nested_gitignore=nested_gitignore,
        ):
            call_sites = extract_calls_treesitter(str(file_path), str(root))
            for call_site in call_sites:
                src_span = call_site["src_span"]
                callee_expr = str(call_site["callee_expr"]).strip()
                records.append(
                    CallRawRecord(
                        ref_id=(
                            f"ref:{src_span['path']}"
                            f"@L{src_span['start_line']}"
                            f":C{src_span['start_col']}"
                            f":call:{callee_expr}"
                        ),
                        src_span=call_site["src_span"],
                        callee_expr=callee_expr,
                        enclosing_symbol_id=call_site["enclosing_symbol_id"],
                        resolved_to=None,
                        evidence=CallEvidence(strategy="syntax_only"),
                    )
                )

        records.sort(
            key=lambda record: (
                record.src_span.path,
                record.src_span.start_line,
                record.src_span.start_col,
                "call",
                record.enclosing_symbol_id or "",
                record.callee_expr,
            )
        )

        _write_jsonl(out_dir / CALLS_RAW_JSONL, records)

        record_dicts = [record.model_dump() for record in records]
        return record_dicts, {}


__all__ = ["CALLS_RAW_JSONL", "CallsRawGenerator"]
