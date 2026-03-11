---
description: Factory operator runbook — start the stack, dispatch tasks to kilo agents, monitor sessions, query delegation analytics, run DSPy compilation, and operate the repomap-core factory floor. Use this when asked to run the factory, dispatch work, check stack health, or analyze performance.
---

# Factory Operator Workflow

You are the **factory operator** for `repomap-core`. Your job is to start infrastructure,
dispatch work to kilo serve agents, monitor completion, analyze delegation performance,
run the self-learning compilation loop, and report results.

**Two repos exist:**
- `~/Projects/repomap-core` — your workspace (Windsurf/Cascade edits, reviews, operations)
- `~/Projects-Employee-1/repomap-core` — Employee-1's workspace (kilo serve agents work here, stack runs here)

The factory stack runs from the **Employee-1** directory. Your Windsurf workspace is for
code review, operational oversight, and direct code changes.

**Python venv:** Only exists at `~/Projects-Employee-1/repomap-core/.venv/`. Use Employee-1's
venv for all Python execution, including running tests on Projects/ code.

---

## 1. Prerequisites (one-time per machine)

```bash
# OAuth login for kilo serve (stores token in ~/.local/share/kilo/auth.json)
kilo auth login  # select "Kilo Gateway (recommended)", authorize in browser
kilo auth login  # select "OpenAI" for openai/* models

# Install Temporal CLI
curl -sSf https://temporal.download/cli.sh | sh
# Result: ~/.temporalio/bin/temporal

# Install Dolt
# Result: ~/.local/bin/dolt

# Install daemon dependencies (includes pm2)
cd ~/Projects-Employee-1/repomap-core/daemon && npm install
```

---

## 2. Start the Stack

### Step 2a: Start kilo serve (manual, runs in foreground)

```bash
# In a separate terminal — kilo serve is NOT managed by start-stack.sh
kilo serve --port 4096
```

Kilo serve uses OAuth credentials from `~/.local/share/kilo/auth.json`.
No `KILO_API_KEY` env var needed. No `op run` wrapper needed.

### Step 2b: Start the rest of the stack

```bash
cd ~/Projects-Employee-1/repomap-core
.kilocode/tools/start-stack.sh
```

This starts 4 components (oc-daemon and Temporal worker managed by **pm2**):
1. **Dolt SQL server** — port 3307, data at `~/.kilocode/dolt/plant/`
2. **oc-daemon** — SSE event stream → Dolt punch writer (pm2, log: /tmp/oc-daemon.log)
3. **Temporal dev server** — port 7233, UI at http://localhost:8233
4. **Temporal worker** — polls `agent-tasks` queue (pm2, log: /tmp/temporal-worker.log)

### Step 2c: Verify health

```bash
# Check all 5 components in one command
.kilocode/tools/start-stack.sh --check
# Expected: "Stack is healthy. (5/5 components)"

# pm2 process status (oc-daemon + temporal-worker)
cd ~/Projects-Employee-1/repomap-core
npx --prefix daemon pm2 status
```

---

## 3. Dispatch a Task

### Via factory_dispatch.sh (recommended for most cases)

```bash
cd ~/Projects-Employee-1/repomap-core

# Dispatch to plant-manager (default)
.kilocode/tools/factory_dispatch.sh "Implement feature X per bead abc.1"

# Dispatch to specific agent
.kilocode/tools/factory_dispatch.sh -m architect "Design the caching subsystem"
.kilocode/tools/factory_dispatch.sh -m code "Fix the bug in parser.py"
.kilocode/tools/factory_dispatch.sh -m pr-review "Review PR #47"

# Fire and forget (no monitoring, returns session ID immediately)
.kilocode/tools/factory_dispatch.sh --no-monitor -m plant-manager "Run attestation"

# With JSON output
.kilocode/tools/factory_dispatch.sh --json -m plant-manager "Health check"

# Custom timeout and poll interval
.kilocode/tools/factory_dispatch.sh -w 1200 --poll 15 -m plant-manager "Big epic"
```

**Exit codes:** 0=success, 2=kilo down, 3=session create fail, 4=prompt fail, 5=timeout, 6=no response

