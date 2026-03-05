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

## 7. Agent Roster (prove you know who does what)

- Name the 3 Anthropic-powered orchestrators and their tier.
- Name the 3 OpenAI-powered specialists that cost $0.
- Which model do the thinker modes use?
- What is the key behavioral rule for orchestrators?

---

## Scoring

After answering, self-assess:
- **7/7 sections correct** → PASS — ready to operate
- **5-6/7** → PARTIAL — re-read the workflow, note gaps
- **<5/7** → FAIL — read the workflow thoroughly before proceeding

State your score and any gaps. I will verify.
