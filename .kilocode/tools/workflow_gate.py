"""Workflow-specific quality gates for plant-manager validation.

Validates the integrity of the fabrication plant's configuration:
- Mode definitions (.kilocodemodes)
- Skill files (.kilocode/skills/)
- Contract templates (.kilocode/contracts/)
- Workflow coherence (regex patterns, tool groups)

Usage:
    .venv/bin/python .kilocode/tools/workflow_gate.py [--root DIR] [--gate GATE_ID]

Via bounded_gate.py:
    .venv/bin/python .kilocode/tools/bounded_gate.py \\
        --gate-id workflow-validation --bead-id <id> \\
        -- .venv/bin/python .kilocode/tools/workflow_gate.py

Exit codes:
    0 = all sub-gates pass
    1 = at least one sub-gate fails
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Known valid values
# ---------------------------------------------------------------------------

KNOWN_GROUPS = frozenset({"read", "edit", "command", "mcp", "browser"})

MODE_REQUIRED_FIELDS = ("slug", "name", "roleDefinition", "groups")

SKILL_FRONTMATTER_FIELDS = ("name", "description")


# ---------------------------------------------------------------------------
# Sub-gate result helper
# ---------------------------------------------------------------------------


def _result(gate_id: str, findings: list[str]) -> dict[str, Any]:
    return {
        "gate_id": gate_id,
        "status": "FAIL" if findings else "PASS",
        "findings": findings,
    }


# ---------------------------------------------------------------------------
# Sub-gate 1: Mode validation
# ---------------------------------------------------------------------------


def validate_modes(root: Path) -> dict[str, Any]:
    """Parse .kilocodemodes, check required fields and slug uniqueness."""
    findings: list[str] = []
    modes_path = root / ".kilocodemodes"

    if not modes_path.exists():
        findings.append(f"File not found: {modes_path}")
        return _result("mode-validation", findings)

    try:
        import yaml
    except ImportError:
        findings.append("PyYAML not installed; cannot parse .kilocodemodes")
        return _result("mode-validation", findings)

    try:
        with open(modes_path) as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        findings.append(f"YAML parse error: {exc}")
        return _result("mode-validation", findings)

    if not isinstance(data, dict):
        findings.append(f"Expected top-level dict, got {type(data).__name__}")
        return _result("mode-validation", findings)

    modes = data.get("customModes")
    if not isinstance(modes, list):
        findings.append("Missing or invalid 'customModes' key (expected list)")
        return _result("mode-validation", findings)

    slugs_seen: dict[str, int] = {}
    for i, mode in enumerate(modes):
        if not isinstance(mode, dict):
            findings.append(f"Mode #{i}: expected dict, got {type(mode).__name__}")
            continue

        slug = mode.get("slug", f"<missing-slug-#{i}>")

        # Required fields
        for field in MODE_REQUIRED_FIELDS:
            if field not in mode or not mode[field]:
                findings.append(f"Mode '{slug}': missing required field '{field}'")

        # Slug uniqueness
        if slug in slugs_seen:
            findings.append(
                f"Duplicate slug '{slug}' (first at index {slugs_seen[slug]}, "
                f"duplicate at index {i})"
            )
        else:
            slugs_seen[slug] = i

        # Groups validation (delegate detailed check to coherence gate)
        groups = mode.get("groups")
        if groups is not None and not isinstance(groups, list):
            findings.append(
                f"Mode '{slug}': 'groups' should be a list, got {type(groups).__name__}"
            )

    return _result("mode-validation", findings)


# ---------------------------------------------------------------------------
# Sub-gate 2: Skill loading
# ---------------------------------------------------------------------------


def validate_skills(root: Path) -> dict[str, Any]:
    """Check that all skill directories contain valid SKILL.md files."""
    findings: list[str] = []
    skills_dir = root / ".kilocode" / "skills"

    if not skills_dir.exists():
        findings.append(f"Skills directory not found: {skills_dir}")
        return _result("skill-loading", findings)

    for entry in sorted(skills_dir.iterdir()):
        if not entry.is_dir():
            continue

        skill_md = entry / "SKILL.md"
        if not skill_md.exists():
            findings.append(f"Missing SKILL.md in {entry.name}/")
            continue

        content = skill_md.read_text(encoding="utf-8")
        if not content.strip():
            findings.append(f"Empty SKILL.md in {entry.name}/")
            continue

        # Check YAML frontmatter
        if not content.startswith("---"):
            findings.append(
                f"SKILL.md in {entry.name}/ missing YAML frontmatter (no leading ---)"
            )
            continue

        # Extract frontmatter
        parts = content.split("---", 2)
        if len(parts) < 3:
            findings.append(
                f"SKILL.md in {entry.name}/ has malformed frontmatter (missing closing ---)"
            )
            continue

        frontmatter_text = parts[1].strip()
        if not frontmatter_text:
            findings.append(f"SKILL.md in {entry.name}/ has empty frontmatter")
            continue

        try:
            import yaml

            fm = yaml.safe_load(frontmatter_text)
        except Exception as exc:
            findings.append(f"SKILL.md in {entry.name}/ frontmatter parse error: {exc}")
            continue

        if not isinstance(fm, dict):
            findings.append(f"SKILL.md in {entry.name}/ frontmatter is not a dict")
            continue

        for field in SKILL_FRONTMATTER_FIELDS:
            if field not in fm or not fm[field]:
                findings.append(
                    f"SKILL.md in {entry.name}/ missing frontmatter field '{field}'"
                )

    return _result("skill-loading", findings)


# ---------------------------------------------------------------------------
# Sub-gate 3: Contract parsing
# ---------------------------------------------------------------------------


def validate_contracts(root: Path) -> dict[str, Any]:
    """Check that all contract .md files exist, are non-empty, and have headings."""
    findings: list[str] = []
    contracts_dir = root / ".kilocode" / "contracts"

    if not contracts_dir.exists():
        findings.append(f"Contracts directory not found: {contracts_dir}")
        return _result("contract-parsing", findings)

    md_files = sorted(contracts_dir.rglob("*.md"))
    if not md_files:
        findings.append("No .md files found in contracts directory")
        return _result("contract-parsing", findings)

    for md_file in md_files:
        rel = md_file.relative_to(contracts_dir)
        content = md_file.read_text(encoding="utf-8")

        if not content.strip():
            findings.append(f"Empty contract file: {rel}")
            continue

        # Check for at least one markdown heading
        if not re.search(r"^#+\s+", content, re.MULTILINE):
            findings.append(f"Contract file {rel} has no markdown heading")

    return _result("contract-parsing", findings)


# ---------------------------------------------------------------------------
# Sub-gate 4: Workflow coherence
# ---------------------------------------------------------------------------


def validate_coherence(root: Path) -> dict[str, Any]:
    """Check fileRegex patterns compile and groups are from known set."""
    findings: list[str] = []
    modes_path = root / ".kilocodemodes"

    if not modes_path.exists():
        findings.append(f"File not found: {modes_path}")
        return _result("workflow-coherence", findings)

    try:
        import yaml

        with open(modes_path) as f:
            data = yaml.safe_load(f)
    except Exception as exc:
        findings.append(f"Cannot load .kilocodemodes: {exc}")
        return _result("workflow-coherence", findings)

    modes = data.get("customModes", []) if isinstance(data, dict) else []

    for mode in modes:
        if not isinstance(mode, dict):
            continue

        slug = mode.get("slug", "<unknown>")

        # fileRegex validation
        file_regex = mode.get("fileRegex")
        if file_regex is not None:
            if not isinstance(file_regex, str):
                findings.append(
                    f"Mode '{slug}': fileRegex is {type(file_regex).__name__}, expected string"
                )
            else:
                try:
                    re.compile(file_regex)
                except re.error as exc:
                    findings.append(f"Mode '{slug}': fileRegex does not compile: {exc}")

        # Groups validation
        groups = mode.get("groups")
        if isinstance(groups, list):
            for g in groups:
                if isinstance(g, str) and g not in KNOWN_GROUPS:
                    findings.append(
                        f"Mode '{slug}': unknown group '{g}' "
                        f"(known: {', '.join(sorted(KNOWN_GROUPS))})"
                    )

    return _result("workflow-coherence", findings)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

ALL_GATES = {
    "mode-validation": validate_modes,
    "skill-loading": validate_skills,
    "contract-parsing": validate_contracts,
    "workflow-coherence": validate_coherence,
}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Workflow-specific quality gates for plant configuration."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Project root directory (default: auto-detect from script location)",
    )
    parser.add_argument(
        "--gate",
        choices=list(ALL_GATES.keys()),
        default=None,
        help="Run a specific sub-gate (default: run all)",
    )
    args = parser.parse_args()

    # Auto-detect root: script is at .kilocode/tools/workflow_gate.py
    if args.root is None:
        script_dir = Path(__file__).resolve().parent
        root = script_dir.parent.parent  # .kilocode/tools -> .kilocode -> project root
    else:
        root = args.root.resolve()

    if not (root / ".kilocodemodes").exists() and not (root / ".kilocode").exists():
        print(
            json.dumps(
                {
                    "gate": "workflow-validation",
                    "status": "FAIL",
                    "error": f"Cannot find plant files at root: {root}",
                }
            )
        )
        return 1

    # Run gates
    if args.gate:
        gates_to_run = {args.gate: ALL_GATES[args.gate]}
    else:
        gates_to_run = ALL_GATES

    sub_results = []
    for gate_id, gate_fn in gates_to_run.items():
        sub_results.append(gate_fn(root))

    overall_status = (
        "PASS" if all(r["status"] == "PASS" for r in sub_results) else "FAIL"
    )

    output = {
        "gate": "workflow-validation",
        "status": overall_status,
        "sub_gates": sub_results,
    }

    print(json.dumps(output, indent=2))
    return 0 if overall_status == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
