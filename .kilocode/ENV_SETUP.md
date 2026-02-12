# Environment Variables Setup

This document describes environment variables used by **Kilo Code MCP servers** and optional repomap-core development workflows.
Default offline quality gates require **no** environment variables; these are only for optional tooling.

## Required Environment Variables (default local quality gates)

**None.** The default local quality gates for this repo are designed to run **offline** and without secrets.

## Optional Environment Variables (MCP servers / workflows)

### SONARQUBE_TOKEN
**Purpose:** Authentication for SonarQube MCP server  
**Used by:** `.kilocode/mcp.json` → `sonarqube` server  
**How to set:**
```bash
export SONARQUBE_TOKEN="your-token-here"
```

**Previous Issue:** Token was hardcoded in `mcp.json` (security risk)  
**Fixed:** Now uses `${SONARQUBE_TOKEN}` environment variable reference

### CONTEXT7_API_KEY

**Purpose:** Authentication for Context7 MCP docs lookup  
**Used by:** `.kilocode/mcp.json` → `context7` server  
**How to set:**
```bash
export CONTEXT7_API_KEY="your-api-key-here"
```

## Experimental / Out-of-scope for repomap-core

The following variables are **not required** for repomap-core quality gates, and should be treated as **experimental** (used only when working on extension packages or networked workflows).

### OPENROUTER_API_KEY (experimental)

**Purpose:** OpenRouter API access for claims generation/advancement (extension behavior)  
**Used by:** `repomap claims ...` commands (not part of repomap-core)  

Packaging note: the `repomap claims ...` command group is provided by an optional extension package (not guaranteed available in this repo).

**How to set (only if you explicitly need it):**
```bash
export OPENROUTER_API_KEY="your-api-key-here"
```

## Setting Up Environment Variables

### Option 1: Shell Profile (Persistent)
Add to `~/.bashrc` or `~/.zshrc`:
```bash
export SONARQUBE_TOKEN="your-token-here"
# export CONTEXT7_API_KEY="your-api-key-here"  # optional (Context7 MCP docs)
# export OPENROUTER_API_KEY="your-api-key-here"  # experimental (claims extension)
```

Then reload:
```bash
source ~/.bashrc  # or ~/.zshrc
```

### Option 2: Project .env File (Local Development)
Create `.env` in project root (already gitignored):
```bash
SONARQUBE_TOKEN=your-token-here
# CONTEXT7_API_KEY=your-api-key-here  # optional (Context7 MCP docs)
# OPENROUTER_API_KEY=your-api-key-here  # experimental (claims extension)
```

Load before running commands:
```bash
source .env
# or
export $(cat .env | xargs)
```

### Option 3: VSCode Settings (Per-Workspace)
Add to `.vscode/settings.json` (not committed):
```json
{
  "terminal.integrated.env.linux": {
    "SONARQUBE_TOKEN": "your-token-here",
    "CONTEXT7_API_KEY": "your-api-key-here",
    "OPENROUTER_API_KEY": "your-api-key-here" 
  }
}
```

## Verification

Check if environment variables are set:
```bash
echo $SONARQUBE_TOKEN
# echo $CONTEXT7_API_KEY  # optional (Context7 MCP docs)
# echo $OPENROUTER_API_KEY  # experimental (claims extension)
```

`SONARQUBE_TOKEN` should output a non-empty value if you are using SonarQube MCP tooling.
`CONTEXT7_API_KEY` should output a non-empty value if you are using Context7 MCP tooling.

## Security Best Practices

1. ✅ **Never commit tokens/keys to git**
   - `.env` is in `.gitignore`
   - `mcp.json` uses `${VAR}` references, not literals

2. ✅ **Use environment variables, not hardcoded values**
   - Allows different tokens per machine/clone
   - Supports two-clone "employees" model

3. ✅ **Rotate tokens periodically**
   - SonarQube tokens can be regenerated in SonarCloud UI
   - OpenRouter API keys can be rotated in OpenRouter dashboard

4. ✅ **Restrict token permissions**
- SonarQube: Use project-scoped tokens when possible
- OpenRouter: Monitor usage and set spending limits

## Two-Clone "Employees" Model

Each clone (Windsurf employee, Kilo employee) can have:
- Same tokens (shared account)
- Different tokens (separate accounts for tracking)

Environment variables make this flexible without modifying `mcp.json`.
