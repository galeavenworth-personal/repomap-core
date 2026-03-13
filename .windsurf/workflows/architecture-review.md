---
description: Run an architecture review against the codebase or a target area. Detects parallel paths, build-or-buy candidates, interface discipline violations, SOLID principle issues, SDK-over-CLI opportunities, and canonical surface drift. Can be used during planning (before writing code) or ad-hoc (on existing code).
---

# Architecture Review Workflow

Run all six lenses below against the **target scope** (a directory, module, or
the full `daemon/src/` tree). Produce a structured **review ledger** as output.

The target scope is determined by context:
- **Planning phase**: the modules/files the upcoming task will touch
- **Ad-hoc**: a directory or the entire codebase (`daemon/src/`, `src/`, or both)

### Prerequisites: Repomap Artifacts

The Python layer (`src/`) has pre-computed repomap artifacts in `.repomap/`.
These provide structured, resolved data that is **far more precise than grep**
for dependency, call graph, and symbol analysis. Use them as the primary source
for the Python layer; fall back to grep for the TypeScript/daemon layer.

| Artifact | Format | Key Fields | Useful For |
|----------|--------|------------|------------|
| `deps.edgelist` | `src -> dst` per line | module dependency edges | Lens 1 (dep overlap), Lens 4 (DIP) |
| `deps_summary.json` | JSON | `fan_in`, `fan_out`, `cycles`, `layer_violations`, `top_modules` | Lens 1 (fan-in), Lens 2 (complexity), Lens 4 (SRP/DIP) |
| `calls.jsonl` | JSONL | `callee_expr`, `enclosing_symbol_id`, `resolved_to.qualified_name`, `module` | Lens 1 (parallel call targets) |
| `symbols.jsonl` | JSONL | `kind`, `qualified_name`, `path`, `layer`, `name` | Lens 1 (duplicate names), Lens 4 (SRP: symbols per module) |
| `refs.jsonl` | JSONL | `ref_kind`, `resolved_to`, `evidence.strategy` | Lens 3 (unresolved refs = broken contracts) |
| `modules.jsonl` | JSONL | `module`, `path`, `is_package` | Module enumeration |
| `integrations_static.jsonl` | JSONL | `tag`, `path`, `evidence` | Lens 5 (external integration points) |

To regenerate artifacts: `python -m cli generate .`

No query API exists yet — consume artifacts directly with `jq` or `read_file`.
The TypeScript layer (`daemon/src/`) is not covered by repomap; use grep there.

---

## Lens 1 — Parallel Path Elimination

**Goal**: Find duplicate or near-duplicate implementations that solve the same
problem in different places. Duplicates diverge over time and become
unmaintainable.

### Machine checks

1. **Duplicate function/symbol names across files** (TypeScript)
   ```bash
   grep -rn '^function \|^export function \|^async function \|^export async function ' \
     <scope> --include='*.ts' \
     | sed 's/(.*//' | awk -F: '{print $NF}' | sort | uniq -c | sort -rn | head -20
   ```
   Any function name appearing 2+ times across different files is a candidate.

2. **Duplicate symbol names across modules** (Python — via `symbols.jsonl`)
   ```bash
   jq -r 'select(.kind == "function") | .name' .repomap/symbols.jsonl \
     | sort | uniq -c | sort -rn | awk '$1 > 1'
   ```
   Cross-reference with `path` to find same-name functions in different modules.

3. **Repomap dependency overlap** (Python — via `deps.edgelist`)
   Parse `.repomap/deps.edgelist`. Two modules with >70% overlap in their
   dependency sets likely solve overlapping problems:
   ```bash
   # Build per-module dep sets from deps.edgelist, compute Jaccard similarity
   # Modules with Jaccard > 0.7 are candidates for merging
   ```

4. **Parallel call targets** (Python — via `calls.jsonl`)
   Find functions that call the same resolved targets:
   ```bash
   jq -r 'select(.resolved_to != null) | "\(.enclosing_symbol_id) -> \(.resolved_to.qualified_name)"' \
     .repomap/calls.jsonl | sort
   ```
   Two different enclosing symbols calling the same set of targets = likely
   parallel implementations.

