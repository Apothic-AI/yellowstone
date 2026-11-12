"""behold — read-only, derive-on-demand fleet roster (P1+P2 foundation).

Nothing in this package writes to a fleet store, spawns a daemon, opens a socket, or
reports state back to herdr/pi. The two safety mechanisms are ``guard.Policy`` (privacy
deny-before-read) and ``guard.enforce()`` (a fail-closed CPython audit hook).
"""

from __future__ import annotations

__all__ = ["cli", "field", "guard", "identity", "lane", "procfs", "render", "session", "util", "watch"]
__version__ = "0.1.0-p1p2"
