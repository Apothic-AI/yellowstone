"""A lane's fleet role record: ``<roles dir>/<lane>.env``.

``pil`` writes one small file per lane at launch. Its whole content is the launch
environment's role line, so it is the only place Behold can learn a lane's fleet role:

    PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1

Why this is a source of its own
-------------------------------
A lane's role is **not** derivable from anything else Behold reads. The lane name suffix
(``-leader``), the selected profile and the model are correlation, never evidence: a lane
named ``x-leader`` can be running as a worker, and a worker can carry a leader profile.
So the record is read, or the field is ``absent``/``unknown`` — it is never inferred. That
rule is the whole point of this module.

Admission comes first
---------------------
The path is derived from the **admitted** lane's name and nothing else — no directory walk,
no glob, no fallback candidate. A lane the roster refuses (held workspace, reserved tab or
pane) is refused *before* a path is even composed, which is the same rule
:class:`behold.identity.PilAccess` follows. ``opened`` and ``rejected`` are kept so a test
can assert the refused lane never reached the open, with a positive control proving the
reader ran at all.

State vocabulary
----------------
* ``present`` — the file exists, parses, and carries a usable ``PI_MODE``;
* ``absent`` — no record for this lane (a lane that predates the role file, or one launched
  outside ``pil``): a real, reportable fact, not a failure;
* ``unknown`` — the file exists but cannot be used (unreadable, no ``PI_MODE``, a value that
  is not a safe handle). The reason says which.
"""

from __future__ import annotations

import os
import re
from typing import Any

from .. import guard

#: A safe lane handle: the shape lane names take. A handle that can name a file is a handle
#: that can be made to name one, so the charset is narrow and the length bounded.
SAFE_LANE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

#: A safe role value, for the same reason: it is echoed into the document.
SAFE_ROLE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")

#: The key this module reports. It is the fleet role, not the pi-modes ``mode`` (``M-1``).
ROLE_KEY = "PI_MODE"


class RoleAccess:
    """Admission-gated access to one lane's role record. Never walks the directory."""

    def __init__(self, directory: str | None, policy: guard.Policy):
        self.directory = directory
        self.policy = policy
        self.opened: list[str] = []
        self.rejected: list[str] = []
        self.errors: list[str] = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "directory": self.directory,
            "opened": len(self.opened),
            "rejected": list(self.rejected),
            "errors": list(self.errors),
        }

    def role_for(
        self,
        *,
        name_hint: str | None,
        pane_id: str | None,
        workspace_id: str | None,
        tab_id: str | None,
    ) -> dict[str, Any]:
        """Return ``{"state", "role", "source", "reason"}`` for one lane.

        Admission is re-checked here so this method cannot become a bypass even if a
        caller forgets it: a denied lane never reaches the path composition below.
        """
        admitted, reason = self.policy.admit_lane(workspace_id, pane_id, tab_id)
        if not admitted:
            self.rejected.append(f"{pane_id}:{reason}")
            return {"state": "refused", "role": None, "source": None,
                    "reason": f"denied:{reason}"}
        if not self.directory:
            return {"state": "unknown", "role": None, "source": None,
                    "reason": "role_directory_unknown"}
        if not name_hint or not SAFE_LANE.match(name_hint):
            return {"state": "absent", "role": None, "source": None,
                    "reason": "no role record for this lane (no usable lane-name handle)"}
        path = os.path.join(self.directory, f"{name_hint}.env")
        if not os.path.exists(path):
            return {"state": "absent", "role": None, "source": path,
                    "reason": "no role record for this lane"}
        self.opened.append(path)
        try:
            text = guard.read_text(path, self.policy, "role-record", limit=4096)
        except (OSError, ValueError, guard.DeniedRead) as exc:
            self.errors.append(f"{os.path.basename(path)}:{exc.__class__.__name__}")
            return {"state": "unknown", "role": None, "source": path,
                    "reason": f"role record unreadable ({exc.__class__.__name__})"}
        pairs = _parse_env_line(text)
        if pairs is None:
            return {"state": "unknown", "role": None, "source": path,
                    "reason": "role record is not a KEY=VALUE line"}
        value = pairs.get(ROLE_KEY)
        if value is None:
            return {"state": "unknown", "role": None, "source": path,
                    "reason": f"role record has no {ROLE_KEY}"}
        if not SAFE_ROLE.match(value):
            return {"state": "unknown", "role": None, "source": path,
                    "reason": f"{ROLE_KEY} is not a safe role value"}
        return {"state": "present", "role": value, "source": path, "reason": None}


def _parse_env_line(text: str) -> dict[str, str] | None:
    """Parse ``K=V K=V`` (one line, space separated) into a mapping.

    ``pil`` writes the launch prefix verbatim, so the file is one environment line rather
    than a ``.env`` file with one assignment per line. Both spellings are accepted; an
    empty file, or one with no ``K=V`` token at all, is not a parse (the caller reports
    ``unknown`` rather than inventing an empty record).
    """
    pairs: dict[str, str] = {}
    tokens = text.split()
    if not tokens:
        return None
    for token in tokens:
        if "=" not in token:
            continue
        key, _, value = token.partition("=")
        key = key.strip()
        if not key or not re.match(r"^[A-Z][A-Z0-9_]*$", key):
            continue
        pairs[key] = value.strip().strip("'\"")
    return pairs or None
