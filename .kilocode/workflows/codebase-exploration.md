---
description: Multi-tool codebase exploration strategy for layered understanding
punch_card: codebase-exploration
---

# Codebase Exploration Workflow

Use this workflow when you need to understand, investigate, or work with unfamiliar code. The key insight is that **each tool compensates for the weaknesses of others**.

**Punch Card:** `codebase-exploration` (3 rows, 2 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Tool Arsenal

| Tool | Command Route | Strength | Weakness |
|------|---------------|----------|----------|
| **Augment Context Engine** | 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml) | **PRIMARY TOOL** — Semantic understanding, architecture patterns, single-call efficiency, best for "how does X work?" | Less control over exact matches, may miss structural outliers |
| **Regex Search** | `search_files` (Kilo native) | Precise pattern matching, file filtering, context-rich results, Rust regex power | Keyword-dependent, no semantic understanding, requires knowing what to search for |
| **File Reading** | `read_file` (Kilo native) | Batch reads (up to 5 files), line numbers for diffing, exact content | Manual file selection, no search capability |
| **Directory Listing** | `list_files` (Kilo native) | Recursive or top-level structure, understand organization | No content search, just file names |
| **Library Docs** | 📌 `resolve library` → [`commands.resolve_library`](../commands.toml), 📌 `query docs` → [`commands.query_docs`](../commands.toml) | Up-to-date API reference for external dependencies | Only for third-party libraries |

## Tool Selection Priority

**CRITICAL:** Augment Context Engine is the PRIMARY tool for code search. Use it FIRST for:
- Understanding how features work
- Finding architectural patterns
- Locating relevant files and modules
- Semantic code understanding

> 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
> Resolves to: `mcp--augment___context___engine--codebase___retrieval`

Use other tools to complement Augment:
- `search_files` — When you need ALL occurrences of a specific pattern
- `read_file` — When you know exactly which files to examine
- `list_files` — When you need to understand directory structure

For external library APIs:

> 📌 `resolve library` → [`commands.resolve_library`](../commands.toml)
> Resolves to: `mcp--context7--resolve___library___id`

> 📌 `query docs` → [`commands.query_docs`](../commands.toml)
> Resolves to: `mcp--context7--query___docs`

## Exploration Patterns

### Pattern 1: New Feature Investigation

```
1. retrieve codebase              → commands.retrieve_codebase
   "How does [feature] work in this codebase?"
   → Get semantic overview, find relevant files and architectural patterns

2. read_file: Read key files identified in step 1 (batch up to 5)
   → Deep dive into implementation details with line numbers

3. search_files: "[specific pattern or function name]"
   → Find ALL occurrences and call sites with context

4. list_files: Explore related directories if needed
   → Understand module organization
```

### Pattern 2: Bug Investigation

```
1. retrieve codebase              → commands.retrieve_codebase
   "What code handles [feature with bug]?"
   → Find relevant files and understand intended behavior

2. search_files: "[error message or symptom keywords]"
   → Find where the error originates with context

3. read_file: Examine buggy code and related files (batch up to 5)
   → Understand implementation details

4. search_files: "[function/class name]" with file pattern
   → Find all call sites to ensure fix doesn't break callers
```

### Pattern 3: Refactoring

```
1. retrieve codebase              → commands.retrieve_codebase
   "What patterns exist for [refactoring goal]?"
   → Find existing conventions and architectural patterns

2. search_files: "[function/class name to refactor]"
   → Find ALL references (comprehensive search)

3. read_file: Examine all affected files (batch up to 5)
   → Understand dependencies and usage patterns

4. retrieve codebase              → commands.retrieve_codebase
   "What depends on [code to refactor]?"
   → Find downstream impacts and integration points
```

### Pattern 4: Understanding Unfamiliar Codebase

