"""Repo detection only. **V3 removed the git and jj adapters.**

V2 shipped `git`/`jj` behind opt-in flags and disclosed that a child is not covered by the
in-process guard. The independent review then showed the decisive case: with repository
`core.fsmonitor` pointing at a helper, the *exact* allowed
`git --no-optional-locks status --porcelain=v2 --branch` still executed that helper and
wrote a file. An exact argv is not containment, and the parent audit hook cannot constrain a
child. Opt-in flags are not independent authorization for arbitrary repository helper writes.

So the capability is gone rather than merely disclosed. What remains is a pure `stat`-based
detection of `.git`/`.jj` presence (no child, no config, no hook) plus typed unknowns for
every repo-derived field, with the reason `repo-adapter-not-isolated`. When a separately
reviewed isolated execution boundary exists, the adapter can return; until then the honest
answer is "unavailable", not a number produced by an unconfined child.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from .. import guard

#: Every repo-derived field carries this reason in V3.
NOT_ISOLATED = guard.REPO_ADAPTER_NOT_ISOLATED


@dataclass
class RepoDetection:
    cwd: str | None
    has_git: bool
    has_jj: bool

    @property
    def kind(self) -> str:
        if self.has_git and self.has_jj:
            return "git+jj"
        if self.has_git:
            return "git"
        if self.has_jj:
            return "jj"
        return "none"

    def to_dict(self) -> dict[str, Any]:
        return {"cwd": self.cwd, "has_git": self.has_git, "has_jj": self.has_jj,
                "kind": self.kind}


def detect(cwd: str | None) -> RepoDetection:
    """Presence probe only: two `os.path.exists` calls, no child process, no config read."""
    if not cwd:
        return RepoDetection(cwd=None, has_git=False, has_jj=False)
    return RepoDetection(
        cwd=cwd,
        has_git=os.path.exists(os.path.join(cwd, ".git")),
        has_jj=os.path.exists(os.path.join(cwd, ".jj")),
    )


def detect_repo(cwd: str | None) -> str:
    """Compatibility shim for callers that only need the kind string."""
    return detect(cwd).kind


def unavailable(field: str) -> dict[str, Any]:
    """The one shape a repo-derived field may take in V3."""
    return {
        "field": field,
        "available": False,
        "reason": NOT_ISOLATED,
        "detail": ("the git/jj adapter was removed: a child process is not confined by the "
                   "in-process read-only guard, and repository config can make even an exact "
                   "read-only argv execute a helper writer"),
    }
