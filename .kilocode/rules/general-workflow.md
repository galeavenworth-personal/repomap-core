# Coding Agent Rules

Sequential thinking is a fundamental capability that significantly improves your effectiveness as an agent, especially for complex tasks. The `process_thought` tool enables structured, stage-based reasoning with epistemic metadata tracking that you should use liberally for non-trivial decisions.

Sequential thinking is your PRIMARY reasoning interface. You cannot keep complex reasoning internal - all multi-step analysis MUST be externalized through the sequential-thinking tool suite.

**CRITICAL: Branch Budget Protocol**
You have a Branch Budget of 2 for any non-trivial task. Unspent budget indicates insufficient exploration and is a protocol violation.

**MANDATORY Branching Triggers** (you MUST use sequential thinking when):
- Multiple implementation strategies exist (e.g., "refactor vs rewrite")
- Missing information requires assumptions (document each assumption as a branch)
- Task touches security, data integrity, or migrations
- Estimated effort > 3 steps
- User request is ambiguous (branch per interpretation)
- You're about to make an architectural decision
- Debugging issues where root cause isn't immediately obvious
- Planning changes that affect multiple components
- **Resuming work from a previous session** (import session first)

**Hard Gate:** You may NOT call edit_file/write_to_file/execute_command/attempt_completion tools until at least one `process_thought` call exists with stage="Conclusion".

## Tools

### process_thought

Records a thought with stage validation and epistemic metadata.

**Parameters**:
- `thought` (string, required): Your current reasoning step
- `thought_number` (integer, required): Current step number in sequence
- `total_thoughts` (integer, required): Estimated total thoughts needed (adjustable)
- `next_thought_needed` (boolean, required): True if more thinking needed
- `stage` (string, required): One of:
  - `"Problem Definition"` - What are we solving?
  - `"Research"` - What information do we need?
  - `"Analysis"` - What do the findings mean?
  - `"Synthesis"` - How do pieces fit together?
  - `"Conclusion"` - What's the decision/outcome?
- `tags` (list[str], optional): Keywords/categories (e.g., `["claims", "verification"]`)
- `axioms_used` (list[str], optional): Principles applied (e.g., `["Fail hard, not silently"]`)
- `assumptions_challenged` (list[str], optional): What you're questioning (e.g., `["Training data is current"]`)

**Returns**: Analysis including related thoughts, progress, stage information

### generate_summary

Retrieves complete overview of your thinking session.

**Parameters**: None

**Returns**: Summary with total thoughts, stage breakdown, timeline, top tags, completion status

**MANDATORY usage:**
- Before reaching Conclusion stage (verify you've explored sufficiently)
- Before calling `export_session` (ensure session is complete)
- When debugging why a decision feels wrong (review your reasoning)

### export_session

Saves the current thinking session to a file for future reference or resumption.

**Parameters**:
- `file_path` (string, required): Path to save the session (e.g., `.kilocode/thinking/task-123.json`)

**Returns**: Status message

**MANDATORY usage:**
- At end of every work session on complex tasks
- Before switching contexts (save current reasoning)
- After reaching major decision points (preserve rationale)
- When handing off work to future sessions

**File naming convention:** `.kilocode/thinking/{task-type}-{date}-{brief-description}.json`

### import_session

Loads a previous thinking session from a file to resume work.

**Parameters**:
- `file_path` (string, required): Path to the session file to load

**Returns**: Status message

**MANDATORY usage:**
- At start of any session resuming previous work
- When user references "continue where we left off"
- Before making decisions that build on prior reasoning
- When debugging why a previous decision was made

**Workflow:** `import_session` → review with `generate_summary` → continue with `process_thought`

## Enforcement Protocol

**Pre-Implementation Checklist** (verify before ANY edit/write/run tool):
- [ ] Have I externalized my reasoning through `process_thought`?
- [ ] Have I explored at least 2 approaches if multiple exist?
- [ ] Have I documented assumptions if information is missing?
- [ ] Have I reached Conclusion stage before editing code?
- [ ] Have I spent my branch budget (2 branches minimum)?
- [ ] Have I called `generate_summary` to verify completeness?

**Stage Progression Requirements:**
1. **Problem Definition** → State the problem in 2-3 thought branches
2. **Research** → For each interpretation, gather context
3. **Analysis** → Generate 2-3 approach candidates (simplest, safest, highest-leverage)
4. **Synthesis** → Compare approaches explicitly (call `generate_summary` here)
5. **Conclusion** → Commit to one approach with rationale

**Session Management Requirements:**
- **End of session:** Call `export_session` to save reasoning
- **Start of session:** Call `import_session` if resuming work
- **Before major decisions:** Call `generate_summary` to verify exploration

**Unspent branch budget = insufficient exploration = protocol violation.**

## Code Examples

### Example 1: Refactoring Decision (Complete Flow)
```python
# Approach A branch
process_thought(
    thought="Approach A: Extract to new module. Pros: clean separation. Cons: migration cost.",
    thought_number=1,
    total_thoughts=4,
    next_thought_needed=True,
    stage="Analysis",
    tags=["refactoring", "architecture"]
)

# Approach B branch
process_thought(
    thought="Approach B: Inline refactor. Pros: no migration. Cons: maintains coupling.",
    thought_number=2,
    total_thoughts=4,
    next_thought_needed=True,
    stage="Analysis",
    tags=["refactoring", "architecture"]
)

# Verify exploration before deciding
generate_summary()

# Decision with rationale
process_thought(
    thought="Choosing A: separation worth migration cost given future extensibility needs.",
    thought_number=3,
    total_thoughts=4,
    next_thought_needed=True,
    stage="Conclusion",
    axioms_used=["Favor explicit over implicit"]
)

# Final thought to save session
process_thought(
    thought="Ready to implement. Will extract module and update call sites.",
    thought_number=4,
    total_thoughts=4,
    next_thought_needed=False,
    stage="Conclusion",
    tags=["implementation-ready"]
)

# Save for future reference
export_session(file_path=".kilocode/thinking/refactor-module-x-2026-01-21.json")
```
### Example 2: Multi-Session Work (Resume Previous Reasoning)

```python
# Session 2 start: Load previous reasoning
import_session(file_path=".kilocode/thinking/refactor-module-x-2026-01-21.json")

# Review what was decided
generate_summary()

# Continue from where we left off
process_thought(
    thought="Implementation note: migration will require updating 12 call sites based on codebase search.",
    thought_number=4,
    total_thoughts=4,
    next_thought_needed=False,
    stage="Conclusion",
    tags=["refactoring", "implementation"]
)
```

### Example 3: Ambiguous Requirements
```python
# Branch per interpretation
process_thought(
    thought="Interpretation 1: User wants real-time updates (WebSocket approach)",
    thought_number=1,
    total_thoughts=3,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["requirements", "clarification"]
)

process_thought(
    thought="Interpretation 2: User wants periodic polling (simpler, good enough?)",
    thought_number=2,
    total_thoughts=3,
    next_thought_needed=True,
    stage="Problem Definition",
    tags=["requirements", "clarification"],
    assumptions_challenged=["Real-time is required"]
)

# Check if we've explored enough before asking user
generate_summary()

# Save before asking user (preserve our analysis)
export_session(file_path=".kilocode/thinking/realtime-requirements-2026-01-21.json")
```
