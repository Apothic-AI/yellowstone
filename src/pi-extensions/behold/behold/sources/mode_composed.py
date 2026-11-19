"""Composed mode definitions: the digest pi-modes itself would record.

A lane's mode can be *composed*: a global base plus a project `append`/overlay delta. The
digest a lane records for such a selection covers the composed result, not either file, so
re-hashing files cannot check it — which is why drift on a composed lane was reported
`unverifiable` rather than false drift.

The composition is not a Python problem. pi-modes has one function that decides it
(`modeDefinitionFingerprint`), and any value computed here must be the value pi-modes
compares against or the comparison is theatre. So this module shells out to
`~/.overlord/tools/mode-composed-digest.mjs`, which imports that function from the
installed package (`PI_MODES_PKG` / the path pi itself loads) and prints one JSON line:

    {"scope": "...", "digest": "<sha256>", "path": "..."}

Read-only, by construction: the script recomputes and prints. Nothing here writes, and
nothing repairs drift — `reconcile-mode.py` refuses propagation by design and that refusal
is right.

Failure is an absence, never a guess: a missing script, a node that cannot run, or output
that is not the expected JSON yields `available: False` with the reason, and the caller
reports `unverifiable`.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any

#: The digest script. Overridable for tests and for a worktree checkout.
DIGEST_SCRIPT_ENV = "PI_MODES_DIGEST"
DEFAULT_DIGEST_SCRIPT = "~/.overlord/tools/mode-composed-digest.mjs"

#: Where pi keeps the agent directory the script needs (`REAL_AGENT_DIR`).
AGENT_DIR_ENV = "REAL_AGENT_DIR"
DEFAULT_AGENT_DIR = "~/.pi/agent"

TIMEOUT_SECONDS = 20

#: One composition per (cwd, key) per process: a roster run asks for the same lane's
#: composition once, and a subprocess per field would make the read expensive enough that
#: nobody would use it.
_CACHE: dict[tuple[str, str], dict[str, Any]] = {}


def agent_dir(env: dict[str, str] | None = None) -> str:
    """The agent directory pi itself uses, where the shared base modes live."""
    source = env if env is not None else os.environ
    return os.path.abspath(os.path.expanduser(source.get(AGENT_DIR_ENV) or DEFAULT_AGENT_DIR))


def base_mode_path(key: str, env: dict[str, str] | None = None) -> str:
    """The shared base definition for a key: the other half of a composed digest.

    A project overlay composes on top of this file, so its mtime is as much an input to
    the lane's mode as the overlay is. An age taken from the overlay alone can exonerate a
    lane that the base is what drifted.
    """
    return os.path.join(agent_dir(env), "modes", key + ".json")


def digest_script_path(env: dict[str, str] | None = None) -> str:
    value = (env or os.environ).get(DIGEST_SCRIPT_ENV) or DEFAULT_DIGEST_SCRIPT
    return os.path.abspath(os.path.expanduser(value))


def composed_digest(
    cwd: str,
    key: str,
    *,
    recorded_path: str | None = None,
    env: dict[str, str] | None = None,
    timeout: int = TIMEOUT_SECONDS,
    permit=None,
) -> dict[str, Any]:
    """The digest pi-modes would record for `cwd` + `key`, or an availability failure.

    Never raises: a caller must be able to tell "the composition differs" from "I could
    not run the composition", and an exception would collapse the two.
    """
    cache_key = (os.path.abspath(cwd), key, os.path.abspath(recorded_path) if recorded_path else '')
    if cache_key in _CACHE:
        return dict(_CACHE[cache_key])
    script = digest_script_path(env)
    if not os.path.exists(script):
        return {"available": False, "reason": f"digest_script_missing:{script}"}
    run_env = dict(os.environ if env is None else env)
    run_env.setdefault(AGENT_DIR_ENV, os.path.expanduser(DEFAULT_AGENT_DIR))
    cmd = ["node", "--experimental-strip-types", script, cwd, key]
    if recorded_path:
        # A launcher lane reads its own materialised copy, and the path is part of the
        # fingerprint: the same text at the instance path hashes differently from the
        # shared agent dir. The script digests the named copy instead of the discovered one.
        cmd.append(recorded_path)
    try:
        if permit is not None:
            # The guard permits exactly this argv once; without the permit the spawn is
            # refused, which is how a read-only surface stays read-only.
            permit(cmd)
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, env=run_env, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"available": False, "reason": f"digest_script_failed:{exc.__class__.__name__}"}
    if proc.returncode != 0:
        return {
            "available": False,
            "reason": f"digest_script_exit:{proc.returncode}",
            "stderr": (proc.stderr or "").strip()[:400],
        }
    line = (proc.stdout or "").strip().splitlines()
    if not line:
        return {"available": False, "reason": "digest_script_empty"}
    try:
        payload = json.loads(line[-1])
    except ValueError:
        return {"available": False, "reason": "digest_script_not_json"}
    if not isinstance(payload, dict) or not payload.get("digest"):
        return {"available": False, "reason": "digest_script_no_digest"}
    answer = {
        "available": True,
        "scope": payload.get("scope"),
        "digest": payload.get("digest"),
        "path": payload.get("path"),
    }
    _CACHE[cache_key] = dict(answer)
    return answer


def newest_edit(paths: list[str], *, now: float | None = None) -> dict[str, Any] | None:
    """The newest mtime among the files a lane composes, with its age.

    This is the context a drift count needs: eight drifted lanes immediately after a mode
    edit is expected, eight a week after any edit is a fault. `None` when no path could be
    read — an unreadable file must not read as "edited just now".
    """
    import time

    stamp = time.time() if now is None else now
    newest: dict[str, Any] | None = None
    for path in paths:
        if not path:
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if newest is None or mtime > newest["at"]:
            newest = {"path": path, "at": mtime}
    if newest is None:
        return None
    return {
        "path": newest["path"],
        "edited_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(newest["at"])),
        "age_s": max(0, int(stamp - newest["at"])),
    }
