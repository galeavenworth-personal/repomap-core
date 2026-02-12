---
description: Multi-tool codebase exploration strategy for layered understanding
---

# Codebase Exploration Workflow

Use this workflow when you need to understand, investigate, or work with unfamiliar code. The key insight is that **each tool compensates for the weaknesses of others**.

## Tool Arsenal

| Tool | Invocation | Strength | Weakness |
|------|------------|----------|----------|
| **Augment Context Engine** | `codebase-retrieval` | **PRIMARY TOOL** — Semantic understanding, architecture patterns, single-call efficiency, best for "how does X work?" | Less control over exact matches, may miss structural outliers |
| **Regex Search** | `search_files` | Precise pattern matching, file filtering, context-rich results, Rust regex power | Keyword-dependent, no semantic understanding, requires knowing what to search for |
| **File Reading** | `read_file` | Batch reads (up to 5 files), line numbers for diffing, exact content | Manual file selection, no search capability |
| **Directory Listing** | `list_files` | Recursive or top-level structure, understand organization | No content search, just file names |

## Tool Selection Priority

**CRITICAL:** Augment Context Engine (`codebase-retrieval`) is the PRIMARY tool for code search. Use it FIRST for:
- Understanding how features work
- Finding architectural patterns
- Locating relevant files and modules
- Semantic code understanding

Use other tools to complement Augment:
- `search_files` — When you need ALL occurrences of a specific pattern
- `read_file` — When you know exactly which files to examine
- `list_files` — When you need to understand directory structure

## Exploration Patterns

### Pattern 1: New Feature Investigation

```
1. codebase-retrieval: "How does [feature] work in this codebase?"
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
1. codebase-retrieval: "What code handles [feature with bug]?"
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
1. codebase-retrieval: "What patterns exist for [refactoring goal]?"
   → Find existing conventions and architectural patterns

2. search_files: "[function/class name to refactor]"
   → Find ALL references (comprehensive search)

3. read_file: Examine all affected files (batch up to 5)
   → Understand dependencies and usage patterns

4. codebase-retrieval: "What depends on [code to refactor]?"
   → Find downstream impacts and integration points
```

### Pattern 4: Understanding Unfamiliar Codebase

```
1. list_files: Get directory structure (recursive)
   → Understand module organization

2. codebase-retrieval: "High-level architecture overview"
   → Get semantic understanding of components and patterns

3. read_file: Read key entry points and core modules (batch up to 5)
   → Understand implementation approach

4. codebase-retrieval: "How does [specific component] work?"
   → Deep dive into interesting areas with semantic context
```

## Combining Results

Each tool adds a **layer of understanding**:

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: Augment Context Engine (PRIMARY)               │
│   Semantic relationships, architecture, patterns        │
│   START HERE for "how does X work?" questions           │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Regex Search (search_files)                    │
│   Precise pattern matching, ALL occurrences, context    │
│   Use for "find all references to X"                    │
├─────────────────────────────────────────────────────────┤
│ Layer 3: File Reading (read_file)                       │
│   Exact content, line numbers, batch reads (5 files)    │
│   Use when you know which files to examine              │
├─────────────────────────────────────────────────────────┤
│ Layer 4: Directory Listing (list_files)                 │
│   File structure, module organization                   │
│   Use to understand project layout                      │
└─────────────────────────────────────────────────────────┘
```

**Best results come from intelligently assembling all layers, starting with Augment.**

## Anti-Patterns

❌ Using only one tool for complex investigations
❌ Skipping Augment and starting with regex search (misses semantic connections)
❌ Not using batch file reading (read_file supports up to 5 files at once)
❌ Using search_files for semantic questions (use codebase-retrieval instead)
❌ Forgetting to verify Augment results with precise regex searches

## Example: Investigating Determinism Verification (repomap-core)

**Goal**: Understand how determinism is verified and enforced

1. **codebase-retrieval**: "How does determinism verification work? Where is it enforced?"
   → Returns: key entry points under `src/verify/**`, related test coverage, and any CLI hooks

2. **read_file**: Read key files identified (batch 5 at once)
   → Returns: exact implementation with line numbers

3. **search_files**: `"determinism|stable|hash|fingerprint"` with pattern `*.py`
   → Returns: all occurrences and call sites with context

4. **list_files**: Explore `src/verify/` + `tests/` (recursive)
   → Returns: full surface area for verification logic + regression tests

**Result**: Complete understanding from architecture to implementation to all usages.
