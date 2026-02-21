# Environment Variables Setup

This document describes environment variables used by repomap-core development workflows,
MCP servers, and OpenCode plugins.

Default offline quality gates require **no** environment variables.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your values
```

The `.env` file is gitignored. The committed `.env.example` shows all available variables
with safe defaults.

## How .env is Loaded

| Runtime | Mechanism | Notes |
|---------|-----------|-------|
| **Python** | `python-dotenv` (dev dependency) | Call `dotenv.load_dotenv()` at entry points |
| **Bun / OpenCode plugins** | Built-in `.env` support | Bun reads `.env` automatically |
| **Shell scripts** | `source .env` or `export $(cat .env \| xargs)` | Manual load before running |

## Variable Reference

### Dolt Database Connection

Used by the OpenCode cross-DB sync plugin and Dolt CLI tooling.
These should match `.beads/config.yaml` if you customize them.

| Variable | Default | Description |
|----------|---------|-------------|
| `DOLT_HOST` | `127.0.0.1` | Dolt SQL server host |
| `DOLT_PORT` | `3307` | Dolt SQL server port |
| `DOLT_USER` | `root` | Dolt SQL server user |
| `DOLT_PASSWORD` | *(empty)* | Dolt SQL server password |

### MCP Server Authentication (Optional)

| Variable | Description |
|----------|-------------|
| `SONARQUBE_TOKEN` | SonarQube MCP server authentication |
| `CONTEXT7_API_KEY` | Context7 MCP server (library docs lookup) |

### Experimental (Not Required for repomap-core)

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API for claims extension (not part of core) |

## Required Environment Variables (Default Local Quality Gates)

**None.** The default local quality gates (`ruff`, `mypy`, `pytest`) run offline without secrets.

## Security Best Practices

1. ✅ **Never commit `.env` to git** — it's in `.gitignore`
2. ✅ **Use `.env.example` as the template** — committed, shows structure without secrets
3. ✅ **`mcp.json` uses `${VAR}` references** — not hardcoded literals
4. ✅ **Plugins read `process.env` with safe defaults** — graceful degradation

## Verification

```bash
# Check if .env exists
test -f .env && echo ".env present" || echo "Run: cp .env.example .env"

# Check specific variables
echo "DOLT_HOST=${DOLT_HOST:-not set}"
echo "SONARQUBE_TOKEN=${SONARQUBE_TOKEN:+set (hidden)}"
```
