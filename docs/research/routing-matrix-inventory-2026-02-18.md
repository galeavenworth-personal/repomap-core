# Routing Matrix Inventory — Grounded in Actual Infrastructure

**Date:** 2026-02-18
**Bead:** `repomap-core-4f0.6`
**Status:** Complete
**Next:** `repomap-core-4f0.7` consumes this inventory to build `.kilocode/commands.toml` (internal; does not exist yet — created in 4f0.7)

---

## Purpose

This document inventories every actual skill, tool, MCP tool, contract, and mode in the repomap-core plant, then produces a grounded routing matrix TOML draft. The original routing matrix in [`command-dialect-exploration.md`](command-dialect-exploration.md) contained phantom references (nonexistent skills, wrong tool paths, incorrect MCP names). This document corrects those.

---

## 1. Skills Inventory

All directories under [`.kilocode/skills/`](../../.kilocode/skills/).

| Skill ID | SKILL.md | Description |
|----------|----------|-------------|
| `beads-local-db-ops` | [SKILL.md](../../.kilocode/skills/beads-local-db-ops/SKILL.md) | Beads task tracking — sync, claim, close, show |
| `context7-docs-ops` | [SKILL.md](../../.kilocode/skills/context7-docs-ops/SKILL.md) | Third-party library docs via Context7 MCP |
| `github-cli-code-review` | [SKILL.md](../../.kilocode/skills/github-cli-code-review/SKILL.md) | PR review via `gh` CLI |
| `repomap-claims-ops` | [SKILL.md](../../.kilocode/skills/repomap-claims-ops/SKILL.md) | **EXPERIMENTAL / out-of-scope for core** |
| `repomap-codebase-retrieval` | [SKILL.md](../../.kilocode/skills/repomap-codebase-retrieval/SKILL.md) | Semantic code search via Augment context engine |
| `sequential-thinking-default` | [SKILL.md](../../.kilocode/skills/sequential-thinking-default/SKILL.md) | Structured reasoning via sequential thinking MCP |
| `sonarqube-ops` | [SKILL.md](../../.kilocode/skills/sonarqube-ops/SKILL.md) | SonarQube quality inspection |

**Phantom skills from original exploration (DO NOT reference):**
- ~~`quality-gates`~~ — Not a skill. Quality gates are CLI commands run via [`bounded_gate.py`](../../.kilocode/tools/bounded_gate.py) or [`beads_land_plane.sh`](../../.kilocode/tools/beads_land_plane.sh).
- ~~`orchestration`~~ — Not a skill. Orchestration is a mode capability (process-orchestrator, plant-manager).
- ~~`agent-receipts`~~ — Not a skill. Proposed future system; does not exist yet.

---

## 2. Tools Inventory

All files under [`.kilocode/tools/`](../../.kilocode/tools/) (excluding `__pycache__`).

### Beads Tools
| Tool | Path | Description |
|------|------|-------------|
| `bd` | [`.kilocode/tools/bd`](../../.kilocode/tools/bd) | Beads CLI wrapper (shell script, repo-local) |
| `beads_preflight.sh` | [`.kilocode/tools/beads_preflight.sh`](../../.kilocode/tools/beads_preflight.sh) | Pre-flight checks before landing |
| `beads_land_plane.sh` | [`.kilocode/tools/beads_land_plane.sh`](../../.kilocode/tools/beads_land_plane.sh) | Quality gate orchestration + bead closure (composite) |
| `beads_git_setup.sh` | [`.kilocode/tools/beads_git_setup.sh`](../../.kilocode/tools/beads_git_setup.sh) | One-time git merge driver setup |
| `beads_install.sh` | [`.kilocode/tools/beads_install.sh`](../../.kilocode/tools/beads_install.sh) | One-time beads install |
| `beads_version` | [`.kilocode/tools/beads_version`](../../.kilocode/tools/beads_version) | Pinned version file |
| `bd_doctor_safe.sh` | [`.kilocode/tools/bd_doctor_safe.sh`](../../.kilocode/tools/bd_doctor_safe.sh) | Detect orphaned issues / process failures |
| `bd_reconcile_merged_prs.sh` | [`.kilocode/tools/bd_reconcile_merged_prs.sh`](../../.kilocode/tools/bd_reconcile_merged_prs.sh) | Reconcile merged PRs with bead state |

