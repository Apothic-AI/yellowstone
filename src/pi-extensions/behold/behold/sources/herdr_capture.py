"""Direct capture of the live herdr topology.

One child process, one exact argv, no shell, a bounded timeout. The command is
``herdr api snapshot``: herdr's own read-only API, which prints the live snapshot
document on stdout.

The rules this module keeps:

* **No shell.** ``subprocess.run`` is called with an argument list and ``shell=False``.
  There is no string to be re-interpreted, so there is no quoting to get wrong.
* **One exact argv.** The audit hook in :mod:`behold.guard` refuses every spawn that does
  not match a live one-shot permit, and the permit is created for this argv and revoked
  as soon as the spawn is over.
* **Bounded.** The child gets a timeout. A hung herdr fails the run instead of hanging it.
* **Typed failures.** A missing binary, a timeout, a non-zero exit and an unparseable
  document are four different stable codes, not one generic error.
* **Sanitized stderr.** herdr's stderr is stripped of ANSI escapes and control
  characters, the home directory is shortened to ``~``, and the result is truncated. The
  raw stderr never reaches the operator's terminal or the cache.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field as dc_field
from typing import Any, Callable, Sequence

from .. import guard

#: The binary to run. Resolved on PATH; the resolved absolute path is what is executed
#: and what the spawn permit is written against.
HERDR_BIN = "herdr"

#: The exact subcommand. This is the whole capability: a read of the topology.
HERDR_SUBCOMMAND: tuple[str, ...] = ("api", "snapshot")

#: The purpose string the guard permit must carry.
PURPOSE = "herdr-snapshot-capture"

#: Seconds the child may run. Bounded on purpose: a hung herdr must fail the run.
DEFAULT_TIMEOUT_S = 10.0

#: How much sanitized stderr is kept.
MAX_STDERR_CHARS = 400

#: A runner is ``(argv, timeout_s) -> (returncode, stdout, stderr)``. Tests inject one;
#: the default runner spawns the real binary.
Runner = Callable[[Sequence[str], float], "tuple[int, str, str]"]

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"\s+")


#: The herdr API protocol this build speaks. It is read from the installed herdr's own
#: schema (``herdr api schema --json``: ``protocol: 22``) and it is the protocol the
#: roster's own snapshot parser accepts. It is **not** used to fill in a missing
#: protocol: a document without one is refused (see :func:`normalize_snapshot`).
HERDR_API_PROTOCOL = 22

#: The required keys of the herdr API's ``SessionSnapshot`` (from the installed schema's
#: ``success_response/$defs/SessionSnapshot``): version, protocol, workspaces, tabs,
#: panes, layouts and agents. A captured document must carry an integer ``protocol`` and
#: the topology arrays; anything else is refused rather than guessed at.
SESSION_SNAPSHOT_REQUIRED = ("version", "protocol", "workspaces", "tabs", "panes",
                             "layouts", "agents")

#: The API's success envelope (the installed schema's ``success_response``): an object
#: with an ``id`` and a ``result``. The CLI may print the snapshot bare or wrapped in
#: this envelope; both are accepted, and nothing else is unwrapped.
API_ENVELOPE_RESULT = "result"

#: herdr 0.9.5's CLI answers ``herdr api snapshot`` with the success envelope holding
#: ``result.snapshot`` (the socket request's payload key), not the snapshot directly at
#: ``result``. Measured 2026-11-12: ``{"id": "cli:api:snapshot", "result": {"snapshot":
#: {...}}}``. It is a second, named level — unwrapped only by this key, never by guessing.
API_ENVELOPE_SNAPSHOT = "snapshot"


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _flatten_nested(document: dict[str, Any]) -> dict[str, Any] | None:
    """Flatten ``workspaces[].tabs[].panes[]`` into the roster's flat arrays.

    The installed herdr API's ``SessionSnapshot`` is **flat** (workspaces / tabs / panes /
    layouts / agents are sibling arrays), so this path is a compatibility path for the
    nested shape a stored herdr *plugin* snapshot uses. It is a *shape* translation, not
    an interpretation: every value is copied from the document, and nothing is invented.
    """
    workspaces = document.get("workspaces")
    if not isinstance(workspaces, list):
        return None
    flat_workspaces: list[dict[str, Any]] = []
    flat_tabs: list[dict[str, Any]] = []
    flat_panes: list[dict[str, Any]] = []
    flat_agents: list[dict[str, Any]] = []
    for workspace in workspaces:
        if not isinstance(workspace, dict):
            continue
        workspace_id = _string_or_none(workspace.get("workspace_id"))
        workspace_record = {key: value for key, value in workspace.items() if key != "tabs"}
        flat_workspaces.append(workspace_record)
        tabs = workspace.get("tabs")
        if not isinstance(tabs, list):
            continue
        for tab in tabs:
            if not isinstance(tab, dict):
                continue
            tab_id = _string_or_none(tab.get("tab_id"))
            tab_record = {key: value for key, value in tab.items() if key != "panes"}
            if tab_id is not None and "workspace_id" not in tab_record and workspace_id:
                tab_record["workspace_id"] = workspace_id
            flat_tabs.append(tab_record)
            panes = tab.get("panes")
            if not isinstance(panes, list):
                continue
            for pane in panes:
                if not isinstance(pane, dict):
                    continue
                pane_id = _string_or_none(pane.get("pane_id"))
                if pane_id is None:
                    continue
                pane_record = {key: value for key, value in pane.items()
                               if key not in ("agent", "cwd", "foreground_cwd", "display_agent")}
                if "workspace_id" not in pane_record and workspace_id:
                    pane_record["workspace_id"] = workspace_id
                if "tab_id" not in pane_record and tab_id:
                    pane_record["tab_id"] = tab_id
                flat_panes.append(pane_record)
                agent_record = _agent_record(pane, pane_id, workspace_id, tab_id)
                if agent_record is not None:
                    flat_agents.append(agent_record)
    return {
        "protocol": document.get("protocol"),
        "workspaces": flat_workspaces,
        "tabs": flat_tabs,
        "panes": flat_panes,
        "agents": flat_agents,
    }


def _agent_record(pane: dict[str, Any], pane_id: str, workspace_id: str | None,
                  tab_id: str | None) -> dict[str, Any]:
    """Build the roster's agent record from a live pane record.

    The live pane carries its agent as a string (the agent kind, e.g. ``pi``) and its
    session as an ``AgentSessionInfo`` object (``{source, agent, kind, value}``). The
    roster wants the agent *kind*, the candidate lane name and — when the agent published
    a session **path** — the session pin. A session published as an id is not a path, so
    it is not turned into a pin: a pin that cannot be opened is worse than no pin.
    """
    agent = pane.get("agent")
    agent_obj = agent if isinstance(agent, dict) else {}
    agent_kind = _string_or_none(agent_obj.get("name")) or _string_or_none(agent)
    cwd = _string_or_none(pane.get("cwd")) or _string_or_none(agent_obj.get("cwd"))
    record: dict[str, Any] = {
        "pane_id": pane_id,
        "workspace_id": workspace_id,
        "tab_id": tab_id,
        "agent": agent_kind,
        "name": _string_or_none(pane.get("label")),
        "display_agent": _string_or_none(pane.get("display_agent")),
        "cwd": cwd,
        "foreground_cwd": _string_or_none(pane.get("foreground_cwd")),
        "agent_status": _string_or_none(pane.get("agent_status")),
        "terminal_title_stripped": _string_or_none(pane.get("terminal_title_stripped")),
    }
    session = agent_obj.get("session")
    if isinstance(session, dict):
        value = _string_or_none(session.get("value"))
        kind = _string_or_none(session.get("kind"))
        if value and kind == "path":
            record["agent_session"] = {"value": value, "source": session.get("source")}
    for key in ("state_change_seq", "completion_seq", "interactive_ready", "restore_error"):
        if key in pane:
            record[key] = pane[key]
    return record


class SnapshotShapeError(Exception):
    """The captured document is not a topology this build can read."""


def normalize_snapshot(document: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Normalize a captured document into the roster's flat protocol-22 shape.

    Returns ``(normalized, notes)``. The rules, in order:

    1. the document may be the herdr API's success envelope (``{"id", "result"}``); the
       result is used when it is an object;
    2. the document must carry an **integer** ``protocol``. A document without one is
       **refused** — the protocol is never defaulted, because a default would be a claim
       about a document that did not make it;
    3. the flat shape (the installed schema's ``SessionSnapshot``) is used as it is;
    4. the nested ``workspaces[].tabs[].panes[]`` shape is flattened (compatibility);
    5. anything else raises :class:`SnapshotShapeError` — never an empty roster.
    """
    notes: list[str] = []
    candidate = document
    if (isinstance(candidate, dict) and "protocol" not in candidate
            and isinstance(candidate.get(API_ENVELOPE_RESULT), dict)):
        candidate = candidate[API_ENVELOPE_RESULT]
        notes.append("unwrapped the herdr API success envelope")
    if (isinstance(candidate, dict) and "protocol" not in candidate
            and isinstance(candidate.get(API_ENVELOPE_SNAPSHOT), dict)):
        candidate = candidate[API_ENVELOPE_SNAPSHOT]
        notes.append("unwrapped the CLI's result.snapshot envelope")
    if not isinstance(candidate, dict):
        raise SnapshotShapeError("the captured document is not a JSON object")
    protocol = _as_int(candidate.get("protocol"))
    if protocol is None:
        raise SnapshotShapeError(
            "the captured document carries no integer protocol field; refusing to guess")
    if isinstance(candidate.get("agents"), list) and isinstance(candidate.get("panes"), list):
        normalized = {
            "protocol": protocol,
            "version": candidate.get("version"),
            "workspaces": candidate.get("workspaces") if isinstance(candidate.get("workspaces"), list) else [],
            "tabs": candidate.get("tabs") if isinstance(candidate.get("tabs"), list) else [],
            "panes": candidate.get("panes"),
            "agents": candidate.get("agents"),
            "layouts": candidate.get("layouts") if isinstance(candidate.get("layouts"), list) else [],
        }
        return normalized, notes
    flattened = _flatten_nested(candidate)
    if flattened is None:
        raise SnapshotShapeError(
            "the captured document is not a herdr topology: it has neither the flat "
            "agents/panes arrays nor a workspaces[].tabs[].panes[] tree")
    flattened["protocol"] = protocol
    notes.append("flattened the nested workspaces[].tabs[].panes[] topology")
    return flattened, notes


