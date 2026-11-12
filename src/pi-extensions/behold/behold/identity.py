"""Lane identity: which session file is *this* lane's, and is that ownership verified?

V3 rule (independent review V2-R2): a *present* proc tuple is not proof of ownership. Ownership
is established only by agreement between independent witnesses, and every disagreement
untrusts the lane:

    session   the pin file (or the pil record) opens, has a header, that header's id matches
              the UUID in its filename, and the id matches what the record names
    record    the pane-matched pil record is joined by its explicit ``paneId``, never by a
              lane name or mtime
    process   /proc gives a pid triple, and the process's own ``HERDR_PANE_ID`` equals the
              snapshot pane (envpane), and its pid equals the reporter/pil pid
    tuple     when the pil record carries ``boot_id``+``starttime``, the observed triple must
              match them. When it does not carry them the tuple is *unrecorded* — reported as
              unknown, never as a verified check

Trust requires: a validated session, at least one independent witness beyond the pin, no
disagreement, and a tuple that is either verified or explicitly unrecorded. A pin alone is
therefore **not** trusted, which is the V2 hole where a pin-only lane was `verified`.

Why the pin can be stale: herdr's ``agent_session`` pin is documented (in ``session-tracker.ts``)
to lag after ``/new`` or ``/resume``. Why names and mtimes are not identity: a lane name is a
human handle and a directory listing's newest file belongs to whoever wrote last.

Deny-before-read: ``PilAccess`` never walks the pil directory. It is given an admitted pane and
the lane *name as a filename hint* (from the rooms pin registry, which holds handles only), opens
exactly one candidate file, and rejects it unless its ``paneId`` matches. A denied lane never
calls it at all, so no denied record is opened — which the review required by attempted-open,
not by output inspection.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field as dc_field
from typing import Any, Callable

from . import guard, procfs, session, util

VERIFIED = "verified"
PIN_MISSING_USED_PIL = "reporter_pin_missing_used_pil_record"
PIN_STALE_USED_PIL = "session_pin_stale_used_pil_record"
PIN_STALE_NO_FALLBACK = "session_pin_stale_no_fallback"
PIN_ONLY_UNVERIFIED = "pin_only_unverified"
NO_SESSION = "no_session_source"
PID_DISAGREEMENT = "pid_disagreement"
PANE_DISAGREEMENT = "pane_disagreement"
TUPLE_DISAGREEMENT = "process_tuple_disagreement"
ENVPANE_DISAGREEMENT = "envpane_disagreement"
HELD = "held_by_policy"

#: Only agreement states may be used for an explicit join or for profile/instance resolution.
TRUSTED_STATES = frozenset({VERIFIED})

TUPLE_VERIFIED = "verified"
TUPLE_UNRECORDED = "unrecorded"
TUPLE_MISMATCH = "mismatch"


@dataclass
class Check:
    name: str
    ok: bool | None
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "ok": self.ok, "detail": self.detail}


@dataclass
class Identity:
    state: str
    pane_id: str | None
    workspace_id: str | None
    checks: list[Check] = dc_field(default_factory=list)
    disagreements: list[str] = dc_field(default_factory=list)
    session: session.SessionView | None = None
    session_source: str | None = None
    session_id: str | None = None
    pin_path: str | None = None
    pin_reporter_pid: int | None = None
    pil: dict[str, Any] | None = None
    proc: procfs.ProcInfo | None = None
    env: dict[str, str] = dc_field(default_factory=dict)
    tuple_state: str = TUPLE_UNRECORDED
    note: str | None = None

    @property
    def trusted(self) -> bool:
        return (
            self.state in TRUSTED_STATES
            and self.session is not None
            and not self.disagreements
            and self.tuple_state != TUPLE_MISMATCH
        )

    @property
    def trusted_session_id(self) -> str | None:
        return self.session_id if self.trusted else None

    def untrusted_reason(self) -> str | None:
        if self.trusted:
            return None
        if self.state in (PID_DISAGREEMENT, TUPLE_DISAGREEMENT, ENVPANE_DISAGREEMENT,
                          PANE_DISAGREEMENT):
            return self.state
        if self.disagreements:
            return "witness_disagreement:" + ",".join(sorted(self.disagreements))
        if self.tuple_state == TUPLE_MISMATCH:
            return "process_tuple_mismatch"
        if self.session is None:
            return "no_validated_session"
        return self.state

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "pane_id": self.pane_id,
            "workspace_id": self.workspace_id,
            "trusted": self.trusted,
            "session_id": self.session_id,
            "session_source": self.session_source,
            "pin_path": self.pin_path,
            "pin_reporter_pid": self.pin_reporter_pid,
            "pil_record": self.pil,
            "proc": self.proc.to_dict() if self.proc else None,
            "process_tuple": self.tuple_state,
            "checks": [c.to_dict() for c in self.checks],
            "disagreements": self.disagreements,
            "untrusted_because": self.untrusted_reason(),
            "note": self.note,
        }


class PilAccess:
    """Admission-gated access to one lane's pil record. Never walks the directory.

    ``pil_dir`` is listed nowhere: the caller supplies the lane's *name hint* (a handle from
    the rooms pin registry) and the pane, and exactly one candidate path is opened. The record
    is accepted only when its ``paneId`` equals the pane; a mismatch is reported, not used.
    """

    def __init__(self, directory: str | None, policy: guard.Policy):
        self.directory = directory
        self.policy = policy
        self.opened: list[str] = []
        self.rejected: list[str] = []
        self.errors: list[str] = []

    def record_for(self, pane_id: str | None, name_hint: str | None, workspace_id: str | None,
                   tab_id: str | None) -> tuple[dict[str, Any] | None, str | None]:
        if not self.directory:
            return None, "pil_directory_unknown"
        if not pane_id:
            return None, "no_pane_id"
        # Admission is re-checked here so this function cannot be a bypass even if a caller
        # forgets it. A denied lane never reaches the open below.
        admitted, reason = self.policy.admit_lane(workspace_id, pane_id, tab_id)
        if not admitted:
            self.rejected.append(f"{pane_id}:{reason}")
            return None, f"denied:{reason}"
        if not name_hint or "/" in name_hint or "\\" in name_hint or name_hint.startswith("."):
            return None, "no_usable_pil_name_hint"
        path = os.path.join(self.directory, f"{name_hint}.json")
        if not os.path.exists(path):
            return None, "no_pil_record_for_name_hint"
        self.opened.append(path)
        try:
            record = guard.read_json(path, self.policy, "pil-record")
        except (OSError, ValueError, guard.DeniedRead) as exc:
            self.errors.append(f"{os.path.basename(path)}:{exc.__class__.__name__}")
            return None, "pil_record_unreadable"
        if not isinstance(record, dict):
            return None, "pil_record_not_an_object"
        if record.get("paneId") != pane_id:
            # A name hint that resolves to a different pane is not this lane's record.
            self.rejected.append(f"{pane_id}:pane_mismatch")
            return None, "pil_record_pane_mismatch"
        return record, None


def safe_proc_root(proc_root: str | None) -> bool:
    return bool(proc_root) and os.path.isdir(proc_root)


def _candidate_checks(
    path: str,
    *,
    policy: guard.Policy,
    loader: Callable[[str, guard.Policy], session.SessionView],
    expected_id: str | None,
    label: str,
) -> tuple[session.SessionView | None, list[Check], list[str]]:
    checks: list[Check] = []
    problems: list[str] = []
    if not os.path.exists(path):
        checks.append(Check(f"{label}.exists", False, "path does not exist"))
        problems.append("path_missing")
        return None, checks, problems
    checks.append(Check(f"{label}.exists", True, util.realpath(path)))
    try:
        view = loader(path, policy)
    except (OSError, guard.DeniedRead) as exc:
        checks.append(Check(f"{label}.readable", False, exc.__class__.__name__))
        problems.append("read_failed")
        return None, checks, problems
    checks.append(Check(f"{label}.readable", True, f"{view.bytes_read} bytes"))
    ident = view.identity_checks()
    if view.header_id is None:
        checks.append(Check(f"{label}.header_id", False, "no session header id"))
        problems.append("no_header_id")
    elif ident["header_matches_filename"]:
        checks.append(Check(f"{label}.header_id", True, "header id == filename uuid"))
    else:
        checks.append(Check(f"{label}.header_id", False,
                            f"header {view.header_id} != filename uuid {ident['filename_uuid']}"))
        problems.append("header_filename_mismatch")
    if expected_id and view.header_id and view.header_id.lower() != expected_id.lower():
        checks.append(Check(f"{label}.expected_id", False,
                            f"expected {expected_id}, found {view.header_id}"))
        problems.append("expected_id_mismatch")
    elif expected_id:
        checks.append(Check(f"{label}.expected_id", True, f"== {expected_id}"))
    if view.chain_state != session.CHAIN_OK:
        problems.append(f"chain_{view.chain_state}")
        checks.append(Check(f"{label}.active_branch", False, view.chain_state))
    else:
        checks.append(Check(
            f"{label}.active_branch", True,
            f"leaf={view.leaf_id} ({view.leaf_source}), {len(view.chain)} entries on chain "
            f"of {len(view.entries)} in file"))
    return view, checks, problems


def _check_process(
    identity: Identity,
    *,
    proc_root: str,
    pane_id: str | None,
    tab_id: str | None,
    workspace_id: str | None,
    policy: guard.Policy,
) -> None:
    """Observed tuple, envpane and expected-tuple comparison. All disagreements untrust."""
    pid = identity.pin_reporter_pid or (
        identity.pil.get("pid") if identity.pil and isinstance(identity.pil.get("pid"), int) else None
    )
    if not safe_proc_root(proc_root):
        identity.checks.append(Check(
            "proc.triple", None,
            "not read: host /proc is disabled by default (pass --proc-root to enable)"))
        return None
    if not pid:
        identity.checks.append(Check("proc.triple", None, "no pid in pin or pil record"))
        return None

    proc = procfs.read_stat(pid, policy, proc_root)
    identity.proc = proc
    identity.checks.append(Check(
        "proc.triple", proc.available and proc.triple is not None,
        proc.to_dict()["triple"] or (proc.error or "unavailable")))
    if not proc.available:
        return None

    identity.env = procfs.read_env(pid, policy, proc_root)

    # envpane: the process's own view of which pane it belongs to.
    env_pane = identity.env.get("HERDR_PANE_ID")
    if env_pane is None:
        identity.checks.append(Check("proc.envpane", None, "HERDR_PANE_ID not in the process env"))
    elif pane_id and env_pane != pane_id:
        identity.disagreements.append(f"envpane={env_pane} != pane={pane_id}")
        identity.checks.append(Check("proc.envpane", False, f"{env_pane} != {pane_id}"))
        identity.state = ENVPANE_DISAGREEMENT
    else:
        identity.checks.append(Check("proc.envpane", True, f"{env_pane}"))

    env_ws = identity.env.get("HERDR_WORKSPACE_ID")
    if env_ws is not None and workspace_id and env_ws != workspace_id:
        identity.disagreements.append(f"envworkspace={env_ws} != workspace={workspace_id}")
        identity.checks.append(Check("proc.envworkspace", False, f"{env_ws} != {workspace_id}"))
        identity.state = ENVPANE_DISAGREEMENT
    env_tab = identity.env.get("HERDR_TAB_ID")
    if env_tab is not None and tab_id and env_tab != tab_id:
        identity.disagreements.append(f"envtab={env_tab} != tab={tab_id}")
        identity.checks.append(Check("proc.envtab", False, f"{env_tab} != {tab_id}"))
        identity.state = ENVPANE_DISAGREEMENT

    # expected tuple, when the lane's own record kept one
    pil = identity.pil or {}
    expected_boot = pil.get("boot_id") if isinstance(pil.get("boot_id"), str) else None
    expected_start = pil.get("starttime") if isinstance(pil.get("starttime"), int) else None
    if expected_boot is None and expected_start is None:
        identity.tuple_state = TUPLE_UNRECORDED
        identity.checks.append(Check(
            "proc.tuple_expected", None,
            "the lane record does not record boot_id/starttime, so the tuple cannot be "
            "cross-checked; treat as unrecorded, not verified"))
    else:
        ok = True
        if expected_boot is not None and proc.boot_id is not None and expected_boot != proc.boot_id:
            ok = False
            identity.disagreements.append(f"boot={proc.boot_id} != recorded={expected_boot}")
        if expected_start is not None and proc.starttime is not None and expected_start != proc.starttime:
            ok = False
            identity.disagreements.append(
                f"starttime={proc.starttime} != recorded={expected_start}")
        identity.tuple_state = TUPLE_VERIFIED if ok else TUPLE_MISMATCH
        identity.checks.append(Check(
            "proc.tuple_expected", ok,
            "recorded boot_id/starttime match the observed process" if ok
            else "recorded boot_id/starttime differ from the observed process"))
        if not ok:
            identity.state = TUPLE_DISAGREEMENT
    return None


def resolve(
    agent: dict[str, Any],
    *,
    policy: guard.Policy,
    pil: PilAccess,
    proc_root: str,
    loader: Callable[[str, guard.Policy], session.SessionView] = lambda p, pol: session.load(p, pol),
    leaf_hint: str | None = None,
    name_hint: str | None = None,
) -> Identity:
    pane_id = agent.get("pane_id") if isinstance(agent.get("pane_id"), str) else None
    workspace_id = agent.get("workspace_id") if isinstance(agent.get("workspace_id"), str) else None
    tab_id = agent.get("tab_id") if isinstance(agent.get("tab_id"), str) else None
    identity = Identity(state=NO_SESSION, pane_id=pane_id, workspace_id=workspace_id)

    # Defence in depth: not even a direct caller can make resolve() read a denied lane.
    admitted, deny_reason = policy.admit_lane(workspace_id, pane_id, tab_id)
    if not admitted:
        identity.state = HELD
        identity.note = f"denied before any read: {deny_reason}"
        identity.checks.append(Check("admission", False, str(deny_reason)))
        return identity

    for label, value, check in (("pane", pane_id, guard.is_pane_id),
                                ("tab", tab_id, guard.is_tab_id),
                                ("workspace", workspace_id, guard.is_workspace_id)):
        if value is not None and not check(value):
            identity.disagreements.append(f"malformed_{label}_id")
            identity.checks.append(Check(f"id.{label}", False, f"{value!r} is not a {label} id"))

    pin = agent.get("agent_session") if isinstance(agent.get("agent_session"), dict) else {}
    pin_path = pin.get("value") if isinstance(pin.get("value"), str) else None
    reporter_pid = pin.get("reporter_pid") if isinstance(pin.get("reporter_pid"), int) else None
    identity.pin_path = pin_path
    identity.pin_reporter_pid = reporter_pid
    pin_uuid = util.session_uuid_from_filename(pin_path) if pin_path else None

    pin_view = None
    pin_problems: list[str] = []
    if pin_path:
        pin_view, checks, pin_problems = _candidate_checks(
            pin_path, policy=policy, loader=loader, expected_id=pin_uuid, label="pin")
        identity.checks.extend(checks)
        if pin.get("seq") is not None:
            identity.checks.append(Check("pin.seq", True, f"seq={pin.get('seq')}"))
    else:
        identity.checks.append(Check("pin.exists", None, "snapshot has no agent_session pin"))

    record, record_problem = pil.record_for(pane_id, name_hint, workspace_id, tab_id)
    identity.pil = (
        {
            "file": os.path.join(pil.directory or "", f"{name_hint}.json") if name_hint else None,
            "lane": record.get("lane"),
            "session": record.get("session"),
            "sessionId": record.get("sessionId"),
            "paneId": record.get("paneId"),
            "workspaceId": record.get("workspaceId"),
            "pid": record.get("pid"),
            "boot_id": record.get("boot_id"),
            "starttime": record.get("starttime"),
            "updatedAt": record.get("updatedAt"),
            "source": record.get("source"),
            "lookup": "pane-matched record via admitted lane name hint (no directory scan)",
        }
        if record
        else None
    )
    identity.checks.append(Check(
        "pil.lookup", bool(record),
        f"paneId={pane_id} -> {record_problem or 'matched'}"))
    if record:
        if record.get("workspaceId") and workspace_id and record["workspaceId"] != workspace_id:
            identity.disagreements.append("pil_workspace_mismatch")
            identity.checks.append(Check("pil.workspaceId", False,
                                         f"{record['workspaceId']} != {workspace_id}"))
        if record.get("tabId") and tab_id and record["tabId"] != tab_id:
            identity.disagreements.append("pil_tab_mismatch")
            identity.checks.append(Check("pil.tabId", False, f"{record['tabId']} != {tab_id}"))

    record_view = None
    record_problems: list[str] = []
    record_path = record.get("session") if record and isinstance(record.get("session"), str) else None
    if record_path:
        record_view, checks, record_problems = _candidate_checks(
            record_path, policy=policy, loader=loader,
            expected_id=record.get("sessionId") if isinstance(record.get("sessionId"), str) else None,
            label="pil")
        identity.checks.extend(checks)

    pin_valid = pin_view is not None and not pin_problems
    record_valid = record_view is not None and not record_problems
    pin_id = pin_view.header_id if pin_view else None
    record_id = record_view.header_id if record_view else None
    agree = bool(pin_valid and record_valid and pin_id and record_id
                 and pin_id.lower() == record_id.lower())

    if pin_valid and record_valid and agree:
        identity.session = pin_view
        identity.session_source = "herdr agent_session pin (validated, agrees with the lane record)"
        identity.state = VERIFIED
    elif pin_valid and record_valid:
        identity.session = record_view
        identity.session_source = "lane record (validated) after a stale pin"
        identity.state = PIN_STALE_USED_PIL
        identity.disagreements.append(f"pin_session={pin_id} != record_session={record_id}")
        identity.checks.append(Check("pin.vs_pil", False,
                                     f"pin {pin_id} != record {record_id}; pin treated as stale"))
        identity.note = ("pin and lane record name different sessions; the pin is the documented "
                         "stale one after /new or /resume, and the disagreement is reported.")
    elif pin_valid and not record_valid:
        # A pin alone is not ownership: no independent witness agrees with it.
        identity.session = pin_view
        identity.session_source = "herdr agent_session pin (validated file, no independent witness)"
        identity.state = PIN_ONLY_UNVERIFIED
        identity.note = ("pin file is self-consistent but nothing else witnesses it "
                         f"({record_problem or 'no lane record'}); not trusted for joins")
    elif record_valid:
        identity.session = record_view
        identity.session_source = "lane record (validated); pin missing or invalid"
        identity.state = PIN_MISSING_USED_PIL if not pin_path else PIN_STALE_USED_PIL
        identity.note = ("no usable reporter pin; identity rests on the pane-matched lane record "
                         "and the process checks")
    elif pin_path:
        identity.state = PIN_STALE_NO_FALLBACK
        identity.note = "pin invalid and no usable lane record: refusing to guess another session."
    else:
        identity.state = NO_SESSION
        identity.note = "no pin and no usable lane record."

    if identity.session is not None:
        identity.session_id = identity.session.header_id
    if record and isinstance(record.get("sessionId"), str) and identity.session_id:
        if record["sessionId"].lower() != identity.session_id.lower():
            identity.disagreements.append("pil_sessionId_differs_from_validated_session")

    _check_process(identity, proc_root=proc_root, pane_id=pane_id, tab_id=tab_id,
                   workspace_id=workspace_id, policy=policy)

    # pid agreement across witnesses
    pil_pid = identity.pil.get("pid") if identity.pil else None
    if identity.proc and identity.proc.available and reporter_pid and isinstance(pil_pid, int):
        if pil_pid != reporter_pid:
            identity.disagreements.append(f"reporter_pid={reporter_pid} != pil_pid={pil_pid}")
            identity.checks.append(Check("proc.reporter_vs_pil_pid", False,
                                         f"{reporter_pid} != {pil_pid}"))
            if identity.state == VERIFIED:
                identity.state = PID_DISAGREEMENT
        elif identity.proc.pid != reporter_pid:
            identity.disagreements.append(f"proc_pid={identity.proc.pid} != reporter_pid={reporter_pid}")
            identity.checks.append(Check("proc.pid_witness", False,
                                         f"{identity.proc.pid} != {reporter_pid}"))
            if identity.state == VERIFIED:
                identity.state = PID_DISAGREEMENT
        else:
            identity.checks.append(Check("proc.reporter_vs_pil_pid", True, f"both {reporter_pid}"))

    # Downgrade to unverified when no independent witness agreed at all.
    if identity.state == VERIFIED and not (record or (identity.proc and identity.proc.available)):
        identity.state = PIN_ONLY_UNVERIFIED

    return identity