### Gate & Validation Tools
| Tool | Path | Description |
|------|------|-------------|
| `bounded_gate.py` | [`.kilocode/tools/bounded_gate.py`](../../.kilocode/tools/bounded_gate.py) | Command wrapping with timeout/stall detection; appends to `gate_runs.jsonl` |
| `workflow_gate.py` | [`.kilocode/tools/workflow_gate.py`](../../.kilocode/tools/workflow_gate.py) | Plant config validation (modes, skills, contracts, workflows) |

### Monitoring Tools
| Tool | Path | Description |
|------|------|-------------|
| `kilo_session_monitor.py` | [`.kilocode/tools/kilo_session_monitor.py`](../../.kilocode/tools/kilo_session_monitor.py) | Live self-monitoring: `whoami`, `timeline`, `cost`, `tools`, `tail`, `receipts` |

### Quality Gate Commands (via .venv)
| Command | Purpose |
|---------|---------|
| `.venv/bin/python -m ruff format --check .` | Format check |
| `.venv/bin/python -m ruff check .` | Lint check |
| `.venv/bin/python -m mypy src` | Type check |
| `.venv/bin/python -m pytest -q` | Test suite |

---

## 3. MCP Tools Inventory

Actual MCP tool names as registered by connected servers. Uses the naming convention `mcp--{server}--{tool}`.

### Context7
| MCP Tool Name | Description |
|---------------|-------------|
| `mcp--context7--resolve___library___id` | Resolve library name → Context7 library ID |
| `mcp--context7--query___docs` | Query library documentation |

### Augment Context Engine
| MCP Tool Name | Description |
|---------------|-------------|
| `mcp--augment___context___engine--codebase___retrieval` | Semantic codebase search |

### Sequential Thinking
| MCP Tool Name | Description |
|---------------|-------------|
| `mcp--sequentialthinking--process_thought` | Add sequential thought with metadata |
| `mcp--sequentialthinking--generate_summary` | Summarize thinking process |
| `mcp--sequentialthinking--export_session` | Export thinking session to file |
| `mcp--sequentialthinking--import_session` | Import thinking session from file |
| `mcp--sequentialthinking--clear_history` | Clear thought history |

### SonarQube
| MCP Tool Name | Description |
|---------------|-------------|
| `mcp--sonarqube--search_my_sonarqube_projects` | Find SonarQube projects |
| `mcp--sonarqube--search_sonar_issues_in_projects` | Search issues in projects |
| `mcp--sonarqube--get_project_quality_gate_status` | Quality gate status |
| `mcp--sonarqube--show_rule` | Rule details |
| `mcp--sonarqube--get_component_measures` | Project metrics |
| `mcp--sonarqube--change_sonar_issue_status` | Change issue status |
| `mcp--sonarqube--list_rule_repositories` | List rule repos |
| `mcp--sonarqube--list_quality_gates` | List quality gates |
| `mcp--sonarqube--list_languages` | List supported languages |
| `mcp--sonarqube--search_metrics` | Search available metrics |
| `mcp--sonarqube--get_scm_info` | SCM info for source files |
| `mcp--sonarqube--get_raw_source` | Raw source code from SonarQube |
| `mcp--sonarqube--create_webhook` | Create webhook |
| `mcp--sonarqube--list_webhooks` | List webhooks |
| `mcp--sonarqube--list_enterprises` | List enterprises |
| `mcp--sonarqube--list_portfolios` | List portfolios |

**Phantom MCP references from original exploration (DO NOT reference):**
- ~~`mcp:augment-context-engine:codebase-retrieval`~~ — Wrong naming format
- ~~`mcp:sequentialthinking:process-thought`~~ — Wrong naming format
- ~~`mcp:sequentialthinking:export-session`~~ — Wrong naming format
- ~~`mcp:sonarqube:search-sonar-issues-in-projects`~~ — Wrong naming format

