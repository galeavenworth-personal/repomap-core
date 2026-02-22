---
description: Run CI checks locally and fix any issues before pushing
auto_execution_mode: 3
punch_card: fix-ci
---

# Fix CI Workflow

Use this workflow to run all CI checks locally and fix issues before pushing to GitHub.
This ensures your commits will pass CI on the first try.

**Punch Card:** `fix-ci` (5 rows, 4 required)
**Commands Reference:** [`.kilocode/commands.toml`](../commands.toml)

## Prerequisites

Ensure you're using the virtual environment. All commands in this workflow use
explicit `.venv/bin/python -m ...` invocations (no global installs).

---

## Step 1: Run Ruff Format Check

> 📌 `format ruff` → [`commands.format_ruff`](../commands.toml)
> Resolves to: `.venv/bin/python -m ruff format --check .`
> Gate wrapper: `bounded_gate.py` · `receipt_required = true`

**If it fails:**
```bash
.venv/bin/python -m ruff format .
```

This will auto-fix all formatting issues. Review the changes with `git diff` before committing.

---

## Step 2: Run Ruff Lint

> 📌 `check ruff` → [`commands.check_ruff`](../commands.toml)
> Resolves to: `.venv/bin/python -m ruff check .`
> Gate wrapper: `bounded_gate.py` · `receipt_required = true`

**If it fails:**

Try auto-fixing:
```bash
.venv/bin/python -m ruff check --fix .
```

For issues that can't be auto-fixed, the agent should:
1. Read the error output carefully
2. Use codebase retrieval to find the problematic code:
   > 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
3. Use `read_file` to examine the file
4. Use `edit_file` / `apply_diff` to fix the issue
5. Re-run `check ruff` to verify

Common issues:
- Unused imports: Remove them
- Undefined names: Add imports or fix typos
- Line too long: Break into multiple lines
- Unused variables: Remove or prefix with `_`

---

## Step 3: Run Mypy Type Checking

> 📌 `check mypy` → [`commands.check_mypy`](../commands.toml)
> Resolves to: `.venv/bin/python -m mypy src`
> Gate wrapper: `bounded_gate.py` · `receipt_required = true`

**If it fails:**

The agent should:
1. Read the mypy error output (shows file:line and error type)
2. Use `read_file` to examine the problematic file
3. Fix type issues:
   - Add missing type annotations
   - Fix incorrect type hints
   - Add `# type: ignore` comments only as last resort with explanation
4. Re-run `check mypy` to verify

Common issues:
- Missing return type annotations
- Incompatible types in assignments
- Missing type annotations on function parameters
- Optional types not handled properly

---

## Step 4: Run Full Test Suite

> 📌 `test pytest` → [`commands.test_pytest`](../commands.toml)
> Resolves to: `.venv/bin/python -m pytest -q`
> Gate wrapper: `bounded_gate.py` · `receipt_required = true`

**If it fails:**

The agent should:
1. Identify which test(s) failed from pytest output
2. Run the specific failing test with `-v` for more detail:
    ```bash
    .venv/bin/python -m pytest tests/test_file.py::TestClass::test_method -v
    ```
3. Use `read_file` to examine the test file and understand what's being tested
4. Use codebase retrieval to understand the implementation:
   > 📌 `retrieve codebase` → [`commands.retrieve_codebase`](../commands.toml)
5. Fix the issue in the implementation or test
6. Re-run the specific test to verify
7. Run full suite again to ensure no regressions

---

## Step 5: Run All Checks (Composite Gate)

Once individual checks pass, run the full quality gate composite:

> 📌 `gate quality` → [`commands.gate_quality`](../commands.toml)
> Composite: `format_ruff` → `check_ruff` → `check_mypy` → `test_pytest`
> All run through `bounded_gate.py` with receipt tracking.

**If this passes:** ✅ Your code is ready to push!

**If this fails:** Go back to the failing step and fix it.

---

## Quick Fix Command

For a fast feedback loop during development:

```bash
.venv/bin/python -m ruff format . \
  && .venv/bin/python -m ruff check --fix . \
  && .venv/bin/python -m mypy src \
  && .venv/bin/python -m pytest -q
```

This will:
1. Auto-format code
2. Auto-fix linting issues
3. Run type checking
4. Run tests

Review any changes made by auto-formatters before committing.

---

## Agent Execution Strategy

When running this workflow, the agent should:

1. **Run checks sequentially** — Don't skip ahead if earlier checks fail
2. **Make minimal, targeted fixes** — Don't refactor unrelated code
3. **Verify each fix** — Re-run the specific check after fixing
4. **Provide clear status updates** — Tell the user what's being fixed and why
5. **Stop if uncertain** — Ask the user for clarification on ambiguous errors

### Example Execution Flow

```
User: @fix-ci

Agent:
1. format ruff → commands.format_ruff
   → Fails on 3 files
   → Runs: ruff format .
   → ✅ Fixed

2. check ruff → commands.check_ruff
   → Fails: unused import in test_deps.py:15
   → Views file, removes import
   → Re-runs check
   → ✅ Fixed

3. check mypy → commands.check_mypy
   → Fails: Missing return type in algos.py:80
   → Views file, adds return type
   → Re-runs check
   → ✅ Fixed

4. test pytest → commands.test_pytest
   → All tests pass
   → ✅ Fixed

5. gate quality → commands.gate_quality
   → ✅ All 4 gates pass with receipts

Summary: Fixed 2 formatting files, 1 unused import, 1 type annotation.
Ready to push!
```

---

## EXIT GATE: Punch Card Checkpoint

**Before calling `attempt_completion`, you MUST run the punch card checkpoint.**

> 📌 `mint punches {task_id}` → [`commands.punch_mint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py mint {task_id} --bead-id {bead_id}`

> 🚪 `checkpoint punch-card {task_id} fix-ci` → [`commands.punch_checkpoint`](../commands.toml)
> Resolves to: `python3 .kilocode/tools/punch_engine.py checkpoint {task_id} fix-ci`
> **receipt_required = true** — this is a hard gate.

**If checkpoint FAILS:** Do NOT call `attempt_completion`. Review which required punches
are missing, complete the missing steps, re-mint, and re-checkpoint.

**If checkpoint PASSES:** Proceed to `attempt_completion` with the fix summary.

---

## Troubleshooting

### "Command not found: ruff"
```bash
.venv/bin/pip install -e .[dev]
```

### "No module named 'cli'" (or other import errors)
```bash
.venv/bin/pip install -e .
```

### Tests fail with import errors
```bash
.venv/bin/pip install -e .[test]
```

### Mypy cache issues
```bash
.venv/bin/python -m mypy --clear-cache
.venv/bin/python -m mypy src
```

---

## CI Environment Differences

Note: CI runs on Python 3.11, but local development may use different versions.

If tests pass locally but fail in CI:
- Check Python version compatibility
- Check for version-specific syntax or features
- Review CI logs for environment-specific errors

---

## Related Workflows

- [`/start-task`](./start-task.md) — Task preparation phase
- [`/execute-task`](./execute-task.md) — Task execution phase
- [`/refactor`](./refactor.md) — Refactoring workflow

## Related Skills

- [`repomap-codebase-retrieval`](../skills/repomap-codebase-retrieval/SKILL.md) — Semantic code search
- [`sonarqube-ops`](../skills/sonarqube-ops/SKILL.md) — Code quality metrics

## Philosophy

This workflow enforces **all four quality gates in sequence**, each tracked through
`bounded_gate.py` with receipts. Every gate invocation maps to a `commands.toml` route.
No raw CLI without a routing annotation. Structure discipline all the way down.