### Via Temporal dispatch (for durable orchestration with retry)

```bash
cd ~/Projects-Employee-1/repomap-core/daemon

# Dispatch and wait for result
npx tsx src/temporal/dispatch.ts --agent plant-manager "Implement feature X"

# Fire and forget
npx tsx src/temporal/dispatch.ts --no-wait --agent plant-manager "Background work"
```

Temporal gives you: auto-retry on crashes, heartbeats, workflow history at http://localhost:8233.

---

## 4. Monitor a Running Session

### Check session status via kilo API

```bash
# List all sessions
curl -s http://127.0.0.1:4096/session | jq '.[] | {id, title, time}'

# Get messages for a specific session
curl -s http://127.0.0.1:4096/session/<SESSION_ID>/message | jq '.[].info.role'
```

### Query Dolt for punch telemetry

```bash
# Punches for a session
mysql -h 127.0.0.1 -P 3307 -u root punch_cards -e \
  "SELECT punch_type, punch_key, cost FROM punches WHERE task_id='<SESSION_ID>' ORDER BY observed_at"

# Checkpoint results
mysql -h 127.0.0.1 -P 3307 -u root punch_cards -e \
  "SELECT card_id, status, missing_punches FROM checkpoints WHERE task_id='<SESSION_ID>'"
```

### pm2 logs and Temporal UI

```bash
# Tail daemon logs
npx --prefix daemon pm2 logs

# Recent daemon output
tail -50 /tmp/oc-daemon.log

# Temporal UI
# http://localhost:8233
```

---

## 5. Delegation Analytics (Query Dolt)

The factory records all delegation and enforcement data in Dolt (`punch_cards` database).
Use these queries to analyze factory performance.

```sql
-- Delegation overview: who gets spawned
SELECT punch_key, COUNT(*) as spawns
FROM punches WHERE punch_type = 'child_spawn'
GROUP BY punch_key ORDER BY spawns DESC;

-- Child completion rate
SELECT
  (SELECT COUNT(*) FROM punches WHERE punch_type = 'child_spawn') as spawned,
  (SELECT COUNT(*) FROM punches WHERE punch_type = 'child_complete') as completed;

-- Checkpoint pass/fail by card
SELECT card_id, status, COUNT(*) as cnt
FROM checkpoints GROUP BY card_id, status ORDER BY card_id;

-- Failed checkpoints with reasons
SELECT task_id, card_id, missing_punches
FROM checkpoints WHERE status = 'fail' ORDER BY validated_at DESC;

-- Compiled prompts inventory
SELECT prompt_id, LENGTH(compiled_prompt) as chars, dspy_version
FROM compiled_prompts ORDER BY prompt_id;

-- Session telemetry summary
SELECT COUNT(*) as sessions,
  SUM(total_cost) as total_cost,
  SUM(tokens_in) as tokens_in,
  SUM(tokens_out) as tokens_out
FROM sessions;
```

Run via Python for richer analysis:
```bash
cd ~/Projects-Employee-1/repomap-core
.venv/bin/python -c "
import pymysql
conn = pymysql.connect(host='127.0.0.1', port=3307, user='root', database='punch_cards')
cur = conn.cursor(pymysql.cursors.DictCursor)
cur.execute('<SQL HERE>')
for r in cur.fetchall(): print(r)
conn.close()
"
```

---

## 6. Self-Learning Loop (DSPy Compilation)

The factory has a closed self-learning loop that improves agent prompts from telemetry:

```
Record (oc-daemon → punches) → Backfill (kilo-store.ts → sessions/tool_calls)
  → Extract (training_data.py → DSPy examples) → Compile (run_compilation.py → LM)
  → Inject (prompt-injection.ts → agent prompts at dispatch time)
  → Self-check (agents call check_punch_card.sh) → Validate (daemon checkpoints)
```

### Run compilation (generates 25 compiled prompts)

```bash
cd ~/Projects-Employee-1/repomap-core
op run --env-file .env.op -- .venv/bin/python -m optimization.run_compilation
```

