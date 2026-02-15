"""Model namespace for repomap_core artifact schemas."""

from artifacts.models.artifacts.calls import CallRecord
from artifacts.models.artifacts.calls_raw import CallRawRecord
from artifacts.models.artifacts.dependencies import DepsSummary
from artifacts.models.artifacts.integrations import IntegrationRecord
from artifacts.models.artifacts.modules import ModuleRecord
from artifacts.models.artifacts.refs import (
    RefEvidence,
    RefRecord,
    ResolvedTo,
    SourceSpan,
)
from artifacts.models.artifacts.symbols import SymbolRecord

__all__ = [
    "CallRecord",
    "CallRawRecord",
    "DepsSummary",
    "IntegrationRecord",
    "ModuleRecord",
    "RefEvidence",
    "RefRecord",
    "ResolvedTo",
    "SourceSpan",
    "SymbolRecord",
]