@dataclass
class CaptureResult:
    """The outcome of one capture attempt."""

    ok: bool
    argv: tuple[str, ...]
    document: dict[str, Any] | None = None
    error: str | None = None
    message: str | None = None
    stderr: str | None = None
    duration_ms: float = 0.0
    bytes: int = 0
    notes: list[str] = dc_field(default_factory=list)
    #: When the capture was made, on this machine's clock. This is the topology's
    #: provenance: the herdr snapshot document carries no timestamp of its own, so the
    #: moment the roster asked is the only moment it can name.
    captured_at: str | None = None
    captured_at_epoch: float | None = None

    @property
    def source(self) -> str:
        return "herdr api snapshot (captured)"

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "argv": list(self.argv),
            "error": self.error,
            "message": self.message,
            "stderr": self.stderr,
            "duration_ms": round(self.duration_ms, 3),
            "bytes": self.bytes,
            "notes": list(self.notes),
            "captured_at": self.captured_at,
            "captured_at_epoch": self.captured_at_epoch,
        }


def resolve_executable(name: str = HERDR_BIN) -> str | None:
    """The absolute path of the herdr binary, or ``None`` when it is not on PATH."""
    found = shutil.which(name)
    if not found:
        return None
    return os.path.abspath(found)


def sanitize_stderr(text: str | None, *, home: str | None = None) -> str | None:
    """Make herdr's stderr safe to show and safe to store.

    ANSI escapes and control characters go, the home directory becomes ``~``, runs of
    whitespace collapse, and the result is truncated. The point is that an error message
    cannot smuggle a terminal escape or an unbounded blob into the operator's terminal.
    """
    if not text:
        return None
    cleaned = _ANSI_RE.sub("", text)
    cleaned = _CONTROL_RE.sub(" ", cleaned)
    home = home if home is not None else os.path.expanduser("~")
    if home and home != "/":
        cleaned = cleaned.replace(home, "~")
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()
    if not cleaned:
        return None
    if len(cleaned) > MAX_STDERR_CHARS:
        cleaned = cleaned[: MAX_STDERR_CHARS - 3] + "..."
    return cleaned