- Uses OpenRouter `gpt-4o-mini` via `OPENROUTER_API_KEY` from 1Password
- 1Password item: `op://Private/repomap-dspy-openrouter-key/credential`
- Produces: 20 card-exit prompts + 5 fitter-dispatch prompts → written to Dolt `compiled_prompts` table
- Takes ~30 seconds, costs < $0.10
- Options: `--dry-run` (no Dolt write), `--lm <model>` (override LM)

### Verify prompt injection is using compiled prompts

```bash
cd ~/Projects-Employee-1/repomap-core/daemon
npx tsx -e "
import { resolveCardExitPrompt } from './src/optimization/prompt-injection.ts';
async function test() {
  for (const mode of ['code', 'plant-manager', 'architect', 'fitter']) {
    const r = await resolveCardExitPrompt(mode);
    console.log(mode + ': source=' + r.source + ' card=' + r.cardId);
  }
}
test();
"
# Expected: all modes return source=compiled
```

### What the loop improves

| Layer | Static (git) | Dynamic (Dolt via DSPy) |
|---|---|---|
| Structure | Workflow steps, punch card rules | — |
| Guardrails | Mode definitions, tool permissions | Card-exit conditions, recovery prompts |
| Quality | — | Few-shot examples, threshold tuning |

Static changes with intent (commits). Dynamic improves with data (compilation runs).

---

## 7. Stop the Stack

```bash
cd ~/Projects-Employee-1/repomap-core
.kilocode/tools/start-stack.sh --stop
```

This stops: oc-daemon (pm2), Temporal worker (pm2), Temporal server, Dolt server.
kilo serve must be stopped manually (Ctrl+C in its terminal).

---

## 8. Restart a Stuck Component

Components are managed by **pm2** (auto-restart with exponential backoff). Manual restart:

```bash
cd ~/Projects-Employee-1/repomap-core

# Restart individual pm2 processes
npx --prefix daemon pm2 restart oc-daemon
npx --prefix daemon pm2 restart temporal-worker

# Restart all pm2 processes
npx --prefix daemon pm2 restart all

# Full stack restart (nuclear option)
.kilocode/tools/start-stack.sh --stop
.kilocode/tools/start-stack.sh
```

**Important:** If kilo serve restarts, the oc-daemon SSE connection breaks. Re-run
`start-stack.sh` after a kilo serve restart to reconnect everything.

---

## 9. Agent Roster (15 modes)

### Complete Mode Table

| # | Slug | Name | Tier | Model | Punch Card |
|---|---|---|---|---|---|
| 1 | `plant-manager` | Plant Manager | 1 (strategic) | kilo/anthropic/claude-opus-4.6 | `plant-orchestrate` |
| 2 | `process-orchestrator` | Process Orchestrator | 2 (tactical) | kilo/anthropic/claude-opus-4.6 | `process-orchestrate` |
| 3 | `audit-orchestrator` | Audit Orchestrator | 2 (tactical) | kilo/anthropic/claude-opus-4.6 | `audit-orchestrate` |
| 4 | `architect` | Software Architect | specialist | kilo/anthropic/claude-opus-4.6 | `discover-phase` |
| 5 | `code` | Code Fabricator | specialist | openai/gpt-5.3-codex ($0) | `execute-subtask` |
| 6 | `code-simplifier` | Code Simplifier | specialist | openai/gpt-5.3-codex ($0) | `refactor` |
| 7 | `fitter` | Fitter (Line Health) | specialist | openai/gpt-5.3-codex ($0) | `fitter-line-health` |
| 8 | `pr-review` | PR Reviewer | specialist | kilo/anthropic/claude-sonnet-4 | `respond-to-pr-review` |
| 9 | `docs-specialist` | Documentation Specialist | specialist | kilo/anthropic/claude-sonnet-4 | `land-plane` |
| 10 | `product-skeptic` | Product Skeptic | specialist | kilo/anthropic/claude-opus-4.6 | `execute-subtask` |
| 11 | `thinker-abstract` | Thinker: Abstract (Map-Making) | specialist | openai/gpt-5.2 | `prepare-phase` |
| 12 | `thinker-adversarial` | Thinker: Adversarial (Red Team) | specialist | openai/gpt-5.2 | `prepare-phase` |
| 13 | `thinker-systems` | Thinker: Systems (Dynamics) | specialist | openai/gpt-5.2 | `prepare-phase` |
| 14 | `thinker-concrete` | Thinker: Concrete (Implementation) | specialist | openai/gpt-5.2 | `prepare-phase` |
| 15 | `thinker-epistemic` | Thinker: Epistemic (Hygiene) | specialist | openai/gpt-5.2 | `prepare-phase` |

