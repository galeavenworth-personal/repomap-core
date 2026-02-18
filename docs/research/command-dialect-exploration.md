# Command Dialect + Receipt-Verified Workflows

**Date:** 2026-02-17  
**Status:** Exploration  
**Thinking session:** [`.kilocode/thinking/command-dialect-receipts-2026-02-17.json`](../../.kilocode/thinking/command-dialect-receipts-2026-02-17.json)  
**Agent-receipts repo:** https://github.com/galeavenworth-personal/agent-receipts

---

## Core Hypothesis

Certain English verbs carry enough semantic weight from model training that they activate strong procedural patterns without elaboration. "Validate against schema" triggers the same procedure as a 500-word workflow step because the model already has deep training on validation patterns.

The 3-word command structure is a **trigger mechanism**, not an instruction mechanism.
The receipt system is a **proof mechanism**, not a trust mechanism.

Together: **trigger → execute → prove**.

---

## Three Interlocking Systems

### System 1: Command Dialect (instruction compression)

**Structure:** `Verb + Preposition + Noun`

- Verb = operation family (what to do)
- Noun = domain object (what to do it to)
- Preposition = refinement (how/where/against) — does NOT control routing at MVP

**Routing:** Verb+Noun resolves to a skill binding. If no binding exists, emit a line fault.

**Why it works:** LLMs are trained on millions of pages of software engineering content. The word "validate" activates a dense cluster of procedural knowledge. You don't need to TEACH this — you need to TRIGGER it.

**Compression limits:** Works best for well-known software engineering patterns. Degrades for project-specific concepts (like our receipt system or orchestration tiers). Novel operations still need their own instruction surface.

### System 2: Agent Receipts (execution verification)

**Problem solved:** In multi-agent workflows, sub-agents report task completion via text. Text can be hallucinated. There is no mechanical proof that a tool was actually invoked.

**Solution:** A Rust binary wraps CLI calls and produces cryptographic receipts.

```
ar exec -- .venv/bin/python -m pytest -q
```

Produces a receipt:

```
Receipt {
    sha: "a3f8...",           // SHA-256(command + timestamp + exit_code + output_hash)
    command: "pytest -q",
    exit_code: 0,
    stdout_hash: "b7c2...",
    stderr_hash: "e4d1...",
    timestamp: "2026-02-17T16:20:00Z",
    session_id: "gate-quality-001",
    consumed: false,
    consumed_by: None,
    consumed_at: None,
}
```

**One-time use:** Orchestrator validates receipt, then marks it consumed. Prevents:
- Fabricated receipts (SHA must exist in DB)
- Replayed receipts (consumed flag blocks reuse)
- Unverified work claims (no receipt = incomplete command)

**Storage:** SQLite per orchestration session. Scoped, shareable via file path.

**Degradation:** If `ar` is unavailable, fall back to trust-based execution with a `DEGRADED` flag. Never block work on receipt infrastructure.

### System 3: Routing Matrix (connective tissue)

A static config (TOML) mapping Verb+Noun pairs to skill bindings, tool templates, and receipt requirements.

```toml
[commands.format_ruff]
verb = "format"
noun = "ruff"
skill = "quality-gates"
tool = ".venv/bin/python -m ruff format --check ."
receipt_required = true

[commands.check_ruff]
verb = "check"
noun = "ruff"  
skill = "quality-gates"
tool = ".venv/bin/python -m ruff check ."
receipt_required = true

[commands.check_mypy]
verb = "check"
noun = "mypy"
skill = "quality-gates"
tool = ".venv/bin/python -m mypy src"
receipt_required = true

[commands.test_pytest]
verb = "test"
noun = "pytest"
skill = "quality-gates"
tool = ".venv/bin/python -m pytest -q"
receipt_required = true

[commands.sync_remote]
verb = "sync"
noun = "remote"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd sync --no-push"
receipt_required = false

[commands.retrieve_codebase]
verb = "retrieve"
noun = "codebase"
skill = "repomap-codebase-retrieval"
tool = "mcp:augment-context-engine:codebase-retrieval"
receipt_required = false

[commands.spawn_subtask]
verb = "spawn"
noun = "subtask"
skill = "orchestration"
tool = "new_task"
receipt_required = false

[commands.validate_receipt]
verb = "validate"
noun = "receipt"
skill = "agent-receipts"
tool = "ar validate"
receipt_required = false

[commands.close_issue]
verb = "close"
noun = "issue"
skill = "beads-local-db-ops"
tool = ".kilocode/tools/bd close"
receipt_required = false

[commands.export_session]
verb = "export"
noun = "session"
skill = "sequential-thinking"
tool = "mcp:sequentialthinking:export-session"
receipt_required = false

[commands.decompose_task]
verb = "decompose"
noun = "task"
skill = "orchestration"
tool = "mcp:sequentialthinking:process-thought"
receipt_required = false

[commands.search_issues]
verb = "search"
noun = "issues"
skill = "sonarqube-ops"
tool = "mcp:sonarqube:search-sonar-issues-in-projects"
receipt_required = false

# Composite command: expands to multiple sub-commands
[commands.gate_quality]
verb = "gate"
noun = "quality"
skill = "quality-gates"
composite = ["format_ruff", "check_ruff", "check_mypy", "test_pytest"]
receipt_required = true
```

---

## Compressed Workflow Example

### Current: Quality Gate Workflow (~5000 chars)

