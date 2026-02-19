# Thinking Handoff Packet

## Purpose

Universal output format for all thinker modes. Every thinker mode MUST produce this structured handoff as its `attempt_completion` result. This enables composable thinking plans where the output of one thinker feeds the input of the next.

## Required Fields

### Frame (1 sentence)

The chosen problem frame or lens. What kind of thing is this?

### Decision / Position

The conclusion, recommendation, or stance. What did the thinking produce?

### Evidence Used

Bullet list of concrete evidence that informed the decision:
- File paths read
- Facts discovered
- Metrics or measurements
- Prior thinking session summaries

### Assumptions

Two sub-lists:

- **Held assumptions** — what we're treating as true without proof
- **Challenged assumptions** — what we questioned and what we found

### Risks + Mitigations

Each risk as a bullet with:
- Risk description
- Likelihood (high/medium/low)
- Impact (high/medium/low)
- Mitigation or detection method

### Next Actions

Checklist of concrete next steps. Each action should be:
- Specific enough to assign
- Verifiable (how do you know it's done?)

### Stop Condition

What evidence or circumstance would make us reverse course? This forces epistemic humility — every decision should have a named kill switch.

## Markdown Template

```markdown
## Thinking Handoff

**Frame:** [1-sentence problem frame]

**Decision:** [The conclusion or recommendation]

### Evidence Used
- [evidence item 1]
- [evidence item 2]

### Assumptions
**Held:**
- [assumption treated as true]

**Challenged:**
- [assumption questioned] → [what we found]

### Risks
- **[risk]** — likelihood: [H/M/L], impact: [H/M/L], mitigation: [action]

### Next Actions
- [ ] [specific action 1]
- [ ] [specific action 2]

### Stop Condition
[What would make us reverse this decision]

### Session Export
path: [.kilocode/thinking/session-file.json]
```

## Integration with Thinker Modes

Each thinker mode produces style-specific outputs AND this universal handoff. The style-specific outputs provide the analytical substance; the handoff provides the composable interface.

When chaining thinker modes in a thinking plan:
1. Thinker A produces handoff packet
2. Orchestrator reads handoff, constructs next thinker's input
3. Thinker B receives prior handoff as context
4. Process repeats until plan is complete

## Parsing Convention

The parent/orchestrator extracts fields by markdown header matching:
- `**Frame:**` — single line after marker
- `**Decision:**` — single line after marker
- `### Evidence Used` — bullet list until next header
- `### Assumptions` — two sub-sections
- `### Risks` — bullet list until next header
- `### Next Actions` — checklist until next header
- `### Stop Condition` — text until next header
- `### Session Export` — path field
