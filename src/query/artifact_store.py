"""Layer 1: Artifact Store - Normalize heterogeneous artifacts.

Normalize artifacts into queryable collections.

This module provides the ArtifactStore class which loads artifacts from the .repomap/
directory and exposes them as canonical in-memory collections with location mapping
for falsifiability.

Key responsibilities:
- Ingest artifacts from .repomap/ directory
- Normalize heterogeneous formats (JSONL, JSON, edgelist) into uniform collections
- Provide fast access to collections (list of dicts)
- Map records to stable location references (receipts for falsifiability)

Key invariant: Layer 1 contains NO verification logic. It doesn't know what "verified"
means -- it just answers "here are the records, here's how to reference them."
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path  # noqa: TC003
from typing import Protocol

import orjson

from contract.artifacts import (
    DEPS_EDGELIST,
    DEPS_SUMMARY_JSON,
    INTEGRATIONS_STATIC_JSONL,
    SYMBOLS_JSONL,
    TIER1_ARTIFACT_SPECS,
)

logger = logging.getLogger(__name__)

# Optional artifact filenames not (yet) in Tier-1 contract.
# Keep these co-located so they can be promoted to contract constants later.
_COMPLEXITY_JSONL = "complexity.jsonl"
_SECURITY_JSONL = "security.jsonl"
_LOG_NOT_FOUND = "%s not found, returning empty collection"
_LOG_READ_FAILED = "Failed to read %s: %s"


class ArtifactStoreProtocol(Protocol):
    """Layer 1 interface - artifact management.

    This Protocol defines the contract for artifact stores. It is used for
    type checking and documentation, not runtime polymorphism.
    """

    def get_collection(self, name: str) -> list[dict[str, object]]:
        """Get canonical collection by name.

        Args:
            name: Collection name (e.g., 'symbols', 'deps_edges')

        Returns:
            List of dictionaries (records)

        Raises:
            KeyError: If collection doesn't exist
        """
        ...

    def get_record_location(self, collection: str, record: dict[str, object]) -> str:
        """Get stable reference for a record (location mapping for falsifiability).

        Note: Throughout this documentation, we use "receipt" as shorthand for
        "location mapping" or "provenance reference". This refers to the stable
        string that identifies where a piece of evidence came from (e.g., file path
        and line numbers). These receipts enable falsifiability by allowing claims
        to be traced back to their source artifacts.

        Args:
            collection: Collection name
            record: The record to locate

        Returns:
            Stable location string (e.g., 'repomap/cli.py:861-867')

        Raises:
            ValueError: If record cannot be located
        """
        ...

    def list_collections(self) -> list[str]:
        """List available collections.

        Returns:
            List of collection names
        """
        ...

    @property
    def artifacts_hash(self) -> str:
        """Get hash of source artifacts (for provenance)."""
        ...


class ArtifactStore:
    """Layer 1: Artifact management with canonical collections.

    Loads and normalizes all artifacts from .repomap/ directory into queryable
    collections. Provides location mapping for falsifiability.

    Collections exposed:
    - symbols: Symbol records from symbols.jsonl
    - deps_edges: Dependency edges from deps.edgelist
    - integrations: Integration records from integrations_static.jsonl
    - fan_in: Module fan-in metrics (exploded from deps_summary.json)
    - fan_out: Module fan-out metrics (exploded from deps_summary.json)
    - layer_violations: Layer violations (from deps_summary.json)
    - cycles: Dependency cycles (from deps_summary.json)
    - complexity: Complexity metrics from complexity.jsonl (optional)
    - security: Security findings from security.jsonl (optional)
    """

    def __init__(self, artifacts_dir: Path) -> None:
        """Load and normalize all artifacts.

        Args:
            artifacts_dir: Path to .repomap/ directory
        """
        self.artifacts_dir = artifacts_dir
        self.collections: dict[str, list[dict[str, object]]] = {}
        self._load_all()
        self._artifacts_hash = self._compute_hash()

    def _load_all(self) -> None:
        """Load all artifacts into canonical collections."""
        self.collections["symbols"] = self._load_symbols()
        self.collections["deps_edges"] = self._load_deps_edges()
        self.collections["integrations"] = self._load_integrations()

        # Explode deps_summary into multiple collections
        summary_collections = self._load_deps_summary()
        self.collections.update(summary_collections)

        # Optional analyzer artifacts
        self.collections["complexity"] = self._load_complexity()
        self.collections["security"] = self._load_security()

    # ------------------------------------------------------------------
    # Tier-1 artifact loaders (filenames from contract constants)
    # ------------------------------------------------------------------

    def _load_jsonl(self, filename: str, record_label: str) -> list[dict[str, object]]:
        """Load a JSONL artifact file into a list of records.

        Args:
            filename: Artifact filename relative to artifacts_dir.
            record_label: Human-readable label for warning messages
                (e.g. "symbol", "integration").

        Returns:
            List of parsed records, or empty list on missing/unreadable file.
        """
        path = self.artifacts_dir / filename
        if not path.exists():
            logger.debug(_LOG_NOT_FOUND, filename)
            return []

        records: list[dict[str, object]] = []
        try:
            with path.open("rb") as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(orjson.loads(line))
                    except orjson.JSONDecodeError as e:
                        logger.warning(
                            "Failed to parse %s record at line %d: %s",
                            record_label,
                            line_num,
                            e,
                        )
                        continue
        except (OSError, UnicodeDecodeError) as e:
            logger.warning(_LOG_READ_FAILED, filename, e)
            return []

        return records

    def _load_symbols(self) -> list[dict[str, object]]:
        """Load symbols.jsonl.

        Returns:
            List of symbol records, or empty list if file doesn't exist
        """
        return self._load_jsonl(SYMBOLS_JSONL, "symbol")

    def _load_deps_edges(self) -> list[dict[str, object]]:
        """Load and normalize deps.edgelist.

        Converts plain text edgelist format (source -> target) into normalized
        dict format with embedded _location field.

        Returns:
            List of edge records with _location, or empty list if file doesn't exist
        """
        path = self.artifacts_dir / DEPS_EDGELIST
        if not path.exists():
            logger.debug(_LOG_NOT_FOUND, DEPS_EDGELIST)
            return []

        edges: list[dict[str, object]] = []
        try:
            with path.open("r", encoding="utf-8") as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line or "->" not in line:
                        continue
                    source, target = line.split("->", 1)
                    edges.append(
                        {
                            "source": source.strip(),
                            "target": target.strip(),
                            "_location": f"{DEPS_EDGELIST}:{line_num}",
                        }
                    )
        except (OSError, UnicodeDecodeError) as e:
            logger.warning(_LOG_READ_FAILED, DEPS_EDGELIST, e)
            return []

        return edges

    def _load_integrations(self) -> list[dict[str, object]]:
        """Load integrations_static.jsonl.

        Returns:
            List of integration records, or empty list if file doesn't exist
        """
        return self._load_jsonl(INTEGRATIONS_STATIC_JSONL, "integration")

    def _load_deps_summary(self) -> dict[str, list[dict[str, object]]]:
        """Load and explode deps_summary.json into queryable collections.

        Converts nested JSON structure into flat collections:
        - fan_in: {module: value} -> [{module: str, value: int}, ...]
        - fan_out: {module: value} -> [{module: str, value: int}, ...]
        - layer_violations: list of violation records
        - cycles: cycles (preferred) or strongly_connected_components (fallback)
          -> [{cycle_id: int, modules: list}, ...]

        Returns:
            Dict mapping collection names to record lists
        """
        empty: dict[str, list[dict[str, object]]] = {
            "fan_in": [],
            "fan_out": [],
            "layer_violations": [],
            "cycles": [],
        }

        path = self.artifacts_dir / DEPS_SUMMARY_JSON
        if not path.exists():
            logger.debug("%s not found, returning empty collections", DEPS_SUMMARY_JSON)
            return empty

        try:
            with path.open("rb") as f:
                data = orjson.loads(f.read())
        except (OSError, orjson.JSONDecodeError) as e:
            logger.warning(_LOG_READ_FAILED, DEPS_SUMMARY_JSON, e)
            return empty

        if not isinstance(data, dict):
            logger.warning(
                "%s is not a JSON object, returning empty collections",
                DEPS_SUMMARY_JSON,
            )
            return empty

        # Build fan_in with integer validation
        fan_in_records: list[dict[str, object]] = []
        for k, v in data.get("fan_in", {}).items():
            try:
                int_value = int(v)
            except (TypeError, ValueError):
                logger.warning(
                    "Non-integer fan_in value for module %s in %s: %r",
                    k,
                    path,
                    v,
                )
                continue
            fan_in_records.append({"module": k, "value": int_value})

        # Build fan_out with integer validation
        fan_out_records: list[dict[str, object]] = []
        for k, v in data.get("fan_out", {}).items():
            try:
                int_value = int(v)
            except (TypeError, ValueError):
                logger.warning(
                    "Non-integer fan_out value for module %s in %s: %r",
                    k,
                    path,
                    v,
                )
                continue
            fan_out_records.append({"module": k, "value": int_value})

        cycles = data.get("cycles")
        if cycles is None:
            if "strongly_connected_components" not in data:
                logger.warning(
                    "%s missing cycles and strongly_connected_components: %s",
                    DEPS_SUMMARY_JSON,
                    path,
                )
            cycles = data.get("strongly_connected_components", [])

        return {
            "fan_in": fan_in_records,
            "fan_out": fan_out_records,
            "layer_violations": data.get("layer_violations", []),
            "cycles": [
                {"cycle_id": i, "modules": cycle} for i, cycle in enumerate(cycles)
            ],
        }

    # ------------------------------------------------------------------
    # Optional analyzer artifacts (not yet in Tier-1 contract)
    # ------------------------------------------------------------------

    def _load_complexity(self) -> list[dict[str, object]]:
        """Load complexity.jsonl (optional analyzer artifact).

        Returns:
            List of complexity records, or empty list if file doesn't exist
        """
        return self._load_jsonl(_COMPLEXITY_JSONL, "complexity")

    def _load_security(self) -> list[dict[str, object]]:
        """Load security.jsonl (optional analyzer artifact).

        Returns:
            List of security finding records, or empty list if file doesn't exist
        """
        return self._load_jsonl(_SECURITY_JSONL, "security")

    # ------------------------------------------------------------------
    # Hash computation
    # ------------------------------------------------------------------

    def _compute_hash(self) -> str:
        """Compute hash of source artifacts for provenance.

        Uses streaming approach to handle large artifact files without
        loading entire contents into memory. For typical repomap artifacts
        (<2MB), this is not strictly necessary, but provides scalability
        for larger codebases.

        Only hashes files whose suffix matches a recognised Tier-1 format
        (derived from :data:`contract.artifacts.TIER1_ARTIFACT_SPECS`) plus
        the optional ``.jsonl`` suffix for non-contract analyzer artifacts.
        This avoids transient/non-artifact files (e.g., editor backups, temp
        files, logs) from influencing the hash.

        Returns:
            First 16 characters of SHA256 hex digest
        """
        hasher = hashlib.sha256()

        # Derive allowed suffixes from the Tier-1 contract specs
        allowed_suffixes: set[str] = set()
        for spec in TIER1_ARTIFACT_SPECS.values():
            suffix = Path(spec.filename).suffix
            if suffix:
                allowed_suffixes.add(suffix)

        # Hash all artifact file contents using streaming chunks.
        # NOTE: We sort filenames to get a deterministic hash across runs and
        # platforms. This requires materializing all filenames for sorting, but
        # .repomap/ directories are expected to contain only a small number of
        # files, so the memory overhead is acceptable for stable hashes.
        if not self.artifacts_dir.is_dir():
            return hasher.hexdigest()[:16]

        for filename in sorted(self.artifacts_dir.iterdir()):
            if not filename.is_file() or filename.suffix not in allowed_suffixes:
                continue
            try:
                with filename.open("rb") as f:
                    # Read in 8KB chunks to avoid memory issues with large files
                    for chunk in iter(lambda: f.read(8192), b""):
                        hasher.update(chunk)
            except OSError as e:
                logger.warning("Failed to hash file %s: %s", filename, e)
                continue

        return hasher.hexdigest()[:16]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_collection(self, name: str) -> list[dict[str, object]]:
        """Get canonical collection by name.

        Returns a shallow copy of the collection to prevent external mutation
        of the store's internal state.

        Args:
            name: Collection name (e.g., 'symbols', 'deps_edges')

        Returns:
            Shallow copy of the collection (list of dictionaries)

        Raises:
            KeyError: If collection doesn't exist
        """
        if name not in self.collections:
            msg = f"Unknown collection: {name}"
            raise KeyError(msg)
        return list(self.collections[name])

    def get_record_location(self, collection: str, record: dict[str, object]) -> str:
        """Get stable reference for a record.

        Location mapping strategies by collection:
        - deps_edges: Use embedded _location field
        - symbols, integrations, complexity: Use path:start_line-end_line or path:line
        - fan_in, fan_out: Use deps_summary.json:collection[module]
        - layer_violations, cycles: Use structural location

        Args:
            collection: Collection name
            record: The record to locate

        Returns:
            Stable location string

        Raises:
            ValueError: If record cannot be located
        """
        # Embedded location (deps_edges)
        if "_location" in record:
            return str(record["_location"])

        # File-based location (symbols, integrations, complexity, security)
        if "path" in record:
            path = record["path"]
            if "start_line" in record and "end_line" in record:
                return f"{path}:{record['start_line']}-{record['end_line']}"
            if "line" in record:
                return f"{path}:{record['line']}"
            if "line_number" in record:  # security findings use line_number
                return f"{path}:{record['line_number']}"
            return str(path)

        # Module-based location (fan_in, fan_out)
        if "module" in record:
            return f"{DEPS_SUMMARY_JSON}:{collection}[{record['module']}]"

        # Cycle location
        if collection == "cycles" and "cycle_id" in record:
            return f"{DEPS_SUMMARY_JSON}:cycles[{record['cycle_id']}]"

        # Layer violation location
        if collection == "layer_violations" and "from_file" in record:
            return f"{DEPS_SUMMARY_JSON}:layer_violations[{record['from_file']}]"

        # Unlocatable record indicates an ArtifactStore bug
        msg = f"Cannot locate record in collection '{collection}'"
        raise ValueError(msg)

    def list_collections(self) -> list[str]:
        """List available collections.

        Returns:
            List of collection names
        """
        return list(self.collections.keys())

    @property
    def artifacts_hash(self) -> str:
        """Get hash of source artifacts.

        Returns:
            16-character hex string (first 16 chars of SHA256)
        """
        return self._artifacts_hash
