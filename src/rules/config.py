from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING, Any, Literal, get_args

import tomllib
from pydantic import BaseModel, Field, field_validator

from artifacts.models.artifacts.integrations import IntegrationTag

from pathlib import Path

if TYPE_CHECKING:
    pass

CONFIG_FILENAME = "repomap.toml"

VALID_INTEGRATION_TAGS = frozenset(get_args(IntegrationTag))

UnclassifiedBehavior = Literal["allow", "deny", "ignore"]


class EmbeddingProvider(str, Enum):
    """Embedding model providers for semantic search."""

    OPENAI = "openai"
    COHERE = "cohere"
    LOCAL_OLLAMA = "local_ollama"


class LayerDef(BaseModel):
    """Definition of a single architectural layer."""

    name: str = Field(description="Layer name (e.g., 'presentation', 'business')")
    globs: list[str] = Field(
        description="Glob patterns for files belonging to this layer"
    )


class LayerRule(BaseModel):
    """Allowed dependencies from one layer to others."""

    from_layer: str = Field(alias="from", description="Source layer name")
    to: list[str] = Field(
        default_factory=list,
        description="List of layer names this layer may depend on",
    )


class LayersConfig(BaseModel):
    """Configuration for architectural layer classification and rules."""

    layer: list[LayerDef] = Field(
        default_factory=list,
        description="Layer definitions (first match wins)",
    )
    rules: list[LayerRule] = Field(
        default_factory=list,
        description="Allowed dependency rules between layers",
    )
    unclassified: UnclassifiedBehavior = Field(
        default="allow",
        description="Behavior for files not matching any layer glob",
    )


class SemanticConfig(BaseModel):
    """Configuration for semantic search layer."""

    enabled: bool = Field(default=False, description="Enable semantic search")
    weaviate_url: str = Field(
        default="http://localhost:8080",
        description="Weaviate instance URL",
    )
    weaviate_api_key: str | None = Field(
        default=None,
        description="Weaviate Cloud API key (optional for local)",
    )
    embedding_provider: EmbeddingProvider = Field(
        default=EmbeddingProvider.OPENAI,
        description="Embedding model provider",
    )
    embedding_model: str = Field(
        default="text-embedding-3-small",
        description="Embedding model name",
    )
    generative_model: str = Field(
        default="gpt-4o-mini",
        description="Model for RAG generation",
    )
    generative_base_url: str | None = Field(
        default=None,
        description="Custom base URL for OpenAI-compatible APIs",
    )
    default_alpha: float = Field(
        default=0.5,
        description="Default hybrid search alpha (0=pure BM25, 1=pure vector)",
    )
    default_limit: int = Field(
        default=10,
        description="Default search result limit",
    )


class AnalyzersConfig(BaseModel):
    """Configuration for optional analyzers."""

    complexity: bool = Field(
        default=False,
        description="Enable radon complexity analysis",
    )
    docstrings: bool = Field(
        default=False,
        description="Enable interrogate docstring coverage",
    )
    security: bool = Field(
        default=False,
        description="Enable bandit security scanning",
    )


class RepoMapConfig(BaseModel):
    """Configuration for repomap_core artifact generation."""

    output_dir: str = Field(
        default=".repomap",
        description="Output directory for generated artifacts",
    )
    include: list[str] = Field(
        default_factory=list,
        description="Glob patterns for files to include (empty = all Python files)",
    )
    exclude: list[str] = Field(
        default_factory=list,
        description="Glob patterns for files to exclude",
    )
    integration_tags: dict[str, IntegrationTag] = Field(
        default_factory=dict,
        description="Additional integration tag rules: module_prefix -> tag",
    )
    layers: LayersConfig = Field(
        default_factory=LayersConfig,
        description="Architectural layer classification and rules",
    )
    analyzers: AnalyzersConfig = Field(
        default_factory=AnalyzersConfig,
        description="Optional analyzer toggles",
    )
    nested_gitignore: bool = Field(
        default=False,
        description=(
            "Enable nested .gitignore composition (default: false for root-only)"
        ),
    )

    @field_validator("integration_tags", mode="before")
    @classmethod
    def validate_integration_tags(cls, v: Any) -> Any:
        """Validate that integration tag values are valid IntegrationTag literals.

        Note: this runs in `mode="before"` so we can report a clear error
        message using the raw TOML values.
        """

        if v is None:
            return {}

        if not isinstance(v, dict):
            msg = "integration_tags must be a mapping of module_prefix -> tag"
            raise TypeError(msg)

        for module, tag in v.items():
            if not isinstance(module, str) or not isinstance(tag, str):
                msg = "integration_tags must be a mapping of str -> str"
                raise TypeError(msg)
            if tag not in VALID_INTEGRATION_TAGS:
                msg = (
                    f"Invalid integration tag '{tag}' for module '{module}'. "
                    f"Valid tags: {', '.join(sorted(VALID_INTEGRATION_TAGS))}"
                )
                raise ValueError(msg)

        return v


class ConfigError(Exception):
    """Raised when config file exists but cannot be parsed."""


def resolve_output_dir(root: Path, output_dir: str) -> Path:
    """Resolve a config-provided output_dir safely within the repo root.

    The config output_dir must be a non-empty relative path that remains
    within the repository root after resolution. Absolute paths and paths
    that escape the root are rejected.
    """
    if not output_dir:
        msg = "output_dir must be a non-empty relative path"
        raise ConfigError(msg)

    if output_dir.startswith("~"):
        msg = "output_dir must be a relative path within the repo root"
        raise ConfigError(msg)

    output_path = Path(output_dir)
    if output_path.is_absolute():
        msg = "output_dir must be a relative path within the repo root"
        raise ConfigError(msg)

    try:
        resolved_root = root.resolve()
        resolved_output = (resolved_root / output_path).resolve()
    except OSError as exc:
        msg = f"Failed to resolve output_dir '{output_dir}': {exc}"
        raise ConfigError(msg) from exc

    try:
        resolved_output.relative_to(resolved_root)
    except ValueError as exc:
        msg = f"output_dir '{output_dir}' escapes the repository root"
        raise ConfigError(msg) from exc

    return resolved_output


def _strip_claims_sections(data: dict) -> dict:
    """Return config data without any [claims.*] sections."""
    if "claims" in data:
        data = {key: value for key, value in data.items() if key != "claims"}
    return data


def load_config(root: Path) -> RepoMapConfig:
    """Load configuration from repomap.toml if it exists."""
    from pathlib import Path as PathCls

    config_path = PathCls(root) / CONFIG_FILENAME

    if not config_path.is_file():
        return RepoMapConfig()

    try:
        with config_path.open("rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        msg = f"Invalid TOML in {config_path}: {e}"
        raise ConfigError(msg) from e

    data = _strip_claims_sections(data)

    try:
        return RepoMapConfig.model_validate(data)
    except Exception as e:
        msg = f"Invalid config in {config_path}: {e}"
        raise ConfigError(msg) from e
