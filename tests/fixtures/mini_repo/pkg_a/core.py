"""Core symbols for the mini fixture package."""


class Greeter:
    """Simple class with a documented method."""

    def greet(self, name: str) -> str:
        """Return a deterministic greeting."""
        return f"hello, {name}"


def compute_value(x: int) -> int:
    return x + 1