A multi-page markdown document with headings, explanations, code blocks, error handling instructions, and advisory prose.

### Compressed: Command Dialect (6 lines)

```
Sync from remote
Format with ruff
Check with ruff
Check with mypy
Test with pytest
Gate against results
```

Each line is a routable command. Each command produces a receipt when agent-receipts is available. The orchestrator receives receipt SHAs and validates them.

---

## MVP Verb Vocabulary (12 high-gravity verbs)

| Verb       | Semantic Weight | Operation Family |
|------------|----------------|-----------------|
| sync       | High           | State reconciliation |
| validate   | High           | Conformance checking |
| format     | High           | Style enforcement |
| check      | High           | Static analysis |
| test       | High           | Dynamic verification |
| retrieve   | High           | Information gathering |
| search     | High           | Discovery |
| spawn      | Medium         | Subtask creation |
| export     | Medium         | State persistence |
| close      | Medium         | Lifecycle completion |
| decompose  | Medium         | Task breakdown |
| gate       | Medium         | Checkpoint evaluation |

## MVP Noun Vocabulary (12 domain nouns)

| Noun       | Domain Object |
|------------|--------------|
| remote     | Git/beads remote state |
| ruff       | Linter/formatter tool |
| mypy       | Type checker tool |
| pytest     | Test runner tool |
| codebase   | Semantic search target |
| issues     | SonarQube/beads issues |
| subtask    | Orchestration work unit |
| session    | Thinking/work session |
| receipt    | Execution proof |
| issue      | Task tracking item |
| task       | Work unit |
| quality    | Composite gate |

---

## Semantic Weight Analysis

### Strong Activation (verb carries full procedure)

- "Validate against schema" → model knows: check inputs, compare to spec, return pass/fail
- "Format with ruff" → model knows: run formatter, report diffs
- "Test with pytest" → model knows: run test suite, interpret failures
- "Decompose into subtasks" → model knows: break complex task into bounded pieces

### Weak Activation (needs project context)

- "Spawn as subtask" → spawn WHAT? Needs: "Spawn gate-check as subtask"
- "Close with receipt" → NEW concept, not pre-trained. Receipt semantics must be taught.

**Implication:** Two layers needed:
1. Command dialect for routing (3-word triggers for established ops)
2. Skill definitions for execution (project-specific procedures)

---

## Agent-Receipts MVP Scope

### CLI Interface

```bash
ar exec -- <command>              # Wrap and record execution
ar validate <sha>                 # Check receipt exists + unconsumed
ar consume <sha>                  # Mark as used (one-time)
ar list [--session <id>]          # List receipts for audit
```

### Receipt Schema

```rust
struct Receipt {
    sha: String,                    // SHA-256(command + timestamp + exit_code + output_hash)
    command: String,                // Actual command executed
    exit_code: i32,                 // Process exit code
    stdout_hash: String,            // SHA-256 of stdout
    stderr_hash: String,            // SHA-256 of stderr
    timestamp: DateTime<Utc>,       // Execution time
    session_id: String,             // Links to orchestration session
    consumed: bool,                 // One-time use flag
    consumed_by: Option<String>,    // Which orchestrator consumed it
    consumed_at: Option<DateTime<Utc>>,
}
```

### Why Rust

The wrapping layer adds latency to every tool call. It needs sub-millisecond hash generation and DB write. SQLite + Rust is the right choice for invisible overhead.

---

## Evolutionary Path

| Phase | Deliverable | Verification Level |
|-------|------------|-------------------|
| 0     | This exploration document | None (design) |
| 0.5   | Compressed quality-gate workflow | Token savings measurement |
| 1     | agent-receipts MVP (Rust) | Execution proof |
| 2     | Receipt-gated workflows | Mechanical verification |
| 3     | Temporal.io integration | Durable execution + exactly-once |

### Bridge Technology Pattern

agent-receipts is not competing with Temporal. It's a bridge:

- Phase 1-2: Receipts provide mechanical verification without Temporal's infrastructure
- Phase 3: Commands become Temporal activities, receipts become activity results in Temporal's execution history
- The command dialect maps cleanly to workflow definitions in any orchestration framework

---

## Risk Registry

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Over-compression loses context | Medium | Routing matrix safety net; skills provide specifics |
| Receipt overhead slows development | Low | Receipts optional during dev, mandatory during gates |
| Receipt DB corruption | Low | Additive proof, not blocking; DEGRADED fallback |
| Vocabulary creep | Medium | Hard cap: 15 verbs × 15 nouns × ~50 active bindings (RISC) |
| Agents game receipt system | Medium | Receipts prove execution, not correctness; tests still needed |

---

## Trust Model Comparison

### Current (trust-based)

```
Orchestrator: "Run quality gates"
Sub-agent: "Quality gates passed" (text)
Orchestrator: trusts text response
```

### Receipt-based

```
Orchestrator: "Gate against quality"
Sub-agent: runs 4 tools via `ar exec`, gets 4 receipt SHAs
Sub-agent: returns [sha1, sha2, sha3, sha4]
Orchestrator: `ar validate` each SHA → all valid
Orchestrator: `ar consume` each SHA → marked one-time-use
Result: mechanical proof of execution
```

---

## Key Insight

This is the minimum viable control surface for mechanically verifiable agent workflows.

**3-word commands** compress instructions by exploiting model pre-training.  
**Agent receipts** prove execution via cryptographic hashing.  
**The routing matrix** connects triggers to tools.

Everything else is elaboration.