```
1. list_files: Get directory structure (recursive)
   → Understand module organization

2. retrieve codebase              → commands.retrieve_codebase
   "High-level architecture overview"
   → Get semantic understanding of components and patterns

3. read_file: Read key entry points and core modules (batch up to 5)
   → Understand implementation approach

4. retrieve codebase              → commands.retrieve_codebase
   "How does [specific component] work?"
   → Deep dive into interesting areas with semantic context
```

### Pattern 5: External Dependency Investigation

```
1. retrieve codebase              → commands.retrieve_codebase
   "How is [library] used in this codebase?"
   → Find usage patterns and integration points

2. resolve library                → commands.resolve_library
   → Get Context7-compatible library ID

3. query docs                     → commands.query_docs
   → Retrieve up-to-date API reference

4. read_file: Examine integration code (batch up to 5)
   → Verify usage matches current API
```

## Combining Results

Each tool adds a **layer of understanding**:

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Augment Context Engine (PRIMARY)               │
│   retrieve codebase             → commands.retrieve_codebase
│   Semantic relationships, architecture, patterns        │
│   START HERE for "how does X work?" questions           │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Regex Search (search_files — Kilo native)      │
│   Precise pattern matching, ALL occurrences, context    │
│   Use for "find all references to X"                    │
├─────────────────────────────────────────────────────────┤
│ Layer 3: File Reading (read_file — Kilo native)         │
│   Exact content, line numbers, batch reads (5 files)    │
│   Use when you know which files to examine              │
├─────────────────────────────────────────────────────────┤
│ Layer 4: Directory Listing (list_files — Kilo native)   │
│   File structure, module organization                   │
│   Use to understand project layout                      │
├─────────────────────────────────────────────────────────┤
│ Layer 5: Library Docs (Context7)                        │
│   resolve library               → commands.resolve_library
│   query docs                    → commands.query_docs
│   Up-to-date API reference for external dependencies    │
└─────────────────────────────────────────────────────────┘
```

**Best results come from intelligently assembling all layers, starting with Augment.**

## Anti-Patterns

❌ Using only one tool for complex investigations
❌ Skipping Augment and starting with regex search (misses semantic connections)
❌ Not using batch file reading (read_file supports up to 5 files at once)
❌ Using search_files for semantic questions (use `retrieve codebase` instead)
❌ Forgetting to verify Augment results with precise regex searches
❌ Guessing library APIs without checking Context7

## Example: Investigating Determinism Verification (repomap-core)

**Goal**: Understand how determinism is verified and enforced

1. **`retrieve codebase`** → [`commands.retrieve_codebase`](../commands.toml)
   "How does determinism verification work? Where is it enforced?"
   → Returns: key entry points under `src/verify/**`, related test coverage, and any CLI hooks

2. **`read_file`**: Read key files identified (batch 5 at once)
   → Returns: exact implementation with line numbers

3. **`search_files`**: `"determinism|stable|hash|fingerprint"` with pattern `*.py`
   → Returns: all occurrences and call sites with context

4. **`list_files`**: Explore `src/verify/` + `tests/` (recursive)
   → Returns: full surface area for verification logic + regression tests

**Result**: Complete understanding from architecture to implementation to all usages.

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint auto --bead-id {bead_id}`

> 🚪 `checkpoint punch-card {task_id} codebase-exploration` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint auto codebase-exploration`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with exploration results.

---

## Related Workflows

- [`/start-task`](./start-task.md) — Meta-workflow that calls this as Phase 2
- [`/prep-task`](./prep-task.md) — Task preparation using exploration results
- [`/execute-task`](./execute-task.md) — Implementation phase

## Related Skills

- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`context7-docs-ops`](../skills/context7-docs-ops/SKILL.md) — Library documentation

## Philosophy: Software Fabrication

- **Determinism** — Same query → same understanding → same decisions
- **Evidence-based** — Each layer adds verifiable evidence
- **Structure discipline** — commands.toml routes all the way down
- **Self-verifying** — Punch card checkpoint gates the exit