### Dispatch Routing

**Three-tier delegation:** plant-manager → orchestrators → specialists.
Orchestrators delegate; they do not use implementation tools directly.

**process-orchestrator delegation model:**

Each phase = its own child session. Orchestrator spawns sequentially (child N
returns before child N+1). Minimum 4 children, typical 5-8.

| Phase | Mode | Sessions | Purpose |
|---|---|---|---|
| discover | `architect` | 1 | Fetch task details, scope, constraints |
| explore | `architect` | 1 | Gather codebase context, dependencies |
| prepare | `architect` or `thinker-*` | 1 | Produce subtask plan (tells orchestrator how many code sessions) |
| execute | `code` | N | One session per subtask from prepare plan, sequential |
| refactor | `code-simplifier` | N | One session per refactoring subtask (when prepare says so) |
| gate | (within code child) | — | Quality gates run inside each code/refactor child |
| land | (orchestrator) | — | Close beads, sync, report |
| line-fault | `fitter` | 1 | Timeout/stall/env recovery |
| docs | `docs-specialist` | 1 | Documentation updates |

**Key rule:** The prepare child returns a structured plan with `subtask_count` and
an ordered list of subtasks. The orchestrator loops over this plan and spawns one
code session per subtask, passing prior results to each subsequent child.

**audit-orchestrator phase routing:**

| Phase | Mode | Purpose |
|---|---|---|
| identity-attack | `product-skeptic` | Test identity claims under adversarial pressure |
| friction-audit | `product-skeptic` | Map cognitive friction and UX dead ends |
| surface-minimization | `product-skeptic` | Identify removable surface area |
| leverage-hunt | `architect` | Find highest-leverage improvement |
| synthesis | `architect` | Compile findings into recommendations |

**Prepare phase mode selection:**

Default: use `architect` for straightforward tasks that just need a subtask plan.
Use a thinker mode when the problem needs structured reasoning before planning.

| Mode | When to use |
|---|---|
| `architect` | **Default.** Task is clear, just needs a subtask breakdown |
| `thinker-abstract` | Problem type is unclear — generate competing frames first |
| `thinker-adversarial` | A plan exists — enumerate failure modes and risks |
| `thinker-systems` | Understanding dynamics — find feedback loops and bottlenecks |
| `thinker-concrete` | Ready to plan but need rigorous step decomposition with checks |
| `thinker-epistemic` | Uncertainty is high — separate know/believe/guess |

**Direct dispatch (not via orchestrator):**

| Mode | Dispatched by | When |
|---|---|---|
| `pr-review` | Cascade (you) or user | PR review requests |
| `plant-manager` | Cascade (you) or user | Epic/batch work |

**Model routing:**
- `kilo/*` prefix → Kilo Gateway (OAuth, prompt caching ~95% cost reduction on Anthropic)
- `openai/*` prefix → OpenAI ChatGPT (OAuth, $0 for ChatGPT sub models)

---

## 10. Beads (Issue Tracking)

```bash
cd ~/Projects/repomap-core  # or Employee-1

# Sync state from remote
.kilocode/tools/bd sync --no-push

# Find available work
.kilocode/tools/bd ready

# View issue details
.kilocode/tools/bd show <id>

# Claim work
.kilocode/tools/bd update <id> --status in_progress

# Complete work
.kilocode/tools/bd close <id>

# Push state to remote
.kilocode/tools/bd sync
```

Beads Dolt data lives at `~/.dolt-data/beads/` (database: `beads_repomap-core`).
This is separate from the punch card Dolt at `~/.kilocode/dolt/plant/`.

---

## 11. Quality Gates

