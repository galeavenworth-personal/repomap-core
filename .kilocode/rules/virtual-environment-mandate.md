# Virtual Environment Mandate

You must use the already activated virtual environment for all Python commands and packages. No exceptions.

I have other projects that depend on the exact versions of packages installed, and global package management can break those projects.

## Best Practices

- Always use `.venv/bin/python -m ...` for Python execution
- Never install packages globally
- Verify virtual environment is activated before running commands
- Use `which python` to confirm you're using the project's Python

## Examples

```bash
# Correct
.venv/bin/python -m repomap generate .
.venv/bin/python -m pytest
.venv/bin/python -m ruff check .

# Incorrect
python -m repomap generate .  # May use wrong Python
pip install package  # May install globally
```
