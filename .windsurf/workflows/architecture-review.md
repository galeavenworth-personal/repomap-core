---
description: Run an architecture review against the codebase or a target area. Detects parallel paths, build-or-buy candidates, interface discipline violations, and SOLID principle issues. Can be used during planning (before writing code) or ad-hoc (on existing code).
---

# Architecture Review Workflow

Run all four lenses below against the **target scope** (a directory, module, or
the full `daemon/src/` tree). Produce a structured **review ledger** as output.

The target scope is determined by context:
- **Planning phase**: the modules/files the upcoming task will touch
- **Ad-hoc**: a directory or the entire codebase (`daemon/src/`, `src/`, or both)

---

## Lens 1 — Parallel Path Elimination

**Goal**: Find duplicate or near-duplicate implementations that solve the same
problem in different places. Duplicates diverge over time and become
unmaintainable.

### Machine checks

1. **Duplicate function names across files**
   ```bash
   grep -rn '^function \|^export function \|^async function \|^export async function ' \
     <scope> --include='*.ts' \
     | sed 's/(.*//' | awk -F: '{print $NF}' | sort | uniq -c | sort -rn | head -20
   ```
   Any function name appearing 2+ times across different files is a candidate.

2. **Shared utility patterns not extracted**
   Search for common inline patterns that should be a shared utility:
   - `findRepoRoot`, `sleep`, `timestamp`, `checkPort` — if duplicated, extract
     to a shared module (e.g. `daemon/src/infra/utils.ts`).

3. **Repomap dependency overlap** (Python layer)
   Parse `.repomap/deps.edgelist`. Two modules with >70% overlap in their
   dependency sets likely solve overlapping problems:
   ```bash
   # For each module pair, compute Jaccard similarity of their dep sets
   ```

4. **Codebase-retrieval semantic check**
   Use `codebase-retrieval` to search for semantically similar implementations:
   "Find all implementations of [concept] across the codebase"

### Output per finding
```
| ID | Files | Function/Pattern | Action |
|----|-------|-----------------|--------|
| PP-1 | factory-dispatch.ts, stack-manager.ts | findRepoRoot() | Extract to shared utils |
```

### Resolution
- Extract the canonical implementation to a shared module
- Replace all duplicates with imports from the shared module
- Delete the duplicate implementations

---

## Lens 2 — Build-or-Buy Analysis

**Goal**: Detect areas where the codebase is hand-rolling solutions to problems
that well-maintained open-source libraries solve. High churn + high complexity =
strong signal.

### Machine checks

1. **Git churn analysis** — files touched most frequently indicate thrashing:
   ```bash
   git log --format='' --name-only -- '<scope>/**/*.ts' \
     | sort | uniq -c | sort -rn | head -15
   ```

2. **Complexity × churn cross-reference**
   Files with both high churn AND high LOC/cognitive complexity are candidates:
   ```bash
   wc -l <high-churn-files>
   ```
   Cross-reference with SonarQube cognitive complexity issues.

3. **Dependency count** — modules with many internal dependencies that
   implement a well-known pattern (e.g., "durable workflow execution",
   "audit trail", "schema migration") should be evaluated against libraries.

4. **Library research** — for each candidate, use Context7 and web search to
   find established libraries:
   - Search: `<problem domain> npm library` or `<problem domain> python library`
   - Evaluate: maintenance activity, star count, API fit, adoption cost
   - Present findings with a recommendation (adopt / keep hand-rolled / defer)

### Signal thresholds
- **Strong signal**: ≥5 commits touching file + ≥500 LOC + SonarQube complexity warning
- **Moderate signal**: ≥3 commits + ≥300 LOC
- **Weak signal**: high LOC alone (may be inherently complex domain)

### Output per finding
```
| ID | Module | Churn | LOC | Problem Domain | Library Candidates | Recommendation |
|----|--------|-------|-----|----------------|-------------------|----------------|
| BB-1 | factory-dispatch.ts | 6 commits | 895 | task dispatch + monitoring | Temporal SDK native | Research |
```

---

## Lens 3 — Interface Discipline

