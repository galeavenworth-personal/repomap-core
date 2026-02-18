# Project Brief: repomap-core

## Mission

Build a deterministic repository analysis tool for Python codebases.

## Core Philosophy: Software Fabrication

1. **Determinism** - Same input → same output, always
2. **Evidence-backed outputs** - Artifacts and summaries must be reproducible and inspectable
3. **Bounded execution** - Quality gates and workflows must complete within explicit budgets
4. **Layered architecture** - Strict dependency rules enforced by tooling
5. **No backwards compatibility** - Greenfield/pre-release; pull code forward, delete obsolete patterns

## Epistemic Humility

- **Truth on a spectrum** - Repository analysis often has ambiguity; prefer evidence and explicit uncertainty
- **Hallucination as constraint** - Treat model output as a hypothesis until grounded in code/artifacts
- **Verification over vibes** - Prefer checks, tests, and reproducible artifacts
- **Durability over disposability** - Improve workflows and guardrails rather than relying on hero debugging
- **Uncertainty as information** - Embrace uncertainty as signal, not noise

This paradigm conscripts uncertainty into the system, accepting that perfect knowledge is unattainable while building toward better knowledge quality.

## Hard Rules (Immutable)

### 0. Cost-Aware Memory Bank
- Monitor "Current Cost" in environment_details each turn
- Token budget: 1M tokens

### 1. Virtual Environment Only
- ALWAYS use `.venv/bin/python -m ...`
- NEVER install packages globally

### 2. Beads Sync-Branch Model
- Local `.beads/beads.db` is cache
- Remote `beads-sync` branch is shared truth
- `bd sync --no-push` at session start
- `bd sync` at session end

### 3. Authoritative Sources
- `gh` for PR review threads
- `bd` for issue tracking
- `.repomap/` artifacts for codebase analysis

### 4. Two-Clone "Employees" Model
- Windsurf: `~/Projects/repomap-windsurf/`
- Kilo: `~/Projects-Employee-1/repomap-core/`
- Remote repo is rendezvous point

### 5. Quality Gates (Non-Negotiable)
- `ruff format --check .`
- `ruff check .`
- `mypy src`
- `pytest -q`

All must pass before committing.

## Project Goals

1. Deterministic artifact generation
2. Deterministic summaries and validations
3. A small, offline-by-default toolchain (no required network/secrets)

## Non-Goals

- Backwards compatibility
- Non-Python languages
- Real-time analysis
- GUI interface

## Success Criteria

- **Deterministic:** Same repo → same artifacts/summaries
- **Verifiable:** Outputs are inspectable and backed by evidence in `.repomap/` and/or tests
- **Maintainable:** Layered architecture, strict dependency rules
- **Dogfoodable:** Use repomap to analyze repomap itself

## References

- Architecture: `repomap.toml`
- Agent instructions: `AGENTS.md`