---

## 4. Contracts Inventory

All files under [`.kilocode/contracts/`](../../.kilocode/contracts/).

### Line Health Contracts
| Contract | Path | Purpose |
|----------|------|---------|
| Line Fault | [`line_fault_contract.md`](../../.kilocode/contracts/line_health/line_fault_contract.md) | Structured fault payloads (gate_id, invocation, stop_reason, repro_hints) |
| Restoration | [`restoration_contract.md`](../../.kilocode/contracts/line_health/restoration_contract.md) | Fitter → Orchestrator mitigation reports |

### Composability Contracts
| Contract | Path | Purpose |
|----------|------|---------|
| Handoff Packet | [`handoff_packet.md`](../../.kilocode/contracts/composability/handoff_packet.md) | Parent → Child structured handoffs |
| Return Format | [`return_format.md`](../../.kilocode/contracts/composability/return_format.md) | Child → Parent return conventions |
| Error Propagation | [`error_propagation.md`](../../.kilocode/contracts/composability/error_propagation.md) | Failure propagation across nesting levels |
| Mode Interaction | [`mode_interaction_heuristic.md`](../../.kilocode/contracts/composability/mode_interaction_heuristic.md) | Heuristic for mode selection |
| Nesting Depth | [`nesting_depth_policy.md`](../../.kilocode/contracts/composability/nesting_depth_policy.md) | Max nesting depth constraints |

---

## 5. Modes Inventory

All modes defined in [`.kilocodemodes`](../../.kilocodemodes).

### Tier 1 (Strategic)
| Mode | Slug | Purpose |
|------|------|---------|
| Plant Manager | `plant-manager` | Strategic workflow orchestrator; owns `.kilocode/` |

### Tier 2 (Tactical Orchestrators)
| Mode | Slug | Purpose |
|------|------|---------|
| Process Orchestrator | `process-orchestrator` | Lifecycle orchestration (discover→execute→gate→land) |
| Audit Orchestrator | `audit-orchestrator` | Adversarial pressure testing |

### Tier 3 (Specialists)
| Mode | Slug | Purpose |
|------|------|---------|
| Software Architect | `architect` | Architecture design, specifications |
| Code Fabricator | `code` | Implementation, bug fixes, refactoring |
| Code Simplifier | `code-simplifier` | Refactoring specialist |
| PR Reviewer | `pr-review` | Pull request review |
| Claims Pipeline Operator | `claims-ops` | **Experimental / out-of-scope for core** |
| Product Skeptic | `product-skeptic` | Adversarial review, friction audits |
| Fitter | `fitter` | Line health restoration |
| Documentation Specialist | `docs-specialist` | Technical writing |
| Spike Orchestrator | `spike-orchestrator` | Custom orchestrator spike test |

---

## 6. Grounded Routing Matrix — Draft TOML

This is the corrected routing matrix for `repomap-core-4f0.7` to formalize as `.kilocode/commands.toml` (internal; created in 4f0.7).

Every entry references only verified infrastructure from sections 1–5 above.

