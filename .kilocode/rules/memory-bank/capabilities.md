# Capabilities Registry

**Purpose:** "Matrix kung fu upload" - instant awareness of all agent capabilities

This registry enables rapid capability matching to tasks. When you see a task, scan this registry to identify which skill/workflow/MCP server to activate.

## Skills (Activation Heuristics)

- **beads-local-db-ops** → Use when: task tracking, issue management, `bd` commands, sync operations
- **context7-docs-ops** → Use when: integrating third-party libraries, need up-to-date documentation
- **github-cli-code-review** → Use when: PR review, addressing review comments, fetching PR context
- **repomap-claims-ops** → Use when: **experimental/out-of-scope in repomap-core** (claims pipeline, LLM orchestration)
- **repomap-codebase-retrieval** → Use when: semantic code search, architecture understanding, before editing
- **repomap-query-claims** → Use when: **experimental/out-of-scope in repomap-core** (claims DB/JSONL queries)
- **repomap-verify-architecture** → Use when: **experimental/out-of-scope in repomap-core** (layer-boundary verification workflows)
- **sequential-thinking-default** → Use when: multi-step debugging, complex decisions, ambiguous problems
- **sonarqube-ops** → Use when: quality gates, code issues, metrics, SonarQube integration

## Workflows (Trigger Conditions)

### Original Workflows (Monolithic)
- **/start-task** → Task preparation with discovery, exploration, and prep (single-agent flow)
- **/execute-task** → Task execution with implementation loop (single-agent flow)
- **/save-game** → Create context checkpoint for session transfer (before ending session, after milestones)
- **/load-game** → Load previous checkpoint to resume work (starting session, switching tasks)
- **/respond-to-pr-review** → Fetch PR context and address review comments (PR review response workflow)
- **/fix-ci** → Fix failing CI checks and quality gates (CI failures, quality gate issues)
- **/refactor** → Plan and execute refactoring with architecture awareness (code refactoring tasks)
- **/claims-pipeline** → Run full claims generation pipeline (claims work, evidence gathering)
- **/codebase-exploration** → Explore unfamiliar codebase systematically (new codebase, understanding structure)
- **/friction-audit** → Lightweight ergonomics and cognitive friction audit (single-agent flow)

### Orchestrator Modes (preferred)
- **process-orchestrator** → Control-plane orchestrator for isolated specialist subtasks. Lifecycle: discover → explore → prepare → execute → gate → land.
- **audit-orchestrator** → Adversarial audit orchestrator for pressure tests. Phases: Identity Attack → Friction Audit → Surface Minimization → Leverage Hunt → Synthesis.

**When to use Orchestrator modes:**
- Complex tasks with distinct phases
- Need hard separation of concerns (isolated subtask contexts)
- Want native progress tracking via todo list
- Long-running tasks requiring resumability
- Adversarial pressure testing (audit-orchestrator)

**When to use Original workflows:**
- Straightforward tasks
- Simpler single-agent flow preferred
- Manageable context size

### Thinker Modes (composable thinking styles)
- **thinker-abstract** → Generate competing problem frames. Contracts: `.kilocode/contracts/thinking/abstract_thinking.md`
- **thinker-adversarial** → Falsify plans, enumerate failure modes. Contracts: `.kilocode/contracts/thinking/adversarial_thinking.md`
- **thinker-systems** → Find feedback loops, bottlenecks, leverage. Contracts: `.kilocode/contracts/thinking/systems_thinking.md`
- **thinker-concrete** → Collapse ambiguity into executable steps. Contracts: `.kilocode/contracts/thinking/concrete_thinking.md`
- **thinker-epistemic** → Separate know/believe/guess, assign confidence. Contracts: `.kilocode/contracts/thinking/epistemic_thinking.md`

**When to use Thinker modes:**
- Spawned by orchestrators following a thinking plan (not invoked directly by users)
- Complex decisions requiring structured reasoning with enforceable quality constraints
- Composable: chain via thinking plans under `.kilocode/contracts/thinking/plans/`

**Thinking Plans (delegation recipes):**
- `design-subsystem.md` — Abstract → Systems → Adversarial → Concrete
- `debug-incident.md` — Concrete → Research → Adversarial → Concrete
- `evaluate-dependency.md` — Abstract → Systems → Adversarial → Concrete
- `strategic-decision.md` — Abstract → Epistemic → Adversarial → Concrete

## MCP Servers (Use Cases)

- **context7** (`mcp--context7--*`) → Library documentation lookup, up-to-date API references
- **augment-context-engine** (`mcp--augment-context-engine--*`) → Semantic codebase search, architecture understanding
- **sequentialthinking** (`mcp--sequentialthinking--*`) → Structured reasoning for complex problems, multi-step analysis
- **sonarqube** (`mcp--sonarqube--*`) → Code quality metrics, issue tracking, quality gate status

## Activation Pattern

1. **Read user task** → Identify task type
2. **Scan this registry** → Match task to capability
3. **Load skill/workflow** → Read full SKILL.md or workflow.md
4. **Execute** → Follow skill/workflow instructions
5. **Use MCP tools** → Call appropriate MCP server tools as needed

## References

- Skills directory: `.kilocode/skills/`
- Workflows directory: `.kilocode/workflows/`
- MCP configuration: `.kilocode/mcp.json`
- Mode definitions: `.kilocodemodes`