5. **Fan-in analysis** (Python — via `deps_summary.json`)
   High fan-in modules are shared infrastructure. If two modules with similar
   fan-in/fan-out profiles exist, they may be solving the same problem:
   ```bash
   jq '.fan_in | to_entries | sort_by(-.value) | .[:15]' .repomap/deps_summary.json
   ```

6. **Shared utility patterns not extracted** (TypeScript)
   Search for common inline patterns that should be a shared utility:
   - `findRepoRoot`, `sleep`, `timestamp`, `checkPort` — if duplicated, extract
     to a shared module (e.g. `daemon/src/infra/utils.ts`).

7. **Codebase-retrieval semantic check**
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

3. **Fan-out as complexity signal** (Python — via `deps_summary.json`)
   Modules with high fan-out are doing too many things and may benefit from
   a library that encapsulates the concern:
   ```bash
   jq '.fan_out | to_entries | sort_by(-.value) | .[:10]' .repomap/deps_summary.json
   ```

4. **Dependency count** — modules with many internal dependencies that
   implement a well-known pattern (e.g., "durable workflow execution",
   "audit trail", "schema migration") should be evaluated against libraries.

5. **Library research** — for each candidate, use Context7 and web search to
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

1. **Unresolved references** (Python — via `refs.jsonl`)
   Refs where `resolved_to` is null indicate broken cross-boundary contracts:
   ```bash
   jq -r 'select(.resolved_to == null and .evidence.strategy != "dynamic_unresolvable") | "\(.module) -> \(.expr)"' \
     .repomap/refs.jsonl | sort | uniq -c | sort -rn | head -20
   ```
   Exclude `dynamic_unresolvable` (e.g., `dict.get`) which are expected.
   Remaining unresolved refs are interface discipline violations.

2. **Layer violations** (Python — via `deps_summary.json`)
   ```bash
   jq '.layer_violations' .repomap/deps_summary.json
   ```
   Any layer violation means a module is importing across an architectural
   boundary it shouldn't.

3. **Cross-boundary imports audit** (TypeScript)
   For the target scope, list all imports from other modules. For each:
   - Verify the imported identifier exists in the target module's exports
   - TypeScript compiler (`tsc --noEmit`) catches type-level violations
   - This lens focuses on **runtime identifiers**: config keys, database columns,
     API parameters, event names, CLI flags

4. **Env var / config key audit**
   ```bash
   grep -rn 'process\.env\.' <scope> --include='*.ts' | sort
   ```
   Each `process.env.X` must have a corresponding entry in `.env.example` or
   be documented in the config interface.

5. **Database column/table references**
   ```bash
   grep -rn "FROM \|INSERT INTO \|UPDATE \|SELECT " <scope> --include='*.ts'
   ```
   Each referenced table/column must exist in the schema (`.kilocode/tools/dolt_apply_punch_card_schema.sh` or migration files).

6. **CLI flag audit**
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

TypeScript:
```bash
# Count exports per module (high export count = likely SRP violation)
grep -rn 'export function\|export async function\|export class\|export interface\|export type' \
  <file> | wc -l
```

Python (via `symbols.jsonl` — count symbols per module):
```bash
jq -r '.path' .repomap/symbols.jsonl | sort | uniq -c | sort -rn | head -15
```

Python (via `deps_summary.json` — high fan-out = doing too much):
```bash
jq '.fan_out | to_entries | sort_by(-.value) | .[:10]' .repomap/deps_summary.json
```

- **Threshold**: >15 exports/symbols from a single file = flag for review
- **Also check**: LOC per file (>500 = review, >800 = strong signal)
- **Also check**: Fan-out >10 from deps_summary = strong signal
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

Python (via `deps.edgelist` + `symbols.jsonl` layer tags):
```bash
# Find edges from high-level layers to low-level layers
# Cross-reference with symbols.jsonl layer field and deps.edgelist
jq -r 'select(.layer != null) | "\(.path)\t\(.layer)"' .repomap/symbols.jsonl | sort -u
```
Then check `deps.edgelist` for edges from high-layer modules to low-layer ones.
Also check `deps_summary.json` `.layer_violations` (pre-computed).

TypeScript: import analysis to find high-level modules importing low-level
modules directly.
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

## Lens 5 — SDK-over-CLI Preference