```toml
# =============================================================================
# Routing Matrix — Grounded in Actual Infrastructure
# =============================================================================
# Structure: verb + noun → skill binding + tool invocation
# All paths verified against .kilocode/ contents on 2026-02-18
# =============================================================================

# --- Quality Gates (receipt_required = true via bounded_gate.py) ---

[commands.format_ruff]
verb = "format"
noun = "ruff"
skill = "cli"  # No skill dir; raw CLI command
tool = ".venv/bin/python -m ruff format --check ."
gate_wrapper = ".kilocode/tools/bounded_gate.py"
receipt_required = true

[commands.check_ruff]
verb = "check"
noun = "ruff"
skill = "cli"
tool = ".venv/bin/python -m ruff check ."
gate_wrapper = ".kilocode/tools/bounded_gate.py"
receipt_required = true

[commands.check_mypy]
verb = "check"
noun = "mypy"
skill = "cli"
tool = ".venv/bin/python -m mypy src"
gate_wrapper = ".kilocode/tools/bounded_gate.py"
receipt_required = true

[commands.test_pytest]
verb = "test"
noun = "pytest"
skill = "cli"
tool = ".venv/bin/python -m pytest -q"
gate_wrapper = ".kilocode/tools/bounded_gate.py"
receipt_required = true

# --- Composite: Quality Gate (expands to sub-commands) ---

[commands.gate_quality]
verb = "gate"
noun = "quality"
skill = "cli"
composite = ["format_ruff", "check_ruff", "check_mypy", "test_pytest"]
tool = ".kilocode/tools/bounded_gate.py"  # orchestrates sub-commands; NOT beads_land_plane.sh
receipt_required = true
notes = "Expands composite into sequential bounded_gate.py invocations"

# --- Beads Task Tracking ---

[commands.sync_remote]
verb = "sync"
noun = "remote"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd sync --no-push"
receipt_required = false

[commands.sync_push]
verb = "sync"
noun = "push"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd sync"
receipt_required = false

[commands.claim_issue]
verb = "claim"
noun = "issue"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd update {id} --status in_progress"
receipt_required = false

[commands.close_issue]
verb = "close"
noun = "issue"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd close {id}"
receipt_required = false

[commands.show_issue]
verb = "show"
noun = "issue"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd show {id}"
receipt_required = false

[commands.list_ready]
verb = "list"
noun = "ready"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd ready"
receipt_required = false

[commands.diagnose_issues]
verb = "diagnose"
noun = "issues"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd_doctor_safe.sh"
receipt_required = false

# --- Code Search & Retrieval ---

[commands.retrieve_codebase]
verb = "retrieve"
noun = "codebase"
skill = "repomap-codebase-retrieval"
tool = "mcp--augment___context___engine--codebase___retrieval"
receipt_required = false

[commands.query_docs]
verb = "query"
noun = "docs"
skill = "context7-docs-ops"
tool = "mcp--context7--query___docs"
receipt_required = false
notes = "Requires resolve_library (commands.resolve_library) first"

[commands.resolve_library]
verb = "resolve"
noun = "library"
skill = "context7-docs-ops"
tool = "mcp--context7--resolve___library___id"
receipt_required = false

# --- SonarQube Inspection ---

[commands.search_issues]
verb = "search"
noun = "issues"
skill = "sonarqube-ops"
tool = "mcp--sonarqube--search_sonar_issues_in_projects"
receipt_required = false

[commands.inspect_quality_gate]
verb = "inspect"
noun = "quality-gate"
skill = "sonarqube-ops"
tool = "mcp--sonarqube--get_project_quality_gate_status"
receipt_required = false

[commands.inspect_measures]
verb = "inspect"
noun = "measures"
skill = "sonarqube-ops"
tool = "mcp--sonarqube--get_component_measures"
receipt_required = false

# --- Structured Reasoning ---

[commands.decompose_task]
verb = "decompose"
noun = "task"
skill = "sequential-thinking-default"
tool = "mcp--sequentialthinking--process_thought"
receipt_required = false

[commands.summarize_thinking]
verb = "summarize"
noun = "thinking"
skill = "sequential-thinking-default"
tool = "mcp--sequentialthinking--generate_summary"
receipt_required = false

[commands.export_session]
verb = "export"
noun = "session"
skill = "sequential-thinking-default"
tool = "mcp--sequentialthinking--export_session"
receipt_required = false

[commands.import_session]
verb = "import"
noun = "session"
skill = "sequential-thinking-default"
tool = "mcp--sequentialthinking--import_session"
receipt_required = false

# --- Orchestration (mode-routed) ---

[commands.spawn_subtask]
verb = "spawn"
noun = "subtask"
skill = "native"  # Kilo built-in tool
tool = "new_task"
receipt_required = false
notes = "Requires mode slug and handoff packet"

[commands.dispatch_fitter]
verb = "dispatch"
noun = "fitter"
skill = "native"
tool = "new_task"
target_mode = "fitter"
contract = ".kilocode/contracts/line_health/line_fault_contract.md"
receipt_required = false

[commands.dispatch_code]
verb = "dispatch"
noun = "code"
skill = "native"
tool = "new_task"
target_mode = "code"
contract = ".kilocode/contracts/composability/handoff_packet.md"
receipt_required = false

[commands.dispatch_architect]
verb = "dispatch"
noun = "architect"
skill = "native"
tool = "new_task"
target_mode = "architect"
contract = ".kilocode/contracts/composability/handoff_packet.md"
receipt_required = false

# --- Plant Validation ---

[commands.validate_plant]
verb = "validate"
noun = "plant"
skill = "cli"
tool = ".venv/bin/python .kilocode/tools/workflow_gate.py"
receipt_required = true

# --- Session Monitoring ---

[commands.monitor_session]
verb = "monitor"
noun = "session"
skill = "cli"
tool = "python3 .kilocode/tools/kilo_session_monitor.py whoami"
receipt_required = false

[commands.inspect_cost]
verb = "inspect"
noun = "cost"
skill = "cli"
tool = "python3 .kilocode/tools/kilo_session_monitor.py cost"
receipt_required = false

[commands.inspect_timeline]
verb = "inspect"
noun = "timeline"
skill = "cli"
tool = "python3 .kilocode/tools/kilo_session_monitor.py timeline --last 20"
receipt_required = false

# --- PR Review ---

[commands.fetch_pr]
verb = "fetch"
noun = "pr"
skill = "github-cli-code-review"
tool = "gh pr view --json number,title,body,reviewDecision,reviews,comments"
receipt_required = false

[commands.list_pr_comments]
verb = "list"
noun = "pr-comments"
skill = "github-cli-code-review"
tool = "gh pr view --json reviews,comments"
receipt_required = false

# --- Composite: Land Plane (full session landing) ---

[commands.land_plane]
verb = "land"
noun = "plane"
skill = "beads-local-db-ops"
composite = ["gate_quality", "close_issue", "sync_push"]
tool = ".kilocode/tools/beads_land_plane.sh --bead-id {id}"
receipt_required = true
notes = "beads_land_plane.sh requires --bead-id; performs quality gates + bead closure"
```

