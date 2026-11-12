"""Minimal, allowlisted ``/proc`` reads: the pid triple and nothing else.

The ``(boot_id, pid, starttime)`` triple is the strongest available *correlation* for
liveness and PID-reuse detection: starttime comes from the kernel and survives pid reuse.
It is a local observation, not authentication — a privileged writer could craft a process
that looks the same — so behold calls it a correlation and never "unforgeable identity".
Pane ids, lane names and session UUIDs are handles; they join, they do not prove.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from . import guard

#: The only process environment keys behold is ever allowed to materialize.
#: PI_CODING_AGENT_DIR is read only to resolve the lane's instance (the basename under the
#: instances dir); its value is never emitted. HERDR_* are read for cross-checks only.
ENV_ALLOWLIST = (
    "PI_PROFILE",
    "PI_MODE",
    "PI_ROOMS_NAME",
    "PI_CODING_AGENT_DIR",
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
)


@dataclass
class ProcInfo:
    pid: int
    comm: str | None
    state: str | None
    starttime: int | None
    boot_id: str | None
    available: bool
    error: str | None = None

    @property
    def triple(self) -> str | None:
        if self.starttime is None or self.boot_id is None:
            return None
        return f"{self.boot_id}:{self.pid}:{self.starttime}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "comm": self.comm,
            "state": self.state,
            "starttime": self.starttime,
            "boot_id": self.boot_id,
            "triple": self.triple,
            "available": self.available,
            "error": self.error,
        }


def boot_id(proc_root: str = "/proc", policy: guard.Policy | None = None) -> str | None:
    path = os.path.join(proc_root, "sys/kernel/random/boot_id")
    try:
        if policy is not None:
            return guard.read_text(path, policy, "boot-id").strip()
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except (OSError, guard.DeniedRead):
        return None


def stat_path(pid: int, proc_root: str = "/proc") -> str:
    return os.path.join(proc_root, str(pid), "stat")


def read_stat(pid: int, policy: guard.Policy, proc_root: str = "/proc") -> ProcInfo:
    path = stat_path(pid, proc_root)
    try:
        raw = guard.read_text(path, policy, "proc-stat")
    except guard.DeniedRead:
        raise
    except OSError as exc:
        return ProcInfo(pid=pid, comm=None, state=None, starttime=None,
                        boot_id=boot_id(proc_root, policy),
                        available=False, error=f"stat_unavailable:{exc.__class__.__name__}")
    # `pid (comm) state ppid ...`: comm may contain spaces and parentheses, so split at
    # the *last* ')' rather than tokenizing.
    close = raw.rfind(")")
    open_paren = raw.find("(")
    comm = raw[open_paren + 1 : close] if 0 <= open_paren < close else None
    rest = raw[close + 2 :].split() if close >= 0 else []
    state = rest[0] if rest else None
    try:
        starttime = int(rest[19])  # field 22 overall; rest[0] is field 3
    except (IndexError, ValueError):
        starttime = None
    return ProcInfo(pid=pid, comm=comm, state=state, starttime=starttime,
                    boot_id=boot_id(proc_root, policy), available=True)


def read_env(pid: int, policy: guard.Policy, proc_root: str = "/proc") -> dict[str, str]:
    path = os.path.join(proc_root, str(pid), "environ")
    try:
        return guard.read_env_allowlist(path, ENV_ALLOWLIST, policy, "proc-environ")
    except (OSError, guard.DeniedRead):
        return {}


def exists(pid: int, proc_root: str = "/proc") -> bool:
    return os.path.isdir(os.path.join(proc_root, str(pid)))
