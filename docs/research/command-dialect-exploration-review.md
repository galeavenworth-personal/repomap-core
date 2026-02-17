# Review: Command Dialect + Receipt-Verified Workflows

**Date:** 2026-02-17  
**Reviewer:** plant-manager (anthropic/claude-opus-4.6)  
**Subject:** [`docs/research/command-dialect-exploration.md`](../research/command-dialect-exploration.md)  
**Thinking session:** [`.kilocode/thinking/command-dialect-receipts-2026-02-17.json`](../../.kilocode/thinking/command-dialect-receipts-2026-02-17.json) (thoughts 521–537)  

---

## Review Summary

The exploration document proposes three interlocking systems — a command dialect (3-word instruction compression), agent receipts (cryptographic execution proofs), and a routing matrix (verb+noun → skill/tool config). The core hypothesis about semantic compression is credible: "trigger → execute → prove" is a clean mental model.

**However, the research was produced without accessing the actual codebase.** The prior agent's thinking session (24 thoughts) contains zero references to existing files under `.kilocode/tools/`, `.kilocode/contracts/`, `.kilocode/workflows/`, or `.kilocode/skills/`. This resulted in several significant blind spots where the document reinvents or mischaracterizes infrastructure that already exists.

---

## What the Document Gets Right

### 1. Core Hypothesis (Strong)
The claim that certain verbs ("validate", "format", "test") carry enough training-derived semantic weight to act as procedural triggers is well-argued. The distinction between **trigger mechanism** (command dialect) vs **proof mechanism** (receipts) is clean and insightful.

### 2. Semantic Weight Analysis (Strong)
The strong vs. weak activation categorization (lines 232–247) is realistic. Acknowledging that project-specific concepts like receipts need their own instruction surface is honest and avoids over-claiming.

### 3. Trust Model Comparison (Strong)
The trust-based vs receipt-based comparison (lines 316–337) clearly articulates the problem that orchestrators currently trust text responses without mechanical verification. This is a real gap.

### 4. Evolutionary Path (Reasonable)
The phased approach (exploration → compressed workflow → receipts MVP → receipt-gated workflows → Temporal) is sensible. Bridge technology framing is appropriate.

---

## What the Document Misses or Gets Wrong

### Finding 1: `bounded_gate.py` Already Implements ~60% of the Receipt Pattern

The document proposes agent-receipts as: "a Rust binary wraps CLI calls and produces cryptographic receipts" with SHA hashing, exit code capture, and audit logging.

**What already exists:**

[`.kilocode/tools/bounded_gate.py`](../../.kilocode/tools/bounded_gate.py:1) already:
- Wraps arbitrary commands with wall-clock timeout and stall detection
- Captures exit codes and classifies outcomes as `pass`/`fail`/`fault`
- Appends audit records to [`.kilocode/gate_runs.jsonl`](../../.kilocode/gate_runs.jsonl) with `bead_id`, `run_timestamp`, `gate_id`, `status`, and `elapsed_seconds`
- Emits Line Fault Contract JSON on timeouts/stalls (exit code 2)
- Is already mandatory in orchestrated workflows per [`process-orchestrator`](../../.kilocodemodes:349) mode definition

**What's missing from bounded_gate vs proposed receipts:**
- SHA-256 content hashing of stdout/stderr
- One-time consumption semantics (`consumed`/`consumed_by`/`consumed_at`)
- Session-scoped receipt DB (bounded_gate uses a flat JSONL append log)
- MCP tool wrapping (bounded_gate only handles CLI commands)

**Strategic implication:** `bounded_gate.py` is scaffolding that should be **retired** once agent-receipts reaches parity, not extended in parallel. Building two proof-of-execution systems simultaneously is wasteful. The right move is to build agent-receipts as the first-class primitive with a clear migration path:

1. Agent-receipts MVP reaches CLI parity with bounded_gate (exec + audit + timeout/stall)
2. Migrate `beads_land_plane.sh` and workflow instructions to use `ar exec` instead of `bounded_gate.py`
3. Retire `bounded_gate.py` and `gate_runs.jsonl` in favor of the receipt DB
4. Add MCP tool wrapping as a second interface to the same binary

The agent-receipts exploration document correctly identifies this as a standalone tool, not an in-repo Python extension. The design doc's routing matrix entries should migrate to `ar`-wrapped invocations.

**Critical design target:** A single surface area for ALL commands regardless of origin. Whether an agent runs a raw bash command (`ar exec -- pytest -q`) or invokes an MCP tool, the same receipt system captures proof. This means `ar` needs both a CLI interface and an MCP server interface, producing receipts into the same SQLite store. One binary, two surfaces, one proof chain.

### Finding 2: The Routing Matrix Doesn't Match Actual Infrastructure

The TOML routing matrix (lines 77–169) maps verb+noun pairs to skill bindings and tools. Several entries have inaccuracies:

| Entry | Issue |
|---|---|
| `commands.sync_remote` | Tool listed as `bd sync --no-push` but actual invocation is [`.kilocode/tools/bd sync --no-push`](../../.kilocode/tools/bd:1) (repo-local wrapper) |
| `commands.retrieve_codebase` | Tool listed as `mcp:augment-context-engine:codebase-retrieval` but actual MCP tool name is `mcp--augment___context___engine--codebase___retrieval` |
| `commands.spawn_subtask` | Skill listed as `orchestration` — no such skill exists in [`.kilocode/skills/`](../../.kilocode/skills/) |
| `commands.validate_receipt` | Skill listed as `agent-receipts` — this skill doesn't exist (it's the proposed new system) |
| Multiple entries | Skill `quality-gates` is not an actual skill directory; the actual mechanism is [`bounded_gate.py`](../../.kilocode/tools/bounded_gate.py:1) + [`beads_land_plane.sh`](../../.kilocode/tools/beads_land_plane.sh:1) |
| `commands.decompose_task` | Maps to `mcp:sequentialthinking:process-thought` which is the thinking tool, not a task decomposition skill |

**Existing skills** (from [`.kilocode/skills/`](../../.kilocode/skills/)):
- `beads-local-db-ops` — Beads task tracking
- `context7-docs-ops` — Third-party library docs
- `github-cli-code-review` — PR review via `gh`
- `repomap-codebase-retrieval` — Semantic code search via Augment
- `sequential-thinking-default` — Structured reasoning
- `sonarqube-ops` — SonarQube quality inspection

The routing matrix needs to be rebuilt against actual skill and tool inventories.

### Finding 3: The Landing Script Already Orchestrates Composite Gates

The document proposes composite commands (line 162–168): `gate_quality` expanding to `[format_ruff, check_ruff, check_mypy, test_pytest]`.

**This already exists.** [`beads_land_plane.sh`](../../.kilocode/tools/beads_land_plane.sh:1) is the canonical landing entrypoint that:
1. Runs beads preflight
2. Executes all 4 quality gates via [`bounded_gate.py`](../../.kilocode/tools/bounded_gate.py:1) with shared `RUN_TIMESTAMP`
3. Verifies audit proof in [`.kilocode/gate_runs.jsonl`](../../.kilocode/gate_runs.jsonl)
4. Closes the bead
5. Syncs beads state

The "6-line compressed workflow" in the document (lines 181–188) is essentially what `beads_land_plane.sh` already does in shell script form. The compression isn't novel — it's already implemented.

### Finding 4: Skill Activation Already Functions as Implicit Routing

The document's routing matrix overlaps conceptually with the existing **mandatory skill check** in the system prompt. Every mode already:
1. Evaluates user requests against skill descriptions
2. Selects the most specific matching skill
3. Loads the skill's `SKILL.md` into context
4. Follows skill instructions

This is a soft routing layer (natural language matching to skill descriptions) rather than the hard routing the document proposes (verb+noun → TOML config). The difference is important — the existing system is fuzzy and tolerant, while the proposed system is deterministic but rigid.

**Neither approach is strictly better.** The document should acknowledge the existing skill activation system and explain why hard routing via a TOML matrix adds value over the current fuzzy matching.

### Finding 5: The Contract System Already Exists

The document doesn't reference the existing contract infrastructure:

- [`.kilocode/contracts/line_health/line_fault_contract.md`](../../.kilocode/contracts/line_health/line_fault_contract.md:1) — Structured fault payloads (gate_id, invocation, stop_reason, repro_hints)
- [`.kilocode/contracts/line_health/restoration_contract.md`](../../.kilocode/contracts/line_health/restoration_contract.md:1) — Fitter → Orchestrator mitigation reports
- [`.kilocode/contracts/composability/handoff_packet.md`](../../.kilocode/contracts/composability/handoff_packet.md:1) — Parent → Child structured handoffs
- [`.kilocode/contracts/composability/error_propagation.md`](../../.kilocode/contracts/composability/error_propagation.md:1) — Failure propagation across nesting levels
- [`.kilocode/contracts/composability/return_format.md`](../../.kilocode/contracts/composability/) — Child → Parent return conventions

These contracts already establish the structured communication patterns that the receipt system proposes to formalize. The research should build on this foundation.

### Finding 6: `workflow_gate.py` Already Validates Plant Configuration

The document doesn't mention [`workflow_gate.py`](../../.kilocode/tools/workflow_gate.py:1), which validates:
- Mode definitions (`.kilocodemodes` YAML parsing, slug uniqueness, required fields)
- Skill loading (SKILL.md existence and frontmatter validity)
- Contract parsing (contract file existence and structure)
- Workflow coherence (fileRegex compilation, tool group validation)

This is relevant because any routing matrix TOML would also need validation, and the existing gate infrastructure shows how that's done.

---

## Specific Technical Concerns

### Rust as the Right Choice for Agent-Receipts

The document correctly identifies Rust for agent-receipts. While the latency argument ("sub-millisecond hash generation") is valid but overstated (Python hash speed is adequate), the stronger reasons for Rust are:

1. **Single binary distribution** — `ar` ships as one executable with no runtime dependencies. No `.venv` activation, no Python version management, no pip install. This is critical for a tool that wraps *all* command execution.
2. **MCP server capability** — agent-receipts will need an MCP server interface alongside CLI. Rust (via `rmcp` or similar) can serve both from one binary.
3. **Cross-project reuse** — A standalone Rust tool works across any project, not just Python repos with `.venv`.
4. **Retirement of bounded_gate** — Building the replacement in a different language enforces a clean break rather than incremental entanglement.

The bounded_gate.py infrastructure ([`bounded_gate.py`](../../.kilocode/tools/bounded_gate.py:1), [`gate_runs.jsonl`](../../.kilocode/gate_runs.jsonl), [`beads_land_plane.sh`](../../.kilocode/tools/beads_land_plane.sh:1)) serves as a **specification by example** for what `ar` must replicate at MVP: command wrapping, timeout/stall detection, exit code classification, and audit logging. Once `ar` reaches parity, these Python tools should be retired.

### Vocabulary Creep Risk

The document proposes a "hard cap: 15 verbs × 15 nouns × ~50 active bindings." But the routing matrix already has 13 entries covering only quality gates + basic ops. Real workflow operations include:
- PR review (fetch comments, post replies, build ledger)
- Architecture exploration (codebase retrieval, sequential thinking)  
- Beads lifecycle (create, update, close, sync, show, ready)
- Git operations (commit, push, branch, rebase)
- MCP tool invocation (SonarQube, Context7, Augment)

50 bindings will be exceeded quickly. The RISC analogy (line 311) is apt, but the document doesn't show how composite commands prevent vocabulary explosion in practice.

---

## Recommendations

### 1. Ground the Routing Matrix in Actual Infrastructure
Rebuild the TOML matrix by inventorying:
- Actual skills in [`.kilocode/skills/`](../../.kilocode/skills/)
- Actual tools in [`.kilocode/tools/`](../../.kilocode/tools/)
- Actual MCP tool names from connected servers
- Actual contract patterns from [`.kilocode/contracts/`](../../.kilocode/contracts/)

### 2. Position Agent-Receipts as Replacing Bounded Gate (Not Extending It)
`bounded_gate.py` + `gate_runs.jsonl` is scaffolding that `ar` should subsume and retire. Use the existing tools as a **specification by example**: `ar` must match bounded_gate's timeout/stall detection, exit code classification, and audit logging at MVP, then add content hashing, one-time consumption, and MCP wrapping. Build one first-class primitive instead of maintaining two parallel systems. Migration path: `ar exec` reaches parity → `beads_land_plane.sh` migrates → `bounded_gate.py` retires.

### 3. Clarify Relationship to Existing Skill Activation
The mandatory skill check in the system prompt already routes operations to skills. Explain:
- When does hard TOML routing add value over fuzzy skill matching?
- Is the command dialect an alternative to skill activation or a layer above it?
- Can they coexist (commands route to skills, which invoke tools)?

### 4. Scope the MVP More Precisely
Phase 0.5 (compressed quality-gate workflow) is a good starting point. But measure the actual token savings against the existing `beads_land_plane.sh` invocation, not against the full 27K-char `orchestrate-execute-task.md` (which is already marked reference-only).

### 5. Address the Receipt-Gated Workflow Enforcement Gap
The document describes receipt validation at the orchestrator level, but doesn't address: who enforces that sub-agents actually use `ar exec` instead of running commands directly? In the current system, `process-orchestrator` mode instructions mandate `bounded_gate.py`, but agents can (and do) bypass it. Receipt enforcement at the tool layer (intercepting all `execute_command` calls) would be stronger than at the instruction layer.

---

## Verdict

**The exploration is directionally valuable but insufficiently grounded in the current codebase.** The core ideas (semantic compression, cryptographic execution proofs, single-surface routing matrix) are sound and the strategic vision — build `ar` as the first-class primitive, retire `bounded_gate.py`, unify CLI + MCP under one receipt surface — is the right call. But the document was produced without inspecting the ~12,000 lines of existing workflow infrastructure under `.kilocode/`, resulting in:

1. **Inaccurate routing matrix** — wrong tool paths, nonexistent skill names, MCP tool name mismatches
2. **Missing migration story** — no acknowledgment that `bounded_gate.py` / `beads_land_plane.sh` / `gate_runs.jsonl` exist and need a retirement plan
3. **Missing contract context** — existing line-fault/restoration/handoff contracts already establish structured agent communication patterns that `ar` should interoperate with

The Rust choice is correct for the reasons of single-binary distribution, MCP server capability, and cross-project reuse. The "build the right thing once" strategy (agent-receipts as THE proof-of-execution primitive, not a parallel system) is sound and should be explicitly stated in the document.

**Recommended disposition:** Revise the document to:
1. Rebuild the routing matrix against actual skill/tool inventories
2. Add a "Migration from bounded_gate" section documenting what `ar` must replicate at MVP parity
3. Add the single-surface-area design target (CLI + MCP → same receipt DB)
4. Proceed with Phase 0.5 (compressed quality-gate workflow using `ar exec`) as the integration proof