**Goal**: Every identifier consumed across a module boundary must be grounded in
a citable source. "Close enough" is fully wrong.

### Machine checks

1. **Cross-boundary imports audit**
   For the target scope, list all imports from other modules. For each:
   - Verify the imported identifier exists in the target module's exports
   - TypeScript compiler (`tsc --noEmit`) catches type-level violations
   - This lens focuses on **runtime identifiers**: config keys, database columns,
     API parameters, event names, CLI flags

2. **Env var / config key audit**
   ```bash
   grep -rn 'process\.env\.' <scope> --include='*.ts' | sort
   ```
   Each `process.env.X` must have a corresponding entry in `.env.example` or
   be documented in the config interface.

3. **Database column/table references**
   ```bash
   grep -rn "FROM \|INSERT INTO \|UPDATE \|SELECT " <scope> --include='*.ts'
   ```
   Each referenced table/column must exist in the schema (`.kilocode/tools/dolt_apply_punch_card_schema.sh` or migration files).

4. **CLI flag audit**
   For modules that parse `process.argv`, verify flags match documentation.

### Output per finding
```
| ID | File:Line | Identifier | Type | Grounded? | Source |
|----|-----------|-----------|------|-----------|--------|
| ID-1 | factory-dispatch.ts:72 | DOLT_PORT | env var | ✓ | .env.example |
```

---

## Lens 4 — SOLID Principles Review

**Goal**: Evaluate adherence to SOLID principles. Refactoring is now cheap and
high-value with agent tooling — flag violations worth fixing.

### Machine checks

#### S — Single Responsibility
```bash
# Count exports per module (high export count = likely SRP violation)
grep -rn 'export function\|export async function\|export class\|export interface\|export type' \
  <file> | wc -l
```
- **Threshold**: >15 exports from a single file = flag for review
- **Also check**: LOC per file (>500 = review, >800 = strong signal)
- **Also check**: Does the file mix concerns? (e.g., CLI parsing + business logic + I/O)

#### O — Open/Closed Principle
```bash
# Find switch/case on type discriminators (should be polymorphic)
grep -rn 'switch\s*(' <scope> --include='*.ts'
```
Switch statements on string/enum type discriminators that grow with each new
variant indicate OCP violations.

#### L — Liskov Substitution
- Less machine-checkable; look for `as` type assertions that bypass type safety
```bash
grep -rn ' as [A-Z]' <scope> --include='*.ts' | grep -v 'import'
```

#### I — Interface Segregation
```bash
# Find interfaces with many optional members (consumers forced to handle irrelevance)
grep -A 50 'export interface' <file> | grep -c '?:'
```
Interfaces where >50% of members are optional suggest they should be split.

#### D — Dependency Inversion
- Use `deps.edgelist` (Python) or import analysis (TypeScript) to find
  high-level modules importing low-level modules directly
- High-level: orchestrators, workflows, CLI entry points
- Low-level: I/O, database, file system, process management
- The import should go through an abstraction (interface/type), not a concrete

### Output per finding
```
| ID | Principle | File | Signal | Severity | Recommendation |
|----|-----------|------|--------|----------|----------------|
| S-1 | SRP | factory-dispatch.ts | 30 exports, 895 LOC | High | Split into dispatch, monitor, audit modules |
```

---

## Producing the Review Ledger

After running all four lenses, compile findings into a single ledger:

```markdown
# Architecture Review Ledger — <scope> — <date>

## Summary
- Parallel Paths: N findings
- Build-or-Buy: N findings  
- Interface Discipline: N findings
- SOLID: N findings

## Findings
<tables from each lens>

## Recommended Actions
1. [highest priority action]
2. ...
```

### Severity classification
- **Critical**: Actively causing bugs or maintenance burden (fix now)
- **High**: Will cause problems at next scale point (fix this sprint)
- **Medium**: Code smell, worth fixing when touching the area
- **Low**: Aesthetic / best practice (fix opportunistically)

### Using the ledger
- **Planning phase**: Ledger items become subtask prerequisites or constraints
- **Ad-hoc**: Ledger items become bead issues for future work
- **Quality gate**: Critical/High items block merge (optional enforcement)
