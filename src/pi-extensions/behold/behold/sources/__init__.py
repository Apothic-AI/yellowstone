"""Read-only adapters. Each one returns values plus the exact source it read.

Adapters are pure reads with no ordering dependency, so fixture and snapshot tests stay
trivial. None of them writes, spawns a daemon, opens a socket, or reports anything back to
herdr/pi: behold must not become a second session reporter (the fleet already retired one,
``pi-session-ref-canonical.ts``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field as dc_field
from typing import Any

SUPPORTED_HERDR_PROTOCOLS = frozenset({22})


@dataclass
class Paths:
    """Every directory behold may read, resolved once.

    In fixture mode all of these live under ``root``; in live mode they are the real stores
    and the caller must pass them explicitly (behold never auto-discovers a fleet).
    """

    root: str | None = None
    snapshot: str | None = None
    proc_root: str = "/proc"
    pil_dir: str | None = None
    #: The fleet role records ``pil`` writes at launch (``<lane>.env``). Distinct from
    #: ``pil_dir`` (the session records): a lane can have one without the other.
    roles_dir: str | None = None
    instances_dir: str | None = None
    profiles_dir: str | None = None
    agent_dir: str | None = None
    state_dir: str | None = None
    beads_file: str | None = None
    models_store: str | None = None
    #: pi's provider registry (``models.json``): the file pi resolves a context window
    #: against. Distinct from the cached ``models-store.json``, which is provider-keyed
    #: at its top level and carries no ``subrouter-*`` providers.
    models_registry: str | None = None
    bg_dir: str | None = None
    repos_dir: str | None = None
    global_mode_dir: str | None = None
    live: bool = False
    missing: list[str] = dc_field(default_factory=list)

    @classmethod
    def for_root(cls, root: str) -> "Paths":
        root = os.path.abspath(root)
        p = cls(root=root)
        p.snapshot = os.path.join(root, "herdr", "snapshot.json")
        p.proc_root = os.path.join(root, "proc")
        p.pil_dir = os.path.join(root, "pil", "sessions")
        p.roles_dir = os.path.join(root, "pil", "roles")
        p.instances_dir = os.path.join(root, "instances")
        p.profiles_dir = os.path.join(root, "profiles")
        p.agent_dir = os.path.join(root, "agent")
        p.state_dir = os.path.join(root, "state")
        p.beads_file = os.path.join(root, "state", "beads", "issues.json")
        p.models_store = os.path.join(root, "models-store.json")
        p.models_registry = os.path.join(root, "models.json")
        p.bg_dir = os.path.join(root, "state", "pi-bg")
        p.repos_dir = os.path.join(root, "repos")
        p.global_mode_dir = os.path.join(root, "modes")
        return p

    @classmethod
    def for_live(cls, *, home: str | None = None) -> "Paths":
        """Explicit live layout. Requires ``--snapshot`` or ``--herdr``; no discovery."""
        home = home or os.path.expanduser("~")
        p = cls(root=None, live=True)
        p.snapshot = None
        p.proc_root = "/proc"
        p.pil_dir = os.path.join(home, ".local/state/pil/sessions")
        p.roles_dir = os.path.join(home, ".local/state/pil/roles")
        p.instances_dir = os.path.join(home, ".pi-profile-switch/instances")
        p.profiles_dir = os.path.join(home, ".pi-profile-switch/profiles")
        p.agent_dir = os.path.join(home, ".pi/agent")
        p.state_dir = os.path.join(home, ".pi/agent")
        p.beads_file = None  # bd would be a subprocess; live beads is a remaining gate
        # Both catalogues are real files in the agent dir. The registry is the one pi
        # resolves against; the store is a cache that carries no subrouter-* provider.
        p.models_store = os.path.join(home, ".pi/agent/models-store.json")
        p.models_registry = os.path.join(home, ".pi/agent/models.json")
        p.bg_dir = os.path.join(home, ".local/state/pi-bg")
        p.repos_dir = None
        p.global_mode_dir = os.path.join(home, ".pi/modes")
        return p

    def to_dict(self) -> dict[str, Any]:
        return {
            "root": self.root,
            "live": self.live,
            "snapshot": self.snapshot,
            "proc_root": self.proc_root,
            "pil_dir": self.pil_dir,
            "roles_dir": self.roles_dir,
            "instances_dir": self.instances_dir,
            "profiles_dir": self.profiles_dir,
            "agent_dir": self.agent_dir,
            "state_dir": self.state_dir,
            "beads_file": self.beads_file,
            "models_store": self.models_store,
            "models_registry": self.models_registry,
            "bg_dir": self.bg_dir,
        }


@dataclass
class SourceResult:
    value: Any = None
    error: str | None = None
    source: str | None = None
    duration_ms: float | None = None
    state: str = "present"

    @property
    def ok(self) -> bool:
        return self.error is None

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state if self.error is None else "error",
            "error": self.error,
            "source": self.source,
            "duration_ms": None if self.duration_ms is None else round(self.duration_ms, 3),
        }


class SourceError(Exception):
    """An adapter failed; the roster renders it as a per-field ERROR, never blank."""
