---
name: repomap-verify-architecture
description: Verify architectural constraints using repomap before making changes. Check layer boundaries, detect violations, and ensure changes comply with layered architecture defined in repomap.toml.
---

# Repomap Verify Architecture

## When to use this skill

Use this skill when you need to:

- Verify layer boundaries before importing modules
- Check if a proposed change would violate architectural constraints
- Detect existing layer violations in the codebase
- Understand which layer a module belongs to
- Validate architectural changes before committing

## Prerequisites

- Artifacts must be generated: `.repomap/symbols.jsonl`, `.repomap/deps.edgelist`
- Layered architecture defined in `repomap.toml`

## Verification Commands

### Verify All Layer Boundaries

Check entire codebase for layer violations:

```bash
.venv/bin/python -m repomap verify
```

Expected output:
```
✓ No layer violations detected
```

Or if violations exist:
```
✗ Layer violation: parse.treesitter_symbols → cli
  Foundation layer cannot depend on interface layer
```

### Check Specific Module Layer

Find which layer a module belongs to:

```bash
grep "verify" .repomap/symbols.jsonl | jq '.layer' | head -1
```

Layers (repomap-core):
- `foundation` - Core parsing, scanning, graph algorithms, artifact generation
- `verification` - Determinism + validation checks
- `interface` - CLI

### Check Import Validity

Before importing, verify layer constraints:

**Example:** Can the CLI import from verification?

1. Check CLI layer:
   ```bash
   grep "cli" .repomap/symbols.jsonl | jq '.layer' | head -1
   # Output: "interface"
   ```

2. Check verification layer:
   ```bash
   grep "verify" .repomap/symbols.jsonl | jq '.layer' | head -1
   # Output: "verification"
   ```

3. Verify rule in `repomap.toml`:
   ```toml
   [[layers.rules]]
   from = "interface"
   to = ["verification", "foundation"]
   ```

4. Result: ✓ Valid (interface can import from verification)

### Detect Circular Dependencies

Check for circular dependencies in dependency graph:

```bash
# View all dependencies for a module
grep "^cli" .repomap/deps.edgelist

# Check if any dependencies create cycles
.venv/bin/python -c "
import sys
sys.path.insert(0, '.')
from graph.algos import detect_cycles
from pathlib import Path

edges = []
with open('.repomap/deps.edgelist') as f:
    for line in f:
        source, target = line.strip().split()
        edges.append((source, target))

cycles = detect_cycles(edges)
if cycles:
    print('Cycles detected:')
    for cycle in cycles:
        print(f'  {\" -> \".join(cycle)}')
else:
    print('No cycles detected')
"
```

## Layer Dependency Rules

From [`repomap.toml`](../../../repomap.toml):

```
interface → verification, foundation
verification → foundation
foundation → (nothing)
```

**Valid imports:**
- ✓ `cli` → `verify` (interface → verification)
- ✓ `verify` → `artifacts` (verification → foundation)

**Invalid imports:**
- ✗ `parse` → `cli` (foundation → interface)
- ✗ `verify` → `cli` (verification → interface)
- ✗ `artifacts` → anything (foundation → nothing)

## Pre-Commit Verification

Before committing code changes:

```bash
# 1. Regenerate artifacts
.venv/bin/python -m repomap generate .

# 2. Verify layer boundaries
.venv/bin/python -m repomap verify

# 3. If violations detected, fix before committing
```

## Integration with Workflows

Use in refactoring workflow:

1. **Before refactoring:**
   - Run `repomap verify` to understand current state

2. **During refactoring:**
   - Check layer constraints before adding imports
   - Verify no circular dependencies introduced

3. **After refactoring:**
   - Regenerate artifacts: `.venv/bin/python -m repomap generate .`
   - Verify boundaries: `.venv/bin/python -m repomap verify`
   - Ensure no violations introduced

## Common Violations and Fixes

### Violation: Foundation → Interface

**Problem:**
```python
# src/parse/treesitter_symbols.py (foundation)
from cli import main  # ✗ foundation → interface
```

**Fix:**
```python
# Move shared helpers to foundation (or invert dependency)
# src/parse/treesitter_symbols.py (foundation)
def parse_symbols(...):
    ...

# src/cli.py (interface)
from parse.treesitter_symbols import parse_symbols  # ✓ interface → foundation
```

### Violation: Verification → Interface

**Problem:**
```python
# src/verify/verify.py (verification)
from cli import main  # ✗ verification → interface
```

**Fix:**
```python
# Keep verification generic and callable by CLI
# src/verify/verify.py (verification)
def verify(...):
    ...

# src/cli.py (interface)
from verify.verify import verify  # ✓ interface → verification
```

## References

- Layer config: [`repomap.toml`](../../../repomap.toml)
- Architecture: [`architecture.md`](../../rules/memory-bank/architecture.md)
- Workflow: [`refactor.md`](../../workflows/refactor.md)
