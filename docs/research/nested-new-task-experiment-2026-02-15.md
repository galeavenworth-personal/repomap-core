# Nested `new_task` Experiment Results

**Date:** 2026-02-15
**Branch:** `repomap-core-2b9`
**Total cost:** ~$0.25 for 3-level nesting test

## Experiment Design

```
Parent (process-orchestrator, claude-opus-4.6)
  └─ Level-1 subtask (process-orchestrator, claude-opus-4.6)
       └─ Level-2 subtask (ask, gpt-5.2)
```

Parent spawned Level-1 via `new_task(mode="process-orchestrator")`.
Level-1 spawned Level-2 via `new_task(mode="ask")`.
Both returned structured reports via `attempt_completion`.

## Key Findings

### 1. Nesting Works ✅

`new_task` from within a subtask successfully spawns a grandchild subtask.
The grandchild completes and its `attempt_completion` result flows back to
the child, which then returns its own result to the parent. **Arbitrary
nesting depth appears supported.**

### 2. Context Isolation is Strong ✅

Each nesting level sees **only its own task message** — no parent
conversation history leaks through. This means:

- Level-1 saw only the message the parent passed in `new_task.message`
- Level-2 saw only the message Level-1 passed in its `new_task.message`
- No cross-contamination of prior turns

### 3. Todo/Reminders Propagate via Parameter ✅

The `todos` parameter in `new_task` becomes the child's reminders table.
This is the primary structured-data channel from parent → child at spawn
time.

### 4. Environment Details Are Shared ✅

All levels see the same workspace file tree, git status, VSCode open tabs,
and current time. This is injected by the platform, not inherited from parent
context.

### 5. Full Tool Access at All Levels ✅

Level-2 (ask mode) reported access to:
- All core workspace tools (read/write/search/list files, browser, execute_command)
- All 4 MCP servers (Context7, Sequential Thinking, SonarQube, Augment)
- `new_task` itself (could theoretically spawn Level-3+)

### 6. Model Routing Differs by Mode ✅

| Level | Mode | Model |
|-------|------|-------|
| Parent | process-orchestrator | anthropic/claude-opus-4.6 |
| Level-1 | process-orchestrator | anthropic/claude-opus-4.6 |
| Level-2 | ask | openai/gpt-5.2 |

Mode determines model. This is powerful for cost optimization — delegate
expensive reasoning to opus, cheap lookups to lighter models.

### 7. Return Value is Plain Text

`attempt_completion` returns a plain text `result` string. There is no
structured JSON envelope — the child must format its output as text, and
the parent must parse it. The full result string is visible in the parent's
next turn.

## Implications for Orchestration

### What This Enables

1. **Multi-level delegation:** An orchestrator can spawn a sub-orchestrator
   that itself delegates to specialists.
2. **Cost-tiered execution:** Route work to the cheapest capable model via
   mode selection.
3. **Context firewall:** Subtasks cannot see parent history, preventing
   context pollution in long sessions.
4. **Recursive decomposition:** Complex tasks can be recursively broken down
   with each level having clean context.

### Limitations Observed

1. **No structured return:** Only plain text comes back. Parent must parse.
2. **No streaming:** Parent blocks until child completes entirely.
3. **No shared state:** Children cannot read parent's todo list or prior
   decisions unless explicitly passed in the message.
4. **Cost adds up:** Each nesting level consumes its own context window
   from scratch (system prompt + rules + environment details).
5. **Todo parameter is the only structured input channel** beyond the
   message string.

### Recommendations

- Use `todos` parameter to pass structured checklists to children
- Use the `message` parameter to pass compact handoff packets (JSON or
  markdown) with all context the child needs
- Ask children to return results in a parseable format (markdown with
  known headers, or fenced JSON blocks)
- Limit nesting to 2 levels (parent → child → grandchild) to control cost
- Prefer mode selection strategically for model routing
