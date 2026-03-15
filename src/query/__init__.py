"""Artifact query API for repomap-core.

This package provides a deterministic, typed query interface over repomap
artifacts. It normalizes heterogeneous artifact formats into uniform
in-memory collections and supports location mapping for falsifiability.

Primary entry point: :class:`query.artifact_store.ArtifactStore`.
"""

from query.artifact_store import ArtifactStore, ArtifactStoreProtocol

__all__ = [
    "ArtifactStore",
    "ArtifactStoreProtocol",
]