---

## 7. Corrections to Original Exploration

| Original Entry | Problem | Correction |
|----------------|---------|------------|
| `skill = "quality-gates"` | No such skill directory | Use `skill = "cli"` + `gate_wrapper` reference |
| `skill = "orchestration"` | No such skill directory | Use `skill = "native"` for Kilo built-in tools |
| `skill = "agent-receipts"` | Does not exist (proposed future) | Removed entirely |
| `skill = "sequential-thinking"` | Wrong name | Use `skill = "sequential-thinking-default"` |
| `tool = "bd sync --no-push"` | Missing repo-local path | Use `.kilocode/tools/bd sync --no-push` |
| `tool = "mcp:augment-context-engine:codebase-retrieval"` | Wrong MCP naming | Use `mcp--augment___context___engine--codebase___retrieval` |
| `tool = "mcp:sequentialthinking:process-thought"` | Wrong MCP naming | Use `mcp--sequentialthinking--process_thought` |
| `tool = "mcp:sequentialthinking:export-session"` | Wrong MCP naming | Use `mcp--sequentialthinking--export_session` |
| `tool = "mcp:sonarqube:search-sonar-issues-in-projects"` | Wrong MCP naming | Use `mcp--sonarqube--search_sonar_issues_in_projects` |
| `tool = "ar validate"` | `ar` does not exist | Removed (future system) |

---

## 8. Verb Vocabulary (Verified — 25 verbs)

