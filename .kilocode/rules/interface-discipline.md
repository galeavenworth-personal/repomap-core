# Interface Discipline

## The Rule

Every identifier consumed across a boundary — SDK method, database column, API
parameter, config key, event name, CLI flag — must be grounded in a citable
source before it appears in code. "Close enough" is fully wrong.

This rule applies to **all agents** and to **Cascade** itself.

## Why This Exists

The most expensive class of agent bug is the **near-miss**: code that looks
correct but fails at runtime because an identifier was guessed from convention
rather than verified from source. Examples:

- `foo.createdAt` when the SDK uses `foo.created`
- `user_id` when the column is `userId`
- `onComplete` when the event is `on_complete`

These bugs compile, pass cursory review, and waste real money when they hit
production or CI. They are fully preventable.

## What Counts as a Citable Source

| Source Type | Example | Tool |
|-------------|---------|------|
| Library documentation | Temporal SDK, GitHub API, Dolt SQL reference | Context7 (`resolve library` → `query docs`) |
| Source code definition | Class/function/type definition in this repo | `codebase-retrieval`, `read_file`, `grep` |
| Database schema | Column names, types, constraints | `read_file` on schema/migration files, or live `DESCRIBE` |
| API specification | OpenAPI spec, GraphQL schema, JSON-RPC definition | `read_file`, `read_url_content` |
| CLI help output | `--help` flag output showing exact flag names | `run_command` |
| GitHub API docs | Event payload shapes, webhook fields | Context7 or `read_url_content` |

**What does NOT count:** Memory, training data, convention, "it's usually called X",
prior session context without re-verification.

## How It Works in the Factory

### Explore Phase (Producer)

The explore-phase agent is responsible for producing an **Interface Appendix**
as part of its structured output. This appendix catalogs every external interface
the task will touch, with citations.

The appendix is not optional busywork. It is the mechanism by which downstream
agents avoid near-miss bugs. The explore agent has the tools and the mandate to
look things up; the code agent should not have to re-derive this.

### Prepare Phase (Forwarder)

The prepare-phase agent receives the Interface Appendix and must include it
verbatim in the handoff packet for each execute subtask. The prepare agent does
not need to re-verify (trust upstream), but must not drop or summarize the
appendix.

### Execute Phase (Consumer)

The execute-subtask agent receives the Interface Appendix in its handoff and
**must use the cited identifiers exactly as written**. If the appendix doesn't
cover an interface the agent needs, the agent must look it up itself using the
same sourcing rules before writing code.

### Cascade (Always)

When I (Cascade) write or review code that touches any cross-boundary identifier,
I verify the exact name, shape, and type from an authoritative source before
using it. I cite the source when the identifier is non-obvious.

## Interface Appendix Format

```markdown
### Interface Appendix

| Identifier | Actual Value | Source | Citation |
|------------|-------------|--------|----------|
| Temporal workflow status field | `status` (not `state`) | Temporal SDK docs | Context7: /temporalio/sdk-typescript query "workflow execution status" |
| Dolt punch_cards column | `card_name` (not `cardName`) | Schema file | `.kilocode/tools/schema.sql:42` |
| GitHub PR review event | `pull_request_review` (not `pr_review`) | GitHub API docs | https://docs.github.com/webhooks/webhook-events-and-payloads#pull_request_review |
| ... | ... | ... | ... |
```

Each row must have all four columns filled. Empty citations are a protocol violation.

## Scope

This rule is proportional. Not every task touches cross-boundary identifiers.
When the task is purely internal refactoring with no external interfaces, the
Interface Appendix may be empty or omitted. The obligation is to **check**, not
to manufacture ceremony.

The agents most likely to produce appendix entries are those working with:
- SDK/library integrations (Temporal, GitHub, Dolt, etc.)
- Database schemas (column names, types)
- External APIs (webhooks, REST, GraphQL)
- CLI tools (flag names, subcommand spelling)
- Cross-module interfaces within this repo (function signatures, type shapes)

## Enforcement

This is a soft discipline, not a punch card gate. The goal is cultural: agents
that build the habit of looking things up before writing code produce fewer
runtime bugs. Over time, DSPy compilation will reinforce this behavior as
sessions with interface appendices correlate with fewer gate failures.
