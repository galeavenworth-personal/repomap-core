---
description: Factory operator runbook — start the stack, dispatch tasks to kilo agents, monitor sessions, and operate the repomap-core factory floor. Use this when asked to run the factory, dispatch work, or check stack health.
---

# Factory Operator Workflow

You are the **factory operator** for `repomap-core`. Your job is to start infrastructure,
dispatch work to kilo serve agents, monitor completion, and report results.

**Two repos exist:**
- `~/Projects/repomap-core` — your workspace (Windsurf/Cascade edits here)
- `~/Projects-Employee-1/repomap-core` — Employee-1's workspace (kilo serve agents work here)

The factory stack runs from the **Employee-1** directory. Your Windsurf workspace is for
code review, operational oversight, and direct code changes.

---

## 1. Prerequisites (one-time per machine)

```bash
# OAuth login for kilo serve (stores token in ~/.local/share/kilo/auth.json)
kilo auth login  # select "Kilo Gateway (recommended)", authorize in browser

# Install Temporal CLI
curl -sSf https://temporal.download/cli.sh | sh
# Result: ~/.temporalio/bin/temporal

# Install Dolt
# Result: ~/.local/bin/dolt

# Install daemon dependencies
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
# From Employee-1 repo — starts Dolt, oc-daemon, Temporal server, Temporal worker
cd ~/Projects-Employee-1/repomap-core
.kilocode/tools/start-stack.sh
```

This starts 4 components:
1. **Dolt SQL server** — port 3307, data at `~/.kilocode/dolt/plant/`
2. **oc-daemon** — SSE event stream → Dolt punch writer (log: /tmp/oc-daemon.log)
3. **Temporal dev server** — port 7233, UI at http://localhost:8233
4. **Temporal worker** — polls `agent-tasks` queue

### Step 2c: Verify health

```bash
# Check all components
.kilocode/tools/start-stack.sh --check

# Or manually:
curl -s http://127.0.0.1:4096/session | head -c 100   # kilo serve
mysql -h 127.0.0.1 -P 3307 -u root -e "SELECT 1"      # Dolt
pgrep -f "tsx.*src/index.ts"                            # oc-daemon
~/.temporalio/bin/temporal workflow list 2>/dev/null     # Temporal
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

# Custom poll interval
npx tsx src/temporal/dispatch.ts --poll 5000 --agent code "Fix the tests"
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

# Check if session is complete (look for step-finish with no running tools)
curl -s http://127.0.0.1:4096/session/<SESSION_ID>/message | \
  jq '[.[].parts[] | select(.type == "step-finish")] | length'
```

### Check daemon punch log

```bash
# Recent daemon output
tail -50 /tmp/oc-daemon.log

# Query punches for a session
mysql -h 127.0.0.1 -P 3307 -u root plant -e \
  "SELECT punch_type, punch_key, cost, tokens_input FROM punches WHERE task_id='<SESSION_ID>' ORDER BY observed_at"
```

### Temporal workflow status

```bash
# List recent workflows
~/.temporalio/bin/temporal workflow list --limit 5

# Get workflow detail
~/.temporalio/bin/temporal workflow show --workflow-id <WORKFLOW_ID>

# Or use the UI at http://localhost:8233
```

---

## 5. Stop the Stack

```bash
cd ~/Projects-Employee-1/repomap-core
.kilocode/tools/start-stack.sh --stop
```

This stops: oc-daemon, Temporal worker, Temporal server, Dolt server.
kilo serve must be stopped manually (Ctrl+C in its terminal).

---

## 6. Agent Roster

| Agent | Tier | Model | Role |
|---|---|---|---|
| plant-manager | 1 (strategic) | kilo/anthropic/claude-opus-4.6 | Epic dispatch, high-level decisions |
| process-orchestrator | 2 (tactical) | kilo/anthropic/claude-opus-4.6 | Task decomposition, child dispatch |
| audit-orchestrator | 2 | kilo/anthropic/claude-opus-4.6 | Quality audits |
| architect | specialist | kilo/anthropic/claude-opus-4.6 | Design, analysis |
| product-skeptic | specialist | kilo/anthropic/claude-opus-4.6 | Adversarial review |
| code | specialist | openai/gpt-5.3-codex | Implementation |
| code-simplifier | specialist | openai/gpt-5.3-codex | Refactoring |
| fitter | specialist | openai/gpt-5.3-codex | Gate fixes |
| pr-review | specialist | kilo/anthropic/claude-sonnet-4 | PR reviews |
| docs-specialist | specialist | kilo/anthropic/claude-sonnet-4 | Documentation |
| thinker-* | specialist | openai/gpt-5.2 | Various thinking roles |

**Three-tier delegation:** plant-manager (strategic) → process-orchestrator (tactical) → specialists.
Orchestrators must not use tools directly — they delegate to children.

---

## 7. Beads (Issue Tracking)

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

---

## 8. SonarQube Quality Gate

Use the MCP sonarqube tools to check quality:

- **Project key:** `galeavenworth-personal_repomap-core`
- Check gate status: `mcp3_get_project_quality_gate_status` with `projectKey` and optionally `pullRequest`
- Search issues: `mcp3_search_sonar_issues_in_projects` with `projects` and `pullRequestId`
- Get measures: `mcp3_get_component_measures` with `metricKeys` like `new_bugs`, `new_security_hotspots`, `coverage`
- Security hotspots must be **reviewed in the SonarQube web UI** (can't be fixed via code alone)

---

## 9. Common Operational Patterns

### Health check all agents
```bash
.kilocode/tools/factory_dispatch.sh -m plant-manager \
  .kilocode/prompts/attestation-health-check.json
```

### Restart a stuck component
```bash
# oc-daemon
pkill -f "tsx.*src/index.ts"
cd ~/Projects-Employee-1/repomap-core/daemon
KILO_HOST=127.0.0.1 KILO_PORT=4096 DOLT_PORT=3307 npx tsx src/index.ts > /tmp/oc-daemon.log 2>&1 &

# Temporal worker
pkill -f "tsx.*temporal/worker.ts"
cd ~/Projects-Employee-1/repomap-core/daemon
npx tsx src/temporal/worker.ts > /tmp/temporal-worker.log 2>&1 &
```

### Run tests before pushing
```bash
# TypeScript (daemon)
cd ~/Projects/repomap-core/daemon && npx vitest run

# Python (use Employee-1 venv since Projects/ has no venv)
~/Projects-Employee-1/repomap-core/.venv/bin/python -m pytest ~/Projects/repomap-core/tests/ -x -q --rootdir=~/Projects/repomap-core
```

---

## 10. Key Ports & Paths

| Service | Port | Log |
|---|---|---|
| kilo serve | 4096 | terminal foreground |
| Dolt SQL | 3307 | /tmp/dolt-server.log |
| oc-daemon | — | /tmp/oc-daemon.log |
| Temporal gRPC | 7233 | — |
| Temporal UI | 8233 | — |

| Path | Purpose |
|---|---|
| `~/.local/share/kilo/auth.json` | OAuth credentials for kilo serve |
| `~/.config/kilo/opencode.json` | Model routing config |
| `~/.kilocode/dolt/plant/` | Dolt data directory (punch cards) |
| `~/.dolt-data/beads/` | Dolt data directory (beads issue tracking) |
| `~/.temporalio/bin/temporal` | Temporal CLI |
| `/tmp/temporal-dev.db` | Temporal dev server SQLite storage |