| Verb | Semantic Weight | Operation Family | Bindings |
|------|----------------|-----------------|----------|
| `format` | High | Style enforcement | 1 |
| `check` | High | Static analysis | 2 |
| `test` | High | Dynamic verification | 1 |
| `gate` | Medium | Checkpoint evaluation | 1 |
| `sync` | High | State reconciliation | 2 |
| `claim` | Medium | Lifecycle acquisition | 1 |
| `close` | Medium | Lifecycle completion | 1 |
| `show` | High | Information display | 1 |
| `list` | High | Enumeration | 2 |
| `retrieve` | High | Information gathering | 1 |
| `query` | High | Structured search | 1 |
| `resolve` | Medium | Name resolution | 1 |
| `search` | High | Discovery | 1 |
| `inspect` | High | Detailed examination | 4 |
| `decompose` | Medium | Task breakdown | 1 |
| `summarize` | Medium | Synthesis | 1 |
| `export` | Medium | State persistence | 1 |
| `import` | Medium | State restoration | 1 |
| `spawn` | Medium | Subtask creation | 1 |
| `dispatch` | Medium | Mode-routed delegation | 3 |
| `validate` | High | Conformance checking | 1 |
| `monitor` | Medium | Observation | 1 |
| `fetch` | High | Remote retrieval | 1 |
| `land` | Low (project-specific) | Session completion | 1 |
| `diagnose` | Medium | Health check | 1 |

**Count:** 25 verbs (exceeds the original 12; reflects actual operations)

## 9. Noun Vocabulary (Verified — 27 nouns)

| Noun | Domain Object | Bindings |
|------|--------------|----------|
| `ruff` | Linter/formatter | 2 |
| `mypy` | Type checker | 1 |
| `pytest` | Test runner | 1 |
| `quality` | Composite gate | 1 |
| `remote` | Beads/git remote state | 1 |
| `push` | Beads sync with push | 1 |
| `issue` | Task tracking item | 3 |
| `ready` | Available work items | 1 |
| `issues` | SonarQube/beads search | 2 |
| `codebase` | Semantic search target | 1 |
| `docs` | Library documentation | 1 |
| `library` | Third-party library ID | 1 |
| `quality-gate` | SonarQube gate status | 1 |
| `measures` | SonarQube metrics | 1 |
| `task` | Work unit / thinking step | 1 |
| `thinking` | Reasoning session summary | 1 |
| `session` | Thinking/work session | 3 |
| `subtask` | Orchestration work unit | 1 |
| `fitter` | Line health mode target | 1 |
| `code` | Code fabricator mode target | 1 |
| `architect` | Architecture mode target | 1 |
| `plant` | Plant configuration | 1 |
| `cost` | Token spend monitoring | 1 |
| `timeline` | Session timeline events | 1 |
| `pr` | Pull request | 1 |
| `pr-comments` | PR review comments | 1 |
| `plane` | Landing workflow composite | 1 |

**Count:** 27 nouns (exceeds the original 12; reflects actual operations)

---

## 10. Binding Count

**Total command entries:** 33 (within the ~50 active bindings target from original exploration)

| Category | Count |
|----------|-------|
| Quality Gates | 4 atomic + 1 composite |
| Beads/Task Tracking | 7 |
| Code Search & Retrieval | 3 |
| SonarQube Inspection | 3 |
| Structured Reasoning | 4 |
| Orchestration (mode-routed) | 4 |
| Plant Validation | 1 |
| Session Monitoring | 3 |
| PR Review | 2 |
| Composite Landing | 1 |
| **Total** | **33** (31 atomic + 2 composite) |

---

## 11. Next Steps

1. **`repomap-core-4f0.7`:** Take the TOML draft from Section 6 and create the actual `.kilocode/commands.toml` file with schema validation
2. **`repomap-core-4f0.8`:** Compress the quality gate workflow to command dialect and measure token savings
3. Vocabulary sizes (25 verbs × 27 nouns) are larger than the 15×15 RISC target — consider pruning or compositing in 4f0.7

---

## References

- Original exploration: [`command-dialect-exploration.md`](command-dialect-exploration.md)
- Review with corrections: [`command-dialect-exploration-review.md`](command-dialect-exploration-review.md)
- Plant roadmap: `plans/roadmap-plant-infrastructure.md` (internal; not yet checked in)
- Thinking session: `.kilocode/thinking/` (internal/ephemeral; thoughts 545–547)