**Goal**: Every `execFileSync`, `spawnSync`, or `spawn` call targeting a
third-party binary is a signal to research whether the vendor provides a
programmatic SDK. CLIs are loosely coupled (PATH trust, string arguments,
parsing stdout) — SDKs give type safety, structured errors, and no environment
risk.

Even after fixing shell injection (execSync → execFileSync), SonarQube will
still flag PATH trust issues. The *real* fix is often: use the vendor's SDK.

### Machine checks

1. **Inventory all subprocess calls** (TypeScript)
   ```bash
   grep -rn 'execFileSync\|spawnSync\|spawn(' <scope> --include='*.ts' \
     | grep -v '\.test\.' | grep -v node_modules
   ```

   Python (via `integrations_static.jsonl`):
   ```bash
   jq -r 'select(.tag == "subprocess" or .tag == "os_exec") | "\(.path):\(.line) \(.evidence)"' \
     .repomap/integrations_static.jsonl
   ```

2. **Classify each binary**
   For each unique binary invoked, ask:
   - Does the vendor provide a Node.js/Python SDK?
   - Is the SDK well-maintained (weekly downloads, recent releases, types)?
   - Does the SDK cover the specific operations we're calling?
   - Is the CLI the vendor's *documented* integration path (some vendors
     explicitly recommend CLI over SDK for certain operations)?

3. **Decision tree per binary**
   - **SDK exists + covers our use case** → **STRONG signal**: migrate to SDK
   - **SDK exists but CLI is vendor-recommended path** → **WEAK signal**: keep
     CLI, mitigate with absolute paths
   - **No SDK exists** → CLI is correct; mitigate with absolute paths where
     possible, or track PIDs for process management
   - **Our own tool** → CLI is the only path (until we build an SDK)

4. **Research via Context7**
   For each STRONG signal, use `resolve-library-id` + `query-docs` to verify:
   - Exact API methods that replace our CLI calls
   - Type definitions available
   - Any gotchas (e.g., async-only API replacing sync CLI calls)

### Signal classification
- **STRONG**: Vendor SDK exists, is well-maintained, covers our exact use case,
  and provides type-safe structured output. Migration eliminates PATH trust,
  stdout parsing, and environment coupling.
- **MODERATE**: SDK exists but is overkill for trivial operations (e.g.,
  `simple-git` for a single `git rev-parse`), or SDK is async-only replacing
  sync call sites that would require refactoring.
- **WEAK**: CLI is vendor's documented happy path, or SDK is unmaintained.
- **NONE**: No SDK exists, or binary is an OS utility / our own tool.

### Output per finding
```
| ID | Binary | Call Sites | SDK | Signal | Recommendation |
|----|--------|-----------|-----|--------|----------------|
| SC-1 | pm2 | 6 calls (start/stop/delete/list) | pm2 programmatic API | STRONG | Migrate |
| SC-2 | gh | 2 call sites | @octokit/rest | STRONG | Migrate |
| SC-3 | git | 4 calls (rev-parse, branch) | simple-git | MODERATE | Keep CLI for trivial ops |
```

### Resolution
- For STRONG signals: add SDK as dependency, replace CLI calls, remove binary
  resolution logic
- For MODERATE signals: document the decision (why CLI was kept) in a code
  comment at the call site
- For NONE: mitigate with absolute paths where possible
  (`/usr/bin/which` not `which`)

---

## Lens 6 — Canonical Surface

**Goal**: Every logical resource in the project (database, service, config key,
path, URL pattern) must have **exactly one canonical name** that all code and
documentation consistently reference. When multiple names refer to the same
thing, agents pick up stale or incorrect names from docs, comments, or older
code paths, then propagate those names into new code — creating silent drift
that compounds over time.

This is the root cause behind the Dolt database proliferation (three DB names
for what should have been one), and more generally any situation where an agent
could read a doc, a rule file, a code comment, or a constant definition and get
a *different* name for the same logical thing.

### Why this matters for agent-driven development

Agents treat **all text as ground truth**. A stale doc saying
`DOLT_DATABASE=punch_cards` is indistinguishable from a correct doc saying
`DOLT_DATABASE=factory`. The agent follows whatever it reads first. Unlike
human developers who carry ambient context ("oh, we renamed that"), agents
have no such memory across sessions. Every name divergence is a potential
bug injection.

### Machine checks

