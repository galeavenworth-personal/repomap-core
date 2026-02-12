---
description: Run CI checks locally and fix any issues before pushing
---

# Fix CI Workflow

Use this workflow to run all CI checks locally and fix issues before pushing to GitHub. This ensures your commits will pass CI on the first try.

## Prerequisites

Ensure you're in the virtual environment:
```bash
source .venv/bin/activate
```

Note: even if you activate the venv, prefer explicit venv-safe invocations in this repo:

```bash
.venv/bin/python -m <tool> ...
```

## Step 1: Run Ruff Format Check

Check code formatting:
```bash
.venv/bin/python -m ruff format --check .
```

**If it fails:**
```bash
.venv/bin/python -m ruff format .
```

This will auto-fix all formatting issues. Review the changes with `git diff` before committing.

---

## Step 2: Run Ruff Lint

Check for linting issues:
```bash
.venv/bin/python -m ruff check .
```

**If it fails:**

Try auto-fixing:
```bash
.venv/bin/python -m ruff check --fix .
```

For issues that can't be auto-fixed, the agent should:
1. Read the error output carefully
2. Use `grep_search` or `codebase-retrieval` to find the problematic code
3. Use `view` to read the file
4. Use `str-replace-editor` to fix the issue
5. Re-run `ruff check .` to verify

Common issues:
- Unused imports: Remove them
- Undefined names: Add imports or fix typos
- Line too long: Break into multiple lines
- Unused variables: Remove or prefix with `_`

---

## Step 3: Run Mypy Type Checking

Check type annotations:
```bash
.venv/bin/python -m mypy src
```

**If it fails:**

The agent should:
1. Read the mypy error output (shows file:line and error type)
2. Use `view` to read the problematic file
3. Fix type issues:
   - Add missing type annotations
   - Fix incorrect type hints
   - Add `# type: ignore` comments only as last resort with explanation
4. Re-run `.venv/bin/python -m mypy src` to verify

Common issues:
- Missing return type annotations
- Incompatible types in assignments
- Missing type annotations on function parameters
- Optional types not handled properly

---

## Step 4: Run Full Test Suite

Run all tests:
```bash
.venv/bin/python -m pytest -q
```

**If it fails:**

The agent should:
1. Identify which test(s) failed from pytest output
2. Run the specific failing test with `-v` for more detail:
    ```bash
    .venv/bin/python -m pytest tests/test_file.py::TestClass::test_method -v
    ```
3. Read the test file to understand what's being tested
4. Read the implementation code being tested
5. Fix the issue in the implementation or test
6. Re-run the specific test to verify
7. Run full suite again to ensure no regressions

---

## Step 5: Run All Checks Together

Once individual checks pass, run everything together to simulate CI:

// turbo
```bash
.venv/bin/python -m ruff format --check . \
  && .venv/bin/python -m ruff check . \
  && .venv/bin/python -m mypy src \
  && .venv/bin/python -m pytest -q
```

**If this passes:** ✅ Your code is ready to push!

**If this fails:** Go back to the failing step and fix it.

---

## Quick Fix Command

For a fast feedback loop during development:

// turbo
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

1. **Run checks sequentially** - Don't skip ahead if earlier checks fail
2. **Use parallel tool calls** when gathering context about errors
3. **Make minimal, targeted fixes** - Don't refactor unrelated code
4. **Verify each fix** - Re-run the specific check after fixing
5. **Provide clear status updates** - Tell the user what's being fixed and why
6. **Stop if uncertain** - Ask the user for clarification on ambiguous errors

### Example Execution Flow

```
User: @fix-ci

Agent:
1. Runs: ruff format --check .
   → Fails on 3 files
   → Runs: ruff format .
   → ✅ Fixed

2. Runs: ruff check .
   → Fails: unused import in test_deps.py:15
   → Views file, removes import
   → Re-runs: ruff check .
   → ✅ Fixed

3. Runs: mypy src
   → Fails: Missing return type in algos.py:80
   → Views file, adds return type
   → Re-runs: mypy src
   → ✅ Fixed

4. Runs: pytest -q
   → All 81 tests pass
   → ✅ Fixed

5. Runs: Full CI simulation
   → ✅ All checks pass

Summary: Fixed 2 formatting files, 1 unused import, 1 type annotation.
Ready to push!
```

---

## Troubleshooting

### "Command not found: ruff"
```bash
pip install -e .[dev]
```

### "No module named 'cli'" (or other import errors)
```bash
pip install -e .
```

### Tests fail with import errors
```bash
pip install -e .[test]
```

### Mypy cache issues
```bash
mypy --clear-cache
mypy src
```

---

## CI Environment Differences

Note: CI runs on Python 3.11, but local development may use different versions.

If tests pass locally but fail in CI:
- Check Python version compatibility
- Check for version-specific syntax or features
- Review CI logs for environment-specific errors
