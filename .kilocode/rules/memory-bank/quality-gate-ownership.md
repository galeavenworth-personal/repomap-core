# Quality Gate Ownership - No Buck Passing

## Core Principle
**ALL quality gates must pass. Period.** There is no concept of "not my responsibility" in AI software fabrication.

## The Reality
- Quality gates pass before every PR merge
- If a gate fails now, it MUST be from code after the last merge
- Therefore, it IS the current agent's responsibility to fix it
- No exceptions, no excuses, no passing the buck

## Why This Matters for AI Fabrication

### Higher Standard Required
AI-fabricated software must exceed human code quality standards, not merely meet them. This means:

1. **Zero tolerance for degradation**: If it's broken, fix it - regardless of "who broke it"
2. **Proactive quality**: Don't just fix your code, fix anything blocking the gates
3. **Hybrid readability**: Code must be optimized for both human AND LLM consumption
   - Rooted in human conventions and structure
   - Evolved to optimize LLM navigation and comprehension
   - Clear, explicit, well-typed, well-tested

### Fabrication vs Traditional Development
- **Traditional**: "Not my code, not my problem"
- **Fabrication**: "Quality gate failed, my responsibility to fix"

## Implementation Rules

### When Running /respond-to-pr-review or /fix-ci
1. **Never skip failing gates** with justifications like:
   - "This failure is unrelated to my changes"
   - "This was broken before I started"
   - "This is someone else's responsibility"

2. **Always fix ALL failures**:
   - Read the error
   - Understand the root cause
   - Apply the clean fix (no workarounds, no ignores)
   - Verify the fix works
   - Move to next failure

3. **Quality gate hierarchy** (all must pass):
   - `ruff format --check .`
   - `ruff check .`
   - `mypy src`
   - `pytest -q`
   - SonarQube PR scan (if applicable)

### Mental Model Shift
**OLD**: "I'll fix my code and let someone else handle the rest"
**NEW**: "I own the entire quality posture of this codebase right now"

## Rationale
In software fabrication, agents are not siloed contributors - they are stewards of the entire codebase during their session. Quality cannot be compartmentalized. Every agent session must leave the codebase in a better state than it found it.
