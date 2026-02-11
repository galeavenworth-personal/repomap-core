"""Command-line interface for repomap-core."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from artifacts.write import generate_all_artifacts
from contract.validation import validate_artifacts
from rules.config import load_config
from verify.verify import verify_determinism


def _add_common_paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "root",
        nargs="?",
        default=".",
        help="Repository root (default: .)",
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="repomap")
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate_parser = subparsers.add_parser("generate", help="Generate artifacts")
    _add_common_paths(generate_parser)
    generate_parser.add_argument(
        "--out-dir",
        default=None,
        help="Output directory for generated artifacts (default: config output dir)",
    )

    validate_parser = subparsers.add_parser("validate", help="Validate artifacts")
    _add_common_paths(validate_parser)
    validate_parser.add_argument(
        "--artifacts-dir",
        default=None,
        help="Artifacts directory (default: config output dir)",
    )

    verify_parser = subparsers.add_parser(
        "verify", help="Verify determinism of artifacts"
    )
    _add_common_paths(verify_parser)
    verify_parser.add_argument(
        "--artifacts-dir",
        default=None,
        help="Artifacts directory (default: config output dir)",
    )

    return parser


def _resolve_output_dir(root: Path, out_dir: str | None) -> Path | None:
    if out_dir is None:
        return None
    return Path(out_dir).expanduser().resolve()


def _resolve_artifacts_dir(root: Path, artifacts_dir: str | None) -> Path:
    if artifacts_dir is None:
        config = load_config(root)
        return (root / config.output_dir).resolve()
    return Path(artifacts_dir).expanduser().resolve()


def _handle_generate(root: Path, out_dir: str | None) -> int:
    resolved_out_dir = _resolve_output_dir(root, out_dir)
    generate_all_artifacts(root=root, out_dir=resolved_out_dir)
    return 0


def _handle_validate(root: Path, artifacts_dir: str | None) -> int:
    resolved_artifacts_dir = _resolve_artifacts_dir(root, artifacts_dir)
    result = validate_artifacts(resolved_artifacts_dir)
    if result.errors:
        for error in result.errors:
            sys.stderr.write(f"{error.location()}: {error.message}\n")
        return 1
    return 0


def _handle_verify(root: Path, artifacts_dir: str | None) -> int:
    resolved_artifacts_dir = _resolve_artifacts_dir(root, artifacts_dir)
    try:
        result = verify_determinism(root=root, artifacts_dir=resolved_artifacts_dir)
    except (FileNotFoundError, NotADirectoryError) as exc:
        sys.stderr.write(f"artifacts-dir: {resolved_artifacts_dir}\n")
        sys.stderr.write(f"error: {exc}\n")
        return 2
    if not result.ok:
        for label, paths in (
            ("missing", result.missing),
            ("extra", result.extra),
            ("mismatches", result.mismatches),
        ):
            for path in paths:
                sys.stderr.write(f"{label}: {path}\n")
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    root = Path(args.root).expanduser().resolve()

    if args.command == "generate":
        return _handle_generate(root, args.out_dir)

    if args.command == "validate":
        return _handle_validate(root, args.artifacts_dir)

    if args.command == "verify":
        return _handle_verify(root, args.artifacts_dir)

    raise AssertionError


if __name__ == "__main__":
    raise SystemExit(main())