1. **Resource name inventory** — enumerate all logical resources and their names
   ```bash
   # Database names
   grep -rn 'DOLT_DATABASE\|dolt_database\|database:' <scope> \
     --include='*.ts' --include='*.py' --include='*.sh' --include='*.md' --include='*.yaml' \
     | grep -v node_modules | grep -v .git
   ```
   Group by logical resource. If the same resource appears under 2+ names,
   that's a finding.

2. **Constant vs. string literal divergence**
   ```bash
   # Find hardcoded string literals that should reference a constant
   grep -rn '"punch_cards"\|"plant"\|"factory"\|"beads_repomap-core"' <scope> \
     --include='*.ts' | grep -v node_modules
   ```
   Every hardcoded resource name that has a corresponding constant but doesn't
   use it is a canonical surface violation.

3. **Doc/code name mismatch**
   For each canonical resource name in code (constants, config defaults),
   search docs for references to the *old* name:
   ```bash
   # Example: if canonical DB name is 'factory', find stale references
   grep -rn 'punch_cards\|plant_db' docs/ .kilocode/rules/ .windsurf/ \
     --include='*.md' | grep -v 'historical\|archive\|CHANGELOG'
   ```
   Exclude explicitly-historical documents. Everything else should use the
   canonical name.

4. **Rule file audit** — `.kilocode/rules/` files are injected into agent
   context. Any stale name here has **direct causal impact** on agent behavior:
   ```bash
   grep -rn 'database\|DOLT_\|DB_' .kilocode/rules/ --include='*.md'
   ```
   Every resource reference in a rule file must match the canonical name.

5. **Workflow file audit** — `.windsurf/workflows/` files define agent
   procedures. Same rule:
   ```bash
   grep -rn 'database\|DOLT_\|DB_' .windsurf/workflows/ --include='*.md'
   ```

6. **Environment variable canonicalization**
   ```bash
   grep -rn 'process\.env\.' <scope> --include='*.ts' | \
     sed 's/.*process\.env\.\([A-Z_]*\).*/\1/' | sort -u
   ```
   Each env var must appear in `.env.example` with the canonical value.
   If code reads `process.env.DOLT_DATABASE` but `.env.example` says
   `DOLT_DATABASE=punch_cards`, that's a finding.

7. **Import path consistency** — modules that re-export the same symbol
   under different names create aliasing:
   ```bash
   grep -rn 'export.*as ' <scope> --include='*.ts' | grep -v node_modules
   ```

### Signal classification
- **Critical**: Rule file or workflow references a stale name (agents will
  read this and act on it — direct bug injection vector)
- **High**: Code constant and code usage disagree (silent runtime bug)
- **Medium**: Doc references a stale name (confuses human readers, may
  confuse agents if doc is in retrieval scope)
- **Low**: Comment or historical doc uses old name (minimal impact)

### Output per finding
```
| ID | Resource | Canonical Name | Stale Name | Location | Severity | Action |
|----|----------|---------------|------------|----------|----------|--------|
| CS-1 | Dolt DB | factory | punch_cards | .kilocode/rules/dolt-server.md:20 | Critical | Update to canonical |
| CS-2 | Dolt DB | factory | plant | daemon/src/index.ts:26 | High | Replace with constant |
```

### Resolution
1. **Define the canonical name** — add it as a constant or config default
   in one authoritative location
2. **Update all code references** — replace hardcoded strings with the constant
3. **Update all doc references** — rule files first (highest agent impact),
   then workflows, then general docs
4. **Add a lint check or grep-based CI gate** to prevent reintroduction
   of stale names (optional but recommended)

### Relationship to other lenses
- **Lens 1 (Parallel Paths)** finds duplicate *implementations*; this lens
  finds duplicate *names* for the same resource
- **Lens 3 (Interface Discipline)** ensures identifiers are grounded; this
  lens ensures they're *consistent* across code and docs
- **Lens 5 (SDK-over-CLI)** eliminates PATH trust; this lens eliminates
  *name* trust — both reduce environment coupling

---

## Producing the Review Ledger

After running all six lenses, compile findings into a single ledger:

```markdown
# Architecture Review Ledger — <scope> — <date>

## Summary
- Parallel Paths: N findings
- Build-or-Buy: N findings  
- Interface Discipline: N findings
- SOLID: N findings
- SDK-over-CLI: N findings
- Canonical Surface: N findings

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
