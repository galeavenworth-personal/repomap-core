"""Imports chosen to exercise static integration detection."""

import requests

from pkg_a.core import Greeter


def integration_probe() -> str:
    return f"{requests.__name__}:{Greeter.__name__}"
