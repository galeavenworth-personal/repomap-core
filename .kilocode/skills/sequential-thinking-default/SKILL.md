---
name: sequential-thinking-default
description: Use structured sequential thinking for multi-step debugging, architecture decisions, or ambiguous problem framing.
---

# Structured Sequential Thinking

## When to use this skill

Use this skill when you need to:

- Debug failures where the root cause isn't obvious
- Compare multiple valid implementation approaches
- Plan multi-file changes without missing consumers
- Make architectural decisions with competing tradeoffs
- Explore solution spaces before committing to implementation

## Default behavior

1. **Start with Problem Definition stage**: Clarify what you're solving
2. **Progress through stages**: Research → Analysis → Synthesis → Conclusion
3. **Use epistemic metadata**: Track tags, axioms, assumptions challenged
4. **Generate summary before final decision**: Review your reasoning with `generate_summary`
5. **Leverage related thoughts**: System finds connections automatically

## Tools

- `process_thought` - Record stage-based thoughts with metadata
- `generate_summary` - Retrieve session overview
- `export_session` - Save session for future reference
- `import_session` - Load previous session to resume work

## Integration with other tools

- **Pair with codebase-retrieval**: Use Problem Definition/Research stages to plan information gathering, then execute retrieval
- **Complement with Context7**: When assumptions involve library APIs, verify with up-to-date docs
- **Before major refactors**: Use Analysis/Synthesis stages to evaluate patterns from REFACTORING_PLAYBOOK.md