def _default_runner(argv: Sequence[str], timeout_s: float) -> tuple[int, str, str]:
    """Run the capture command, under a one-shot spawn permit."""
    permit = guard.permit_spawn(argv, purpose=PURPOSE)
    try:
        proc = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_s,
            shell=False,
            check=False,
            env=dict(os.environ),
        )
    finally:
        # An unused permit is dropped here; a consumed one is already gone.
        permit.revoke()
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def capture(*, executable: str | None = None, timeout_s: float = DEFAULT_TIMEOUT_S,
            runner: Runner | None = None,
            clock: Callable[[], float] = time.time) -> CaptureResult:
    """Capture the live herdr topology.

    ``runner`` is the injection point for tests: it receives the argv and the timeout and
    returns ``(returncode, stdout, stderr)``. No test in this repository ever calls the
    real herdr.

    ``clock`` is the wall clock the capture is stamped with. The moment the roster asked
    herdr is the only moment it can name, so it is read from the clock the caller gives
    it: a test that drives a watch with a synthetic clock needs the capture and the map
    it publishes to agree on the same moment.
    """
    exe = executable if executable is not None else resolve_executable()
    if not exe:
        return CaptureResult(
            ok=False,
            argv=(HERDR_BIN, *HERDR_SUBCOMMAND),
            error="herdr-not-found",
            message=("the herdr binary is not on PATH; capture a snapshot out of band and "
                     "pass --snapshot FILE"))
    argv = (os.path.abspath(exe), *HERDR_SUBCOMMAND)
    started = time.perf_counter()
    captured_epoch = clock()
    captured_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(captured_epoch))
    try:
        returncode, stdout, stderr = (runner or _default_runner)(argv, timeout_s)
    except subprocess.TimeoutExpired:
        return CaptureResult(
            ok=False,
            argv=argv,
            error="herdr-timeout",
            message=f"herdr api snapshot did not finish within {timeout_s:g}s",
            duration_ms=(time.perf_counter() - started) * 1000.0)
    except OSError as exc:
        return CaptureResult(
            ok=False,
            argv=argv,
            error="herdr-spawn-failed",
            message=f"herdr could not be started: {exc.strerror or exc.__class__.__name__}",
            duration_ms=(time.perf_counter() - started) * 1000.0)
    duration_ms = (time.perf_counter() - started) * 1000.0
    clean_stderr = sanitize_stderr(stderr)
    if returncode != 0:
        return CaptureResult(
            ok=False,
            argv=argv,
            error=f"herdr-exit-{returncode}",
            message=f"herdr api snapshot exited {returncode}",
            stderr=clean_stderr,
            duration_ms=duration_ms)
    try:
        document = json.loads(stdout)
    except ValueError:
        return CaptureResult(
            ok=False,
            argv=argv,
            error="herdr-invalid-json",
            message="herdr api snapshot did not return a JSON document",
            stderr=clean_stderr,
            duration_ms=duration_ms,
            bytes=len(stdout))
    if not isinstance(document, dict):
        return CaptureResult(
            ok=False,
            argv=argv,
            error="herdr-invalid-json",
            message="herdr api snapshot did not return a JSON object",
            stderr=clean_stderr,
            duration_ms=duration_ms,
            bytes=len(stdout))
    return CaptureResult(
        ok=True,
        argv=argv,
        document=document,
        stderr=clean_stderr,
        duration_ms=duration_ms,
        bytes=len(stdout),
        notes=[],
        captured_at=captured_at,
        captured_at_epoch=captured_epoch)
