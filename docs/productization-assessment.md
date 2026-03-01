# Productization Assessment

**Date:** 2026-03-01  
**Scope:** Both halves — the jig (repomap-core) and the factory (dark factory orchestration)  
**Context:** MIT-licensed codebase; question is whether a commercial product can be built cheaply and quickly

---

## Overall Opinion

This is a technically strong project with a genuinely differentiated core idea: **determinism as a contract**. Most code-intelligence tools optimize for coverage or recall. This one optimizes for reproducibility — same inputs produce byte-identical outputs, always. That's a meaningful moat in a world where LLM-adjacent tooling is almost universally nondeterministic.

The architecture is clean. The layer separation (interface → verification → foundation), the strict config model, the tree-sitter parsing layer — these are not over-engineered. They reflect someone who has thought carefully about what should and shouldn't couple.

The factory side — tiered agents, punch cards, bounded sessions, cost caps — is more unusual. It is genuinely novel as an engineering practice. Whether it is a product depends on who you are selling to.

**Can you productize this cheaply and easily?** Yes for the jig. No-but-maybe for the factory. Details below.

---

## The Jig (repomap-core) — Productizable Now

### What It Is

A CLI + Python library that scans a codebase and produces:
- `symbols.jsonl` — function/class/method catalog with locations
- `deps.edgelist` — module dependency graph
- Additional integration and layer summaries

Key properties: deterministic, text-native, diff-friendly, agent-consumable.

### Why It's Ready to Productize

1. **The problem is real and unsolved at this quality level.** Language servers (LSP) require running a language runtime. GitHub code search is not deterministic or exportable. Sourcegraph is expensive. ctags is primitive. repomap-core hits a gap: lightweight, deterministic, structured, and designed from the start for LLM agent consumption rather than human IDE use.

2. **The packaging is already mostly done.** It ships as a proper Python package (`pyproject.toml`, `hatchling`, entry point `repomap`). It has a clean CLI. It has tests and a verify step. The hard work of making this shippable is substantially complete.

3. **Tree-sitter is a durable foundation.** It handles Python today; adding TypeScript, Go, Rust, Java is a matter of adding grammar packages. The architecture doesn't need to change.

4. **The determinism guarantee is a product differentiator, not just an engineering preference.** CI systems, caching layers, and audit workflows can rely on byte-identical outputs in a way they cannot rely on any LLM-generated summary. That's a specific value proposition you can charge for.

### Cheapest Path to a Product

**Tier 1 — Free / brand-building (cost: near zero)**  
Publish a GitHub Action: `uses: your-org/repomap-action@v1`. On push, regenerate `.repomap/` and commit or upload as an artifact. This gets repomap into real repos with no sales effort. It also generates a natural conversion funnel.

**Tier 2 — Hosted API (cost: one small server)**  
Accept a git URL or a tarball, return the `.repomap/` artifact bundle as a zip. Charge per scan or per GB. Infrastructure is a single stateless Python service behind an HTTP endpoint — no database, no queue, no state. Can run on a $20/month VPS or as a Lambda function.

**Tier 3 — Enterprise (cost: non-trivial but fundable)**  
Private deployment (on-prem or VPC), multi-language support, incremental indexing, SSO, SLA. This is where the real revenue is, but it requires sales effort. Don't start here.

### MIT License Is Not a Problem

The open-core model works: keep the core library MIT (repomap-core), build proprietary value in the hosted service (rate limiting, private repos, multi-language, audit APIs). This is exactly what HashiCorp, Elastic, and MongoDB did before they went further. You do not need to change the license to monetize.

What you would protect as proprietary:
- The hosted indexing API and its SLA
- Incremental indexing / diff-based updates (not in the repo today)
- Cross-repo symbol resolution
- The integration with specific LLM platforms (custom context injectors, plugin formats)

---

## The Factory (dark factory) — Harder, But Real Enterprise Value

### What It Is

