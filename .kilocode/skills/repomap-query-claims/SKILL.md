---
name: repomap-query-claims
description: Query repomap claims database for architectural insights before refactoring or making design decisions. Use when you need to understand existing patterns, dependencies, or layer boundaries.
---

# Repomap Query Claims

## When to use this skill

Use this skill when you need to:

- Understand what architectural patterns exist in a module
- Check if a module uses a specific pattern (facade, repository, strategy, etc.)
- Assess confidence in architectural claims before refactoring
- Find modules with high boil risk (needing re-verification)
- Understand dependencies before making changes

## Prerequisites

- Canonical claims file exists: `repomap_claims.jsonl`
- Claims are up-to-date (run `/claims-pipeline.md` if needed)

## Query Patterns

### Query by Module

Find all claims about a specific module:

```bash
grep '"repomap.claims.langchain"' repomap_claims.jsonl | head -5
```

Or use `jq` for structured output:

```bash
cat repomap_claims.jsonl | jq 'select(.statement | contains("langchain")) | {claim_id, statement, confidence, claim_tier}'
```

### Query by Claim Type

Find all claims of a specific type:

```bash
cat repomap_claims.jsonl | jq 'select(.claim_type == "seam_boundary") | {claim_id, statement, confidence}'
```

Claim types:
- `seam_boundary` - Architectural boundaries and module interfaces
- `integration_touchpoint` - External system integration points
- `intent_glossary` - Domain concepts and terminology
- `layer_violation` - Violations of layered architecture

### Query by Signed Confidence

Find strongly supported claims (> +0.7):

```bash
cat repomap_claims.jsonl | jq 'select(.confidence > 0.7) | {claim_id, statement, confidence}'
```

Find contradicted claims (< -0.3):

```bash
cat repomap_claims.jsonl | jq 'select(.confidence < -0.3) | {claim_id, statement, confidence, boil_risk}'
```

Find uncertain claims (near zero):

```bash
cat repomap_claims.jsonl | jq 'select(.confidence > -0.3 and .confidence < 0.3) | {claim_id, statement, confidence, boil_risk}'
```

### Query by Boil Risk

Find claims with high boil risk (> 0.1):

```bash
cat repomap_claims.jsonl | jq 'select(.boil_risk > 0.1) | {claim_id, statement, confidence, boil_risk, pressure, gravity}'
```

### Query by Pattern

Find all facade pattern claims:

```bash
cat repomap_claims.jsonl | jq 'select(.operational_definition_ref == "facade_pattern:0.1") | {claim_id, statement, confidence}'
```

Pattern refs:
- `facade_pattern:0.1`
- `repository_pattern:0.1`
- `strategy_pattern_opportunity:0.1`
- `data_clump:0.1`
- `layered_architecture:0.1`

## Interpreting Results

### Signed Confidence Scores

**Positive (Supporting Evidence):**
- **+0.7 to +1.0** - Strong supporting evidence
- **+0.3 to +0.7** - Moderate supporting evidence
- **+0.0 to +0.3** - Weak supporting evidence

**Negative (Contradictory Evidence):**
- **-0.3 to -0.0** - Weak contradictory evidence
- **-0.7 to -0.3** - Moderate contradictory evidence
- **-1.0 to -0.7** - Strong contradictory evidence

**Near Zero:**
- **-0.3 to +0.3** - Uncertain, no clear evidence either way

### Boil Risk

- **> 0.2** - Critical, needs immediate re-verification
- **0.1-0.2** - High risk, should re-verify soon
- **0.05-0.1** - Moderate risk, monitor
- **< 0.05** - Low risk, stable

### Thermodynamic Properties

- **Pressure** - Urgency from code churn (higher = more changes)
- **Gravity** - Importance weight (higher = more critical)
- **Temperature** - Rate of confidence change

## Example Workflow

### Before Refactoring a Module

1. Query claims about the module:
   ```bash
   cat repomap_claims.jsonl | jq 'select(.statement | contains("langchain.orchestrator")) | {claim_id, statement, confidence, boil_risk}'
   ```

2. Check dependencies:
   ```bash
   grep "repomap.claims.langchain.orchestrator" .repomap/deps.edgelist
   ```

3. Assess risk:
   - High confidence + low boil risk = safe to refactor
   - Low confidence + high boil risk = re-verify first

4. Make informed decision based on evidence

## Integration with Other Skills

- **`repomap-claims-ops`** - Run pipeline to update claims
- **`repomap-codebase-retrieval`** - Semantic search for code
- **`sequential-thinking-default`** - Plan refactoring strategy

## References

- Canonical claims: [`repomap_claims.jsonl`](../../repomap_claims.jsonl)
- Artifacts: [`.repomap/`](../../.repomap/)
- Workflow: [`/claims-pipeline.md`](../../.kilocode/workflows/claims-pipeline.md)