### SonarQube (MCP)

- **Project key:** `galeavenworth-personal_repomap-core`
- Check gate status: `mcp3_get_project_quality_gate_status` with `projectKey`
- Search issues: `mcp3_search_sonar_issues_in_projects` with `projects` and `pullRequestId`
- Get measures: `mcp3_get_component_measures` with `metricKeys` like `coverage`, `new_bugs`
- Security hotspots must be **reviewed in the SonarQube web UI**

### Duplication gate (MANDATORY after any code change)

After every factory dispatch or manual code change that touches `daemon/` files,
verify duplication is under threshold **before** considering the work done:

```bash
# Check SonarQube duplication on the PR
mcp3_get_component_measures with:
  projectKey: "galeavenworth-personal_repomap-core"
  metricKeys: ["new_duplicated_lines_density", "new_duplicated_lines", "duplicated_blocks"]
  pullRequest: "<PR_NUMBER>"
```

**Thresholds:**
- `new_duplicated_lines_density` must be ≤ 3.0%
- If above threshold, identify the duplicated file(s) and extract shared helpers
- **Test files are the #1 source of duplication** — look for repeated mock setup,
  fixture construction, and assertion patterns that can be consolidated into helpers

**Common deduplication patterns:**
- Repeated mock activity setup → `setupScenario()` helper with options object
- Repeated state extraction → `runAndExtractState()` wrapper
- Repeated signal/query registration checks → `expectHandlerRegistered(...names)` helper
- Repeated fixture construction → parameterized factory functions

### Local tests

```bash
# TypeScript (daemon)
cd ~/Projects-Employee-1/repomap-core/daemon && npx vitest run

# Attestation E2E (requires full stack + KILO_LIVE=1)
cd ~/Projects-Employee-1/repomap-core/daemon && KILO_LIVE=1 npx vitest run tests/attestation-e2e.test.ts

# Python (use Employee-1 venv)
cd ~/Projects-Employee-1/repomap-core
.venv/bin/python -m pytest tests/ -x -q

# Python quality gates
.venv/bin/python -m ruff format --check .
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy src
```

### Attestation health check (all agents via factory dispatch)

```bash
cd ~/Projects-Employee-1/repomap-core
.kilocode/tools/factory_dispatch.sh -m plant-manager .kilocode/prompts/attestation-health-check.json
```

---

## 12. Key Ports & Paths

| Service | Port | Log |
|---|---|---|
| kilo serve | 4096 | terminal foreground |
| Dolt SQL (punch cards) | 3307 | /tmp/dolt-server.log |
| oc-daemon | — | /tmp/oc-daemon.log |
| Temporal gRPC | 7233 | — |
| Temporal UI | 8233 | — |

| Path | Purpose |
|---|---|
| `~/.local/share/kilo/auth.json` | OAuth credentials for kilo serve |
| `~/.config/kilo/opencode.json` | Model routing config |
| `~/.kilocode/dolt/plant/` | Dolt data (punch cards, sessions, compiled prompts) |
| `~/.dolt-data/beads/` | Dolt data (beads issue tracking) |
| `~/.temporalio/bin/temporal` | Temporal CLI |
| `/tmp/temporal-dev.db` | Temporal dev server SQLite storage |
| `.kilocode/tools/ecosystem.config.cjs` | pm2 app definitions for oc-daemon + temporal-worker |
| `.env.op` | 1Password secret references (OPENROUTER_API_KEY for DSPy) |

---

## 13. Dolt Data Model (punch_cards database)

| Table | Records | Purpose |
|---|---|---|
| punches | 4,667+ | Every tool call, gate pass, child spawn recorded by oc-daemon |
| sessions | 1,148+ | Session metadata (model, cost, tokens, timestamps) |
| messages | 7,510+ | Conversation messages |
| tool_calls | 10,041+ | Individual tool call records |
| checkpoints | 9+ | Punch card validation results (pass/fail + missing punches) |
| punch_cards | 118 (20 cards) | Card definitions (required/forbidden punch patterns) |
| compiled_prompts | 25 | DSPy-compiled card-exit (20) + fitter-dispatch (5) prompts |
