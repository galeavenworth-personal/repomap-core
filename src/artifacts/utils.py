"""Utility functions for artifact generation."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import orjson

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

    from artifacts.models.artifacts.integrations import IntegrationTag


INTEGRATION_TAG_RULES: dict[str, IntegrationTag] = {
    "sqlalchemy": "database",
    "psycopg2": "database",
    "psycopg": "database",
    "sqlite3": "database",
    "pymongo": "database",
    "redis": "database",
    "pymysql": "database",
    "asyncpg": "database",
    "databases": "database",
    "motor": "database",
    "peewee": "database",
    "tortoise": "database",
    "requests": "http",
    "httpx": "http",
    "aiohttp": "http",
    "urllib": "http",
    "urllib3": "http",
    "httplib2": "http",
    "fastapi": "http",
    "flask": "http",
    "django": "http",
    "starlette": "http",
    "tornado": "http",
    "bottle": "http",
    "logging": "logging",
    "loguru": "logging",
    "structlog": "logging",
    "pytest": "testing",
    "unittest": "testing",
    "mock": "testing",
    "hypothesis": "testing",
    "faker": "testing",
    "factory_boy": "testing",
    "typer": "cli",
    "click": "cli",
    "argparse": "cli",
    "rich": "cli",
    "json": "serialization",
    "orjson": "serialization",
    "ujson": "serialization",
    "pydantic": "serialization",
    "msgpack": "serialization",
    "pickle": "serialization",
    "yaml": "serialization",
    "toml": "serialization",
    "tomllib": "serialization",
    "tomli": "serialization",
    "marshmallow": "serialization",
    "asyncio": "async",
    "trio": "async",
    "anyio": "async",
    "curio": "async",
    "pathlib": "file_io",
    "shutil": "file_io",
    "tempfile": "file_io",
    "glob": "file_io",
    "fnmatch": "file_io",
    "fileinput": "file_io",
}


def _get_integration_tag(
    module: str,
    extra_rules: dict[str, IntegrationTag] | None = None,
) -> IntegrationTag | None:
    """Get the integration tag for a module, if any."""
    top_level = module.split(".")[0]
    if extra_rules and top_level in extra_rules:
        return extra_rules[top_level]
    return INTEGRATION_TAG_RULES.get(top_level)


def _to_dict(obj: object) -> object:
    """Convert object to dict for JSON serialization."""
    from dataclasses import asdict, is_dataclass

    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if is_dataclass(obj) and not isinstance(obj, type):
        return asdict(obj)
    return obj


def _write_jsonl(path: Path, records: Sequence[object]) -> None:
    with path.open("wb") as f:
        for rec in records:
            payload = _to_dict(rec)
            f.write(orjson.dumps(payload, option=orjson.OPT_SORT_KEYS))
            f.write(b"\n")


def _write_json(path: Path, obj: object) -> None:
    payload = _to_dict(obj)
    opts = orjson.OPT_SORT_KEYS | orjson.OPT_INDENT_2
    path.write_bytes(orjson.dumps(payload, option=opts))


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    """Load records from a JSONL file."""
    records: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                record = json.loads(line)
                if isinstance(record, dict):
                    records.append(record)
    return records


def _get_output_dir_name(out_dir: Path, root: Path) -> str:
    """Get the output directory name for filtering."""
    try:
        if out_dir.is_relative_to(root):
            rel = out_dir.relative_to(root)
            if rel.parts:
                return rel.parts[0]
            return ""
    except ValueError:
        # Non-comparable paths mean out_dir is external; avoid filtering.
        return ""
    return ""
