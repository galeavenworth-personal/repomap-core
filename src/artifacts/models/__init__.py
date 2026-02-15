"""Model namespace for repomap_core artifact schemas."""

from artifacts.models.artifacts.calls_raw import CallRawRecord
from artifacts.models.artifacts.dependencies import DepsSummary
from artifacts.models.artifacts.integrations import IntegrationRecord
from artifacts.models.artifacts.modules import ModuleRecord
from artifacts.models.artifacts.symbols import SymbolRecord

__all__ = [
    "CallRawRecord",
    "DepsSummary",
    "IntegrationRecord",
    "ModuleRecord",
    "SymbolRecord",
]
