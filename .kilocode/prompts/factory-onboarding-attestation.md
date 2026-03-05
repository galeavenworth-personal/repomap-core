# Factory Operator Onboarding Attestation

You are Cascade, the factory operator for `repomap-core`. Before we begin work,
I need you to prove you understand the factory by answering the following.

**Read the workflow first:** `.windsurf/workflows/factory-operator.md`

Then answer each section. Be concise — bullet points, not paragraphs.

---

## 1. Architecture (prove you know the layout)

- What are the two repos and what is each one for?
- Where is the Python venv and why does that matter?
- What 5 components make up the stack? Which ones are managed by pm2?
- What port does each service run on?

## 2. Stack Operations (prove you can start/stop/check)

- What is the exact command to start the full stack (not kilo serve)?
- What is the exact command to verify all components are healthy?
- What happens if kilo serve restarts? What must you do?
- How do you restart just the oc-daemon without restarting everything?

## 3. Dispatch (prove you can send work to agents)

- What is the command to dispatch a task to the `code` agent?
- What is the command to fire-and-forget to `plant-manager`?
- What are the exit codes and what do they mean?
- What is the three-tier delegation model? Name the tiers.

## 4. Monitoring (prove you can observe the factory)

- How do you list all active sessions?
- How do you query punches for a specific session from Dolt?
- How do you check checkpoint pass/fail for a session?
- How do you tail the daemon logs?

## 5. Self-Learning Loop (prove you understand the feedback loop)

- Describe the 7 steps of the self-learning loop in order.
- What is the exact command to run DSPy compilation? What does it produce?
- What is the difference between static (git) and dynamic (Dolt) configuration?
- Why should workflows NOT be dynamically updated?

## 6. Quality & Issue Tracking (prove you know the process)

- What is the SonarQube project key?
- What are the commands to run Python quality gates?
- How do you sync, claim, and close a bead?
- What is the Dolt database name for beads vs punch cards?

## 7. Agent Roster — 15 Modes (prove you know who does what)

- List ALL 15 mode slugs, grouped by tier (1 strategic, 2 tactical, 12 specialist).
- For process-orchestrator: name the mode dispatched for each phase
  (discover, explore, prepare, execute, gate, refactor, land, line-fault, docs).
- For the prepare phase: which 5 thinker modes exist, and when do you pick each one?
- For audit-orchestrator: name the mode dispatched for each of its 5 phases.
- Which modes are dispatched directly (not via orchestrator)?
- What is the key behavioral rule for orchestrators?

## 8. Routing Correctness (prove you understand the delegation flow)

- The process-orchestrator's prepare phase routes to `thinker-*`. Why not `architect`?
  What is the default thinker mode for implementation tasks?
- When does process-orchestrator dispatch to `code-simplifier` instead of `code`?
- If you were dispatching a task where the problem type is unclear, which thinker
  mode would you use first? What would you follow it with?

---

## Scoring

After answering, self-assess:
- **8/8 sections correct** → PASS — ready to operate
- **6-7/8** → PARTIAL — re-read the workflow, note gaps
- **<6/8** → FAIL — read the workflow thoroughly before proceeding

State your score and any gaps. I will verify.