A multi-tier agent orchestration system:
- **Plant Manager (Tier 1):** strategic dispatcher, never implements directly
- **Process Orchestrator (Tier 2):** tactical, runs prep phases, dispatches children
- **Specialists (Tier 3):** architect, code, fitter — do the actual work

Enforced by:
- **Punch cards:** per-session ledger of required/forbidden tool calls, verified at exit
- **Bounded sessions:** hard cost cap (~$1/session), kills runaway agents
- **Quality gates:** ruff, mypy, pytest as hard blockers (not suggestions)
- **Dolt:** versioned SQL audit trail of every punch and checkpoint
- **Beads:** issue tracking with sync-branch lifecycle

### Why It's Harder to Productize

The factory is deeply entangled with specific tooling choices (Kilo/OpenCode, a specific SSE event stream API, Beads, Dolt). It is not currently extractable as a standalone product — it is a methodology embedded in infrastructure choices. You would need to:

1. Abstract the orchestration layer away from the specific AI client (Kilo/OpenCode)
2. Replace Dolt with a more deployable audit backend (Postgres, SQLite)
3. Provide a clean SDK for writing punch card schemas
4. Document the delegation patterns as something a user configures, not something hardcoded in AGENTS.md

That is not trivial. It is probably 2–4 months of focused engineering to extract.

### Why It's Worth Extracting

The enterprise AI agent market has a governance problem. Everyone is shipping agents; nobody has a credible answer to "how do you know what your agent did, why, and at what cost?" Punch cards + bounded sessions + Dolt is a direct answer to that question. That's a compliance/audit story, and enterprises pay for compliance.

Competitors in this space (LangSmith, Helicone, Weave) focus on observability after the fact. The factory's model is enforcement before the fact — you cannot complete a session without a valid punch card. That is a meaningfully different position.

### Factory Productization Path

**If you want to go this route:**

1. **Extract the punch card schema and verification logic** into a standalone Python library (`punchcard-py` or similar). This is the minimum sellable unit.

2. **Build a dashboard** (can be extremely simple — a read view of the Dolt audit trail) that shows per-session cost, delegation depth, gate pass/fail history. This makes the value visible to a non-technical buyer.

3. **Sell it as a governance layer for AI agent workflows**, not as a "build agents" platform. The "build" story is crowded. The "govern and audit" story is empty.

4. **Target regulated industries first.** Financial services, healthcare, legal tech — anywhere that already buys compliance tooling and is now scared about what their AI agents are doing. The bounded session + audit trail story lands immediately in those contexts.

---

## Summary Table

| Dimension | Jig (repomap) | Factory (dark factory) |
|-----------|--------------|------------------------|
| Productizable today? | Yes | No — needs extraction |
| Time to first product | 2–4 weeks (GitHub Action + API) | 2–4 months minimum |
| Infrastructure cost | Near zero (stateless API) | Medium (Dolt, dashboard) |
| Target buyer | Developer tooling / AI platform teams | Enterprise AI governance |
| Revenue model | API usage, enterprise plan | SaaS subscription, compliance tier |
| MIT license impact | None — open-core model works | None — same applies |
| Biggest risk | Language coverage (Python-only today) | Extraction complexity |
| Biggest asset | Determinism guarantee | Punch card enforcement model |

---

## Recommendation

**Start with the jig.** The GitHub Action costs nothing to ship and validates whether developers actually want the artifact format. If it gets adoption, the hosted API is a natural second step. The language coverage gap (Python-only) is the largest product risk — address TypeScript next, since that's where most agent-facing code lives.

**Park the factory.** The factory is a better product story than the jig — the governance angle is more fundable in 2026 than another code indexing tool. But it requires engineering work to extract. Let the jig generate revenue and signal, then invest that back into extracting and packaging the factory.

The combination — deterministic code intelligence + governed agent execution — is a coherent platform story if you ever want to raise money. Neither half needs to be abandoned; they just have different timelines.
