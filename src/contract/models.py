"""Tier-1 artifact models exposed at the core↔claims boundary."""

from artifacts.models.artifacts.dependencies import DepsSummary
from artifacts.models.artifacts.integrations import IntegrationRecord
from artifacts.models.artifacts.modules import ModuleRecord
from artifacts.models.artifacts.symbols import SymbolRecord

__all__ = ["DepsSummary", "IntegrationRecord", "ModuleRecord", "SymbolRecord"]
