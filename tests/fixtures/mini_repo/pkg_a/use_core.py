"""Use core module to create internal dependency edges."""

from pkg_a.core import Greeter, compute_value


def run() -> str:
    greeter = Greeter()
    return f"{greeter.greet('fixture')}::{compute_value(2)}"
