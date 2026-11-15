"""Shared test helpers: one fixture fleet per process, plus CLI invocation in-process.

The fixture root and ``as_of`` come from the environment set by ``tests/run-tests.sh`` so a
suite can also be run by hand after generating fixtures.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from typing import Any

from tests import isolation

#: The fail-closed guard is installed as soon as the helpers are imported, so it is in
#: place before any test runs -- and before any test can open the real machine's stores.
isolation.install()
isolation.prepare_sandbox()

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
FIXTURE_ROOT = os.environ.get("BEHOLD_FIXTURE_ROOT", "/tmp/behold-fix")
AS_OF = os.environ.get("BEHOLD_AS_OF", "2026-11-11T03:00:00Z")
SENTINELS = {
    "goal_text": "SENTINEL_GOAL_TEXT",
    "todo_subject": "SENTINEL_TODO_SUBJECT",
    "cron_prompt": "SENTINEL_CRON_PROMPT",
    "room_body": "SENTINEL_ROOM_BODY",
    "bead_description": "SENTINEL_BEAD_DESCRIPTION",
    "bead_notes": "SENTINEL_BEAD_NOTES",
    "bead_title": "SENTINEL_BEAD_TITLE",
    "dagr_title": "SENTINEL_DAGR_TITLE",
    "session_message": "SENTINEL_SESSION_MESSAGE",
    "tool_arguments": "SENTINEL_TOOL_ARGUMENTS",
    "skill_body": "SENTINEL_SKILL_BODY",
    "prompt_body": "SENTINEL_PROMPT_BODY",
    "api_key": "SENTINEL_API_KEY",
    "env_value": "SENTINEL_ENV_VALUE",
    "monitor_description": "SENTINEL_MONITOR_DESCRIPTION",
}

_cache: dict[str, Any] = {}


#: V3 has no external adapters at all: no --git/--jj flags to pass. Repo-derived fields are
#: typed unknown with `repo-adapter-not-isolated`.
GIT: tuple[str, ...] = ()


def roster(*extra: str, root: str | None = None) -> tuple[int, str, str]:
    """Run the CLI in a subprocess (so the guard/audit hook is a fresh process).

    The run is synthetic and explicit by construction: a fixture tree, a fixed clock, and
    an explicit cache decision with a cache path inside the sandbox. The child inherits
    the redirected environment, so its own ``sitecustomize`` refuses the real machine too.
    """
    argv = [sys.executable, os.path.join(ROOT, "bin", "behold"), "roster",
            "--root", root or FIXTURE_ROOT, "--as-of", AS_OF,
            "--cache", "off", "--cache-db", scratch_cache_db(), *extra]
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=180,
                          env=isolation.redirect_environment())
    return proc.returncode, proc.stdout, proc.stderr


def scratch_cache_db() -> str:
    """A cache path inside the sandbox, unique per call."""
    directory = tempfile.mkdtemp(prefix="cache-", dir=isolation.SANDBOX)
    return os.path.join(directory, "behold.db")


def roster_json(*extra: str, root: str | None = None) -> dict[str, Any]:
    key = "|".join(extra) + "|" + (root or FIXTURE_ROOT)
    if key in _cache:
        return _cache[key]
    code, out, err = roster(*extra, root=root)
    if code != 0:
        raise AssertionError(f"roster failed rc={code}\nstdout={out[:2000]}\nstderr={err[:4000]}")
    doc = json.loads(out)
    _cache[key] = doc
    return doc


def lanes(doc: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {lane["key"]: lane for lane in doc["lanes"]}


def field(lane: dict[str, Any], key: str) -> dict[str, Any]:
    return lane["fields"][key]


def full_text(doc: dict[str, Any]) -> str:
    return json.dumps(doc, ensure_ascii=False)


def generated_root() -> str:
    return FIXTURE_ROOT


def require_fixtures() -> None:
    if not os.path.exists(os.path.join(FIXTURE_ROOT, "herdr", "snapshot.json")):
        raise unittest.SkipTest(
            f"fixtures missing at {FIXTURE_ROOT}; run tests/run-tests.sh or "
            f"python3 fixtures/make_fixtures.py {FIXTURE_ROOT}"
        )


def flat_snapshot(protocol: int = 22) -> dict[str, Any]:
    """A minimal herdr snapshot document in the flat shape the roster reads."""
    return {
        "protocol": protocol,
        "workspaces": [],
        "tabs": [],
        "panes": [],
        "agents": [],
    }


def nested_snapshot(protocol: int = 22) -> dict[str, Any]:
    """A herdr snapshot document in the live API's nested shape."""
    return {
        "protocol": protocol,
        "workspaces": [
            {
                "workspace_id": "wX",
                "label": "fake-workspace",
                "number": 1,
                "tab_count": 1,
                "pane_count": 1,
                "agent_status": "idle",
                "tabs": [
                    {
                        "tab_id": "wX:t1",
                        "label": "fake-lane",
                        "panes": [
                            {
                                "pane_id": "wX:p1",
                                "label": "fake-lane",
                                "agent_status": "idle",
                                "cwd": "/tmp",
                                "agent": {"name": "pi", "cwd": "/tmp"},
                            }
                        ],
                    }
                ],
            }
        ],
    }


def fake_herdr_bin(directory: str | None = None, *,
                   document: dict[str, Any] | None = None,
                   exit_code: int = 0, stderr: str = "") -> str:
    """Create a fake ``herdr`` executable and return the directory holding it.

    The fake prints a snapshot document on stdout, exactly as ``herdr api snapshot``
    does, and records how it was called in ``herdr.called``. It lives **inside the
    sandbox**, so the isolation guard allows the spawn and the real binary is never a
    candidate: the suite can exercise the capture path end to end without ever touching
    the live herdr.
    """
    return isolation.fake_herdr_bin(document=document, exit_code=exit_code, stderr=stderr)


def fake_herdr_calls(directory: str) -> list[str] | None:
    """The argv the fake herdr was called with, or ``None`` when it was never called."""
    return isolation.fake_herdr_calls(directory)
