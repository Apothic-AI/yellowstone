"""Behold-owned SQLite cache: sanitized runtime state and sanitized topology.

The cache is a **derived, disposable** store. It is not a source of truth about the fleet:
every row carries the moment it was observed, a monotonic sequence number and a sha256 of
the payload, and every read says how old the value is. If the file is deleted, nothing is
lost — the roster re-derives everything from the stores on disk.

Three writers, one reader contract:

* the **pi extension** (``pi-extension/behold-state.ts``) reports the *runtime* facts it can
  see in memory (model, thinking level, idle, context usage) through a tiny spool
  protocol: one JSON document per pane in the inbox directory;
* the **CLI** writes the **topology** it captured from herdr;
* the roster reads both back and reports their **freshness**, never their truth.

Rules that are enforced in code, not promised in prose:

* **Allowlisted fields only.** :func:`sanitize_state` keeps a fixed set of flat keys and
  drops everything else *before* the value reaches the database. A prompt, a message body,
  a tool argument, a credential, a skill body, a room body or a bead note cannot enter the
  cache even if a writer sends one.
* **Explicit schema.** :data:`SCHEMA_VERSION` is written to ``cache_meta`` and to the
  SQLite ``user_version`` pragma. A database with a different version is **refused**
  (:class:`CacheError`), never silently migrated or half-upgraded.
* **Atomic upserts.** One ``BEGIN IMMEDIATE`` transaction per write. A write whose
  sequence number is not newer than the stored one is refused as ``stale_rejected``; the
  stored row is left alone.
* **Incarnation and ownership.** A row belongs to a pane, to a session and to the
  **incarnation** that observed it (the reporting process: its boot id, its pid and its
  start time). Ordering is by *incarnation*, never by the wall clock: an incarnation that
  started later owns the pane, an incarnation that started earlier may not take it back,
  and a write whose order cannot be established is **refused**
  (``ambiguous_incarnation``) rather than guessed.
* **Identity.** A row belongs to a pane and a session. A reader that expects a different
  session id gets ``identity_mismatch`` — never a value from the wrong session.
* **Bounded.** One current row per pane, plus a bounded history of retired rows
  (:data:`HISTORY_ROWS_PER_PANE` per pane, :data:`HISTORY_MAX_ROWS` in total). The
  summary counts **current rows**, not history, so it stays true as lanes restart.
* **No session-file writes.** Nothing in this module opens, appends to or rewrites a pi
  session file. The cache is a separate file in a separate directory.
* **Freshness vocabulary.** ``fresh`` / ``stale`` / ``absent`` / ``identity_mismatch`` /
  ``unreadable``. "Stale" means *older than the freshness window*, never "wrong".
* **Freshness is not liveness.** A fresh observation says the reporter *wrote* recently;
  it does not say the lane is alive now. The record carries no liveness proof, and this
  module does not invent one.

The SQLite writes happen in C, inside the ``sqlite3`` module, and are therefore **not
visible to the in-process audit hook** that guards the rest of behold. The hook cannot be
the boundary for this file: the boundary is the *path policy* (one configured cache path,
never a fleet store path) plus the narrow write scope in :mod:`behold.guard`. See the
"Known limitations" section of ``README.md``.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from dataclasses import dataclass, field as dc_field
from typing import Any, Mapping

from . import admission
from . import guard

#: Version of the cache schema. Bump it when the shape of a table changes.
#:
#: Version 2 replaced the ``(pane_id, session_id)`` key with **one current row per
#: pane** (the pane's owning incarnation and its last observation) plus a bounded
#: history of retired rows, and it added the incarnation columns the ownership rule
#: needs. A version 1 database is **migrated** (see :meth:`Cache._ensure_schema`); any
#: other version is refused.
SCHEMA_VERSION = 2

#: Schema versions this build knows how to migrate from.
MIGRATABLE_FROM = (1,)

#: Version of the spool record the pi extension writes. Independent of the schema version:
#: the record format is the wire format, the schema version is the storage format.
#:
#: Version 2 added the incarnation, the per-incarnation sequence number and the tab id,
#: so that ownership and a reserved tab can both be decided **before** a record is read.
STATE_RECORD_VERSION = 2

#: Retired rows kept per pane. A lane that restarts leaves one retired row behind; eight
#: is enough to see the recent history and small enough that the file does not grow with
#: the fleet's uptime.
HISTORY_ROWS_PER_PANE = 8

#: Retired rows kept in total, whatever the fleet size. The oldest go first.
HISTORY_MAX_ROWS = 5000

#: Two boot epochs closer than this cannot be ordered against each other, so a record
#: from a different boot is refused rather than believed.
BOOT_EPOCH_AMBIGUITY_S = 60.0

#: The reporter's wall clock and its monotone clock disagreeing by more than this means
#: the clock moved. The observation is then reported as unknown, not as fresh.
CLOCK_SKEW_LIMIT_S = 60.0

#: Default cache directory and file.
DEFAULT_STATE_DIR = "~/.local/state/behold"
DEFAULT_DB_NAME = "behold.db"

#: Environment override for the database path.
CACHE_PATH_ENV = "BEHOLD_CACHE_DB"

#: Directory (beside the database) the pi extension spools its records into.
INBOX_DIRNAME = "inbox"

#: The file the CLI publishes for the reporter: the admission map, so a reporter never
#: writes a record for a lane the roster would refuse. It is Behold's own state, beside
#: the cache, not a settings file.
DENY_FILE_NAME = admission.ADMISSION_FILE_NAME
DENY_FILE_VERSION = admission.ADMISSION_VERSION

#: Default freshness window in seconds. A cached value older than this is ``stale``.
DEFAULT_FRESHNESS_S = 120.0

#: SQLite busy timeout in milliseconds: concurrent writers wait instead of failing.
BUSY_TIMEOUT_MS = 5000

# --- freshness vocabulary ----------------------------------------------------------------

FRESH = "fresh"
STALE = "stale"
ABSENT = "absent"
IDENTITY_MISMATCH = "identity_mismatch"
UNREADABLE = "unreadable"
#: The observation's timestamp cannot be trusted: the clock moved (backwards, or away
#: from the reporter's monotone clock). Its age is unknown, so it is neither fresh nor
#: stale -- it is disputed.
CLOCK_DISPUTED = "clock_disputed"

FRESHNESS_STATES = (FRESH, STALE, ABSENT, IDENTITY_MISMATCH, UNREADABLE, CLOCK_DISPUTED)

# --- the state allowlist -----------------------------------------------------------------

#: The only keys a pi-state record may carry, and the type each one must have. Anything
#: not in this table is dropped by :func:`sanitize_state` before it can reach a row.
#: The list is deliberately flat and scalar: a nested document is a place for content to
#: hide, and nothing here needs one.
#:
#: The herdr entries are **identity handles** — the pane, workspace and tab ids the lane
#: was launched with. They are already public in the roster (``H-2``/``H-3``, privacy 0)
#: and the roster needs them to apply its deny policy to a record. The herdr *socket path*
#: and the env flag are environment values with no join value: they are NOT stored.
ALLOWED_STATE_KEYS: dict[str, str] = {
    "model_id": "str",
    "model_provider": "str",
    "thinking_level": "str",
    "idle": "bool",
    "pending_messages": "bool",
    "context_tokens": "int",
    "context_window": "int",
    "context_percent": "float",
    "session_file": "str",
    "leaf_entry_id": "str",
    "cwd": "str",
    "herdr_pane_id": "str",
    "herdr_workspace_id": "str",
    "herdr_tab_id": "str",
    "system_prompt_length": "int",
    "system_prompt_sha256": "str",
}

#: The observation fields the reporter is expected to provide. A field that is missing from
#: a record is reported as **unavailable** with this reason — the reader never invents a
#: value for a field the reporter did not see.
EXPECTED_OBSERVATIONS: dict[str, str] = {
    "model_id": "the reporter did not observe a model",
    "model_provider": "the reporter did not observe a model provider",
    "thinking_level": "the reporter did not observe a thinking level",
    "idle": "the reporter did not observe the streaming state",
    "pending_messages": "the reporter did not observe the queue state",
    "context_tokens": "the reporter did not observe the context usage",
    "context_window": "the reporter did not observe the context window",
    "context_percent": "the reporter did not observe the context usage",
    "session_file": "the reporter did not observe the session file",
    "leaf_entry_id": "the reporter did not observe the session leaf",
    "cwd": "the reporter did not observe the working directory",
    "herdr_pane_id": "the reporter did not observe the pane id",
    "herdr_workspace_id": "the reporter did not observe the workspace id",
    "herdr_tab_id": "the reporter did not observe the tab id",
    "system_prompt_length": "the reporter did not observe the system prompt",
    "system_prompt_sha256": "the reporter did not observe the system prompt",
}

#: Observation fields the reporter **cannot** provide at all, with the reason. They are
#: reported as unavailable (UNKNOWN) for every lane — never as a value, and never as
#: "not observed", which would blame the reporter for a gap that is not its fault.
UNAVAILABLE_OBSERVATIONS: dict[str, str] = {
    "agent_status": ("pi exposes only isIdle(); herdr's working/blocked agent status is "
                     "not visible to an extension"),
    "ttft_ms": "pi does not expose time-to-first-token",
    "herdr_socket_path": "environment value; not stored under the counts-and-paths rule",
    "herdr_env": "environment value; not stored under the counts-and-paths rule",
    "room_presence": "rooms presence is not exposed by the extension API",
    "bead_counts": "the beads export is not exposed to an extension",
}

# --- the topology allowlist --------------------------------------------------------------

#: Per-record allowlist for the captured herdr topology. The cached topology is the same
#: data the roster already prints (handles, labels, status, paths); nothing else is kept.
_TOPOLOGY_FIELDS: dict[str, dict[str, str]] = {
    "agents": {
        "pane_id": "str",
        "workspace_id": "str",
        "tab_id": "str",
        "agent": "str",
        "name": "str",
        "display_agent": "str",
        "cwd": "str",
        "foreground_cwd": "str",
        "agent_status": "str",
        "state_change_seq": "int",
        "completion_seq": "int",
        "interactive_ready": "int",
        "restore_error": "str",
        "terminal_title_stripped": "str",
    },
    "panes": {
        "pane_id": "str",
        "workspace_id": "str",
        "tab_id": "str",
        "agent_status": "str",
        "label": "str",
        "state_change_seq": "int",
        "completion_seq": "int",
        "interactive_ready": "int",
        "restore_error": "str",
    },
    "workspaces": {
        "workspace_id": "str",
        "label": "str",
        "number": "int",
        "tab_count": "int",
        "pane_count": "int",
        "focused": "bool",
        "agent_status": "str",
    },
    "tabs": {
        "tab_id": "str",
        "workspace_id": "str",
        "label": "str",
    },
}

#: Nested objects in the topology, each reduced to its own scalar allowlist.
_TOPOLOGY_NESTED: dict[str, dict[str, dict[str, str]]] = {
    "agents": {
        "agent_session": {"value": "str", "reporter_pid": "int", "seq": "int"},
    },
    "workspaces": {
        "worktree": {
            "checkout_path": "str",
            "is_linked_worktree": "bool",
            "repo_root": "str",
            "repo_name": "str",
            "repo_key": "str",
        },
        "tokens": {"jj_bookmark": "any"},
    },
}


class CacheError(Exception):
    """The cache exists but cannot be used as-is (schema mismatch, unreadable file)."""


def _is_pane_id(value: object) -> bool:
    """Is this a well-formed pane id? The guard owns the pattern; the cache asks it."""
    from . import guard

    return guard.is_pane_id(value)


def _denied(policy: Any, pane_id: str, tab_id: str | None = None,
            workspace_id: str | None = None) -> bool:
    """Is this lane refused by the roster's policy?

    The workspace is derived from the pane id when the record does not carry it: the
    pane id is ``<workspace>:<pane>``, so the prefix is the workspace. The policy is
    asked, not re-implemented: one deny list, one answer.
    """
    if workspace_id is None and isinstance(pane_id, str) and ":" in pane_id:
        workspace_id = pane_id.split(":", 1)[0]
    admitted, _reason = policy.admit_lane(workspace_id, pane_id, tab_id)
    return not admitted


def default_db_path() -> str:
    """``$BEHOLD_CACHE_DB`` when set, else ``~/.local/state/behold/behold.db``."""
    override = os.environ.get(CACHE_PATH_ENV, "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    return os.path.abspath(os.path.expanduser(os.path.join(DEFAULT_STATE_DIR, DEFAULT_DB_NAME)))


def inbox_dir_for(db_path: str) -> str:
    """The spool directory that belongs to a database path."""
    return os.path.join(os.path.dirname(os.path.abspath(db_path)), INBOX_DIRNAME)


def pane_digest(pane_id: str) -> str:
    """Stable short digest of a pane id. Kept for reference and for the legacy name."""
    return hashlib.sha256(pane_id.encode("utf-8")).hexdigest()[:16]


def _safe_component(value: str) -> str:
    """A filesystem-safe, reversible spelling of a handle.

    Only ``:`` and other punctuation is folded to ``_``; letters and digits survive, so
    ``w1A:p1`` becomes ``w1A_p1`` and back. A pane id that does not match the guard's own
    pattern never gets that far: the ingest refuses it.
    """
    return "".join(ch if (ch.isalnum() or ch in "._-") else "_" for ch in value)


def spool_file_name(pane_id: str, tab_id: str | None = None,
                    incarnation: str | None = None, seq: int | None = None) -> str:
    """The spool file name for a pane.

    The name carries the pane id in a reversible, filesystem-safe form, and the tab id
    when the reporter knows it. Both are deliberate: the ingest applies the admission
    map to the **name** first, so a held workspace's, a reserved pane's or a reserved
    tab's record is refused without being read. The pane id is public metadata in the
    roster (``H-3``), and the inbox is Behold's own directory.

    When the incarnation and the sequence number are given, they go into the name too.
    That makes **every write its own file**, and a name is never reused: two reporters
    for the same pane never touch the same pathname, so there is no read-modify-write
    window in which the older one wins, and the ingest may unlink a file it has read
    without the risk of destroying a newer record for the same pane.
    """
    base = f"pane-{_safe_component(pane_id)}"
    if tab_id:
        base += f".tab-{_safe_component(tab_id)}"
    if incarnation and isinstance(seq, int) and not isinstance(seq, bool):
        base += f".inc-{_safe_component(incarnation)}.s{seq}"
    return base + ".json"


def spool_file_parts(name: str) -> tuple[str | None, str | None, str | None, int | None]:
    """The pane, tab, incarnation and sequence number a spool file's name carries.

    The incarnation is returned in its **folded** form (the same spelling the name
    uses), not unfolded: the record's own incarnation is folded the same way before the
    two are compared, so no assumption about which characters a handle may contain is
    needed.
    """
    if not name.startswith("pane-") or not name.endswith(".json"):
        return None, None, None, None
    body = name[len("pane-"):-len(".json")]
    incarnation: str | None = None
    seq: int | None = None
    marker = ".inc-"
    index = body.find(marker)
    if index >= 0:
        tail = body[index + len(marker):]
        body = body[:index]
        seq_marker = tail.rfind(".s")
        if seq_marker > 0:
            digits = tail[seq_marker + len(".s"):]
            if digits.isdigit():
                incarnation = tail[:seq_marker]
                seq = int(digits)
            else:
                incarnation = tail
        else:
            incarnation = tail
    tab_id: str | None = None
    marker = ".tab-"
    index = body.find(marker)
    if index >= 0:
        tab_part = body[index + len(marker):]
        body = body[:index]
        tab_id = tab_part.replace("_", ":") or None
    pane_id = body.replace("_", ":") or None
    return pane_id, tab_id, incarnation, seq


def pane_and_tab_from_spool_name(name: str) -> tuple[str | None, str | None]:
    """Recover the pane id (and the tab id, when the name carries one) from a name.

    The round trip is exact for the ids the guard accepts (``w<alnum>:p<alnum>`` and
    ``w<alnum>:t<alnum>``): those contain no ``_``, so folding ``:`` to ``_`` is
    reversible. A name written by the previous record version carries no tab, and is
    read as ``(pane, None)`` -- the admission map then supplies the tab.
    """
    pane_id, tab_id, _incarnation, _seq = spool_file_parts(name)
    return pane_id, tab_id


def pane_id_from_spool_name(name: str) -> str | None:
    """Recover the pane id from a spool file name, or ``None`` when it is not one."""
    return pane_and_tab_from_spool_name(name)[0]


def _compare_incarnations(left: Mapping[str, Any], right: Mapping[str, Any]) -> int | None:
    """Is ``left`` newer than ``right``? ``1``, ``-1``, or ``None``.

    ``None`` means the two **cannot be ordered**, which is not the same as "equal":
    two incarnations from different boots whose boot epochs are closer than the
    ambiguity window are refused rather than guessed at. Two records of the same
    incarnation are ordered by their sequence number instead, and are reported as
    equal here (``0``).
    """
    if left.get("incarnation") == right.get("incarnation"):
        return 0
    left_boot = str(left.get("boot_id") or "")
    right_boot = str(right.get("boot_id") or "")
    left_ticks = int(left.get("start_ticks") or 0)
    right_ticks = int(right.get("start_ticks") or 0)
    if left_boot and left_boot == right_boot:
        if left_ticks > right_ticks:
            return 1
        if left_ticks < right_ticks:
            return -1
        return None
    left_epoch = float(left.get("boot_epoch") or 0.0)
    right_epoch = float(right.get("boot_epoch") or 0.0)
    if left_epoch and right_epoch:
        delta = left_epoch - right_epoch
        if delta > BOOT_EPOCH_AMBIGUITY_S:
            return 1
        if delta < -BOOT_EPOCH_AMBIGUITY_S:
            return -1
    return None


def _choose_owner(records: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, str]:
    """The record that owns the pane, or ``None`` when the order cannot be decided.

    The newest incarnation owns the pane; within one incarnation the highest sequence
    number is the observation. If two incarnations cannot be ordered against each
    other, **nothing** is stored for that pane: an ambiguous order is refused, not
    guessed at.
    """
    if not records:
        return None, "no_record"
    best = records[0]
    for record in records[1:]:
        order = _compare_incarnations(record, best)
        if order is None:
            return None, "ambiguous_incarnation"
        if order > 0:
            best = record
    for record in records:
        if record.get("incarnation") == best.get("incarnation"):
            continue
        order = _compare_incarnations(best, record)
        if order is None or order <= 0:
            return None, "ambiguous_incarnation"
    same = [r for r in records if r.get("incarnation") == best.get("incarnation")]
    return max(same, key=lambda r: int(r.get("seq") or 0)), ""


def _prune_spool_file(path: str) -> bool:
    """Remove a superseded spool file. ``True`` when it is gone.

    The file's name is unique per (incarnation, sequence number) and is never reused,
    so unlinking it cannot destroy a newer record for the same lane. The one thing
    that can be lost is a record the reader would have refused anyway.
    """
    try:
        os.unlink(path)
        return True
    except OSError:
        return False


def deny_file_path(db_path: str) -> str:
    """Where the admission map is published for the reporter."""
    return admission.admission_path(db_path)


def write_deny_file(db_path: str, admission_map: Any) -> str:
    """Publish the effective admission map beside the cache, for the reporter.

    The reporter cannot know Behold's deny list, so the roster publishes it. A reporter
    that honors the file never writes a record for a held or reserved lane; the ingest
    refuses such a record anyway, so the file is a courtesy, not the boundary.
    """
    return admission.publish(deny_file_path(db_path), admission_map)


def read_deny_file(path: str, *, now: float | None = None) -> Any:
    """Read the published admission map, or raise :class:`behold.admission.AdmissionError`.

    A missing, unreadable, malformed, wrong-version or stale map **raises**: the caller
    must not treat it as an empty one. "I could not establish admission" is not
    "admit".
    """
    return admission.load(path, now=now)


def observation_gaps(observed: Mapping[str, Any] | None) -> list[dict[str, str]]:
    """The observation fields that are unavailable, each with the reason.

    Two kinds, and they are not the same thing:

    * ``not_available`` — the reporter **cannot** see it at all (a gap in pi's extension
      API, or a field that is deliberately not stored). Reported for every lane.
    * ``not_observed`` — the reporter could see it but did not report it this time.

    Neither is ever turned into a value, and neither is reported as "complete".
    """
    seen = observed if isinstance(observed, Mapping) else {}
    gaps = [{"field": name, "reason": reason, "kind": "not_available"}
            for name, reason in sorted(UNAVAILABLE_OBSERVATIONS.items())]
    for name, reason in sorted(EXPECTED_OBSERVATIONS.items()):
        if name not in seen:
            gaps.append({"field": name, "reason": reason, "kind": "not_observed"})
    return gaps


def canonical_json(value: Any) -> str:
    """Stable JSON text: sorted keys, no incidental whitespace."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_of(value: Any) -> str:
    """sha256 over the canonical JSON of a value."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _coerce(kind: str, value: Any) -> Any | None:
    """Coerce a value to an allowlisted type, or drop it.

    ``bool`` is checked before ``int``: in Python ``True`` is an ``int``, and a boolean
    that arrived as a token count is a bug, not a zero.
    """
    if value is None:
        return None
    if kind == "any":
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return None
    if kind == "str":
        return value if isinstance(value, str) else None
    if kind == "bool":
        return value if isinstance(value, bool) else None
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value
    if kind == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value)
    return None


def sanitize_state(state: Mapping[str, Any] | None) -> dict[str, Any]:
    """Reduce a state payload to the allowlisted scalar keys.

    Everything else is dropped: unknown keys, nested structures, wrong types. This is the
    single funnel every writer goes through, so a writer that sends a prompt body cannot
    get it into the cache.
    """
    out: dict[str, Any] = {}
    if not isinstance(state, Mapping):
        return out
    for key, kind in ALLOWED_STATE_KEYS.items():
        if key not in state:
            continue
        coerced = _coerce(kind, state[key])
        if coerced is not None:
            out[key] = coerced
    return out


def _canonical(value: Any, checker: Any) -> str | None:
    """The value, if it is a canonical handle of that kind; otherwise ``None``.

    A handle that is not canonical cannot be matched against a hold: the hold lists
    name handles (``w2``, ``wE:t19``), so a record whose id is malformed is a record
    whose provenance cannot be established.
    """
    return value if checker(value) else None


def _workspace_of(handle: str) -> str | None:
    """The workspace a tab or a pane handle names: the part before the colon.

    ``w1A:t1`` is in ``w1A`` and ``w1A:p1`` is in ``w1A``. The handle says so, which
    is what lets a record that omits its workspace still be placed.
    """
    if ":" not in handle:
        return None
    return handle.split(":", 1)[0]


def _topology_record_admitted(section: str, record: Mapping[str, Any], *,
                              policy: Any, admission: Any) -> bool:
    """May this topology record be persisted?

    Three questions, in this order:

    1. **Is the record identifiable?** A workspace record needs a canonical workspace
       id, a tab record a canonical tab id *and* a canonical workspace id, a pane or
       agent record a canonical pane id. A record that cannot say what it is cannot be
       checked against the holds, so it is not persisted: a label with no id must not
       survive because the id is missing or malformed.
    2. **Does it contradict itself?** A tab id names its workspace, and a pane id names
       its workspace. A record that names a different one is not a fact to keep.
    3. **Is it held or reserved?** The **policy** owns the holds (the denied
       workspaces, tabs and panes) and the **admission map** owns the placement, so a
       pane that sits in a reserved tab is refused even when the record does not name
       its tab -- the map's pane->tab mapping is what says where the pane is.

    A record that names a handle the map contradicts is refused as well: the map is the
    authority for the topology, and a contradicting record is not a new fact.
    """
    denied_workspaces = set(getattr(policy, "denied_workspaces", ()) or ())
    denied_panes = set(getattr(policy, "denied_panes", ()) or ())
    denied_tabs = set(getattr(policy, "denied_tabs", ()) or ())

    if section == "workspaces":
        workspace_id = _canonical(record.get("workspace_id"), guard.is_workspace_id)
        if workspace_id is None:
            return False
        return workspace_id not in denied_workspaces

    if section == "tabs":
        tab_id = _canonical(record.get("tab_id"), guard.is_tab_id)
        workspace_id = _canonical(record.get("workspace_id"), guard.is_workspace_id)
        if tab_id is None or workspace_id is None:
            return False
        if _workspace_of(tab_id) != workspace_id:
            return False
        if tab_id in denied_tabs or workspace_id in denied_workspaces:
            return False
        return True

    # panes and agents: the lane itself
    pane_id = _canonical(record.get("pane_id"), guard.is_pane_id)
    if pane_id is None:
        return False
    if pane_id in denied_panes:
        return False
    tab_id = record.get("tab_id")
    if tab_id is not None:
        tab_id = _canonical(tab_id, guard.is_tab_id)
        if tab_id is None:
            return False
    workspace_id = record.get("workspace_id")
    if workspace_id is not None:
        workspace_id = _canonical(workspace_id, guard.is_workspace_id)
        if workspace_id is None or _workspace_of(pane_id) != workspace_id:
            return False
    if tab_id is not None and _workspace_of(tab_id) != _workspace_of(pane_id):
        return False
    # The effective placement: the record's own handle, or the map's when the record
    # does not name one. A pane in a reserved tab is refused either way.
    effective_tab = tab_id or admission.tab_for(pane_id)
    effective_workspace = workspace_id or admission.workspace_for(pane_id)
    if effective_tab and effective_tab in denied_tabs:
        return False
    if effective_workspace and effective_workspace in denied_workspaces:
        return False
    admitted, _reason = admission.decide(pane_id, tab_id=tab_id, workspace_id=workspace_id)
    return admitted


def sanitize_topology(document: Mapping[str, Any] | None, *, policy: Any = None,
                       admission: Any = None) -> dict[str, Any]:
    """Reduce a captured herdr snapshot to the allowlisted, **admitted** topology.

    The result keeps the handles, labels, status values and paths the roster itself
    prints, and drops everything else. It is what gets written to the cache; the live
    roster derives from the *full* document, not from this reduced one.

    The **held and reserved records are dropped**: a workspace, tab, pane or agent the
    policy holds -- or that the admission map refuses -- is not persisted, so the shared
    cache never holds the metadata of a lane the roster itself refuses. The policy and
    the map are both required for that: without them there is nothing to filter with, so
    the filter **fails closed** and keeps only the protocol number.

    A record that cannot be **identified** is dropped as well. A workspace record
    without a canonical workspace id, a tab record without a canonical tab id or
    workspace id, and a pane record without a canonical pane id cannot be checked
    against the holds -- a label with no id is exactly the shape of metadata whose
    provenance is unknown, so it is not persisted. A record that contradicts itself (a
    tab id that names a different workspace than the record does) is dropped for the
    same reason.
    """
    if not isinstance(document, Mapping):
        return {}
    out: dict[str, Any] = {}
    protocol = document.get("protocol")
    if isinstance(protocol, int) and not isinstance(protocol, bool):
        out["protocol"] = protocol
    if policy is None or admission is None:
        # Fail closed: without the holds and the placement there is no way to tell an
        # admitted record from a held one, so no record is kept.
        return out
    for section, fields in _TOPOLOGY_FIELDS.items():
        records = document.get(section)
        if not isinstance(records, list):
            continue
        nested = _TOPOLOGY_NESTED.get(section, {})
        kept: list[dict[str, Any]] = []
        for record in records:
            if not isinstance(record, Mapping):
                continue
            if not _topology_record_admitted(section, record, policy=policy,
                                             admission=admission):
                continue
            item: dict[str, Any] = {}
            for key, kind in fields.items():
                if key in record:
                    coerced = _coerce(kind, record[key])
                    if coerced is not None:
                        item[key] = coerced
            for key, spec in nested.items():
                value = record.get(key)
                if not isinstance(value, Mapping):
                    continue
                if set(spec) == {"jj_bookmark"}:
                    # jj_bookmark may be a string or a small {value, expires_at} object.
                    bookmark = value.get("jj_bookmark")
                    if isinstance(bookmark, (str, Mapping)):
                        item[key] = {"jj_bookmark": bookmark}
                    continue
                sub: dict[str, Any] = {}
                for sub_key, sub_kind in spec.items():
                    if sub_key in value:
                        coerced = _coerce(sub_kind, value[sub_key])
                        if coerced is not None:
                            sub[sub_key] = coerced
                if sub:
                    item[key] = sub
            if item:
                kept.append(item)
        out[section] = kept
    return out

@dataclass
class CacheRead:
    """One cache read, with its freshness verdict."""

    state: str
    value: dict[str, Any] | None = None
    observed_at: str | None = None
    age_s: float | None = None
    seq: int | None = None
    sha256: str | None = None
    session_id: str | None = None
    reason: str | None = None
    #: The incarnation that produced the observation: the reporting process's boot id,
    #: pid and start time. It identifies *who* wrote it, not *whether it is alive now*.
    incarnation: str | None = None
    #: The reporter's monotone estimate of the observation's moment. A difference from
    #: the wall clock means the clock moved, and the freshness verdict is then disputed.
    mono_epoch: float | None = None
    #: How far the reporter's wall clock and its monotone clock disagree, in seconds.
    clock_skew_s: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "observed_at": self.observed_at,
            "age_s": None if self.age_s is None else round(self.age_s, 3),
            "seq": self.seq,
            "sha256": self.sha256,
            "session_id": self.session_id,
            "reason": self.reason,
            "incarnation": self.incarnation,
            "clock_skew_s": None if self.clock_skew_s is None else round(self.clock_skew_s, 3),
        }


_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS cache_meta (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
       )""",
    """CREATE TABLE IF NOT EXISTS pi_state_current (
           pane_id                 TEXT PRIMARY KEY,
           session_id              TEXT NOT NULL,
           incarnation             TEXT NOT NULL,
           incarnation_boot_id     TEXT NOT NULL,
           incarnation_start_ticks INTEGER NOT NULL,
           incarnation_boot_epoch  REAL NOT NULL,
           seq                     INTEGER NOT NULL,
           observed_at             TEXT NOT NULL,
           observed_at_epoch       REAL NOT NULL,
           mono_epoch              REAL,
           state_json              TEXT NOT NULL,
           sha256                  TEXT NOT NULL,
           writer                  TEXT NOT NULL
       )""",
    """CREATE TABLE IF NOT EXISTS pi_state_history (
           id               INTEGER PRIMARY KEY AUTOINCREMENT,
           pane_id          TEXT NOT NULL,
           session_id       TEXT NOT NULL,
           incarnation      TEXT NOT NULL,
           seq              INTEGER NOT NULL,
           observed_at      TEXT NOT NULL,
           observed_at_epoch REAL NOT NULL,
           retired_at       REAL NOT NULL
       )""",
    """CREATE INDEX IF NOT EXISTS pi_state_history_pane
           ON pi_state_history (pane_id, id DESC)""",
    """CREATE TABLE IF NOT EXISTS herdr_snapshot_current (
           id               INTEGER PRIMARY KEY CHECK (id = 1),
           protocol         INTEGER NOT NULL,
           seq              INTEGER NOT NULL,
           observed_at      TEXT NOT NULL,
           observed_at_epoch REAL NOT NULL,
           payload_json     TEXT NOT NULL,
           sha256           TEXT NOT NULL,
           source           TEXT NOT NULL
       )""",
)


class Cache:
    """A Behold-owned SQLite cache. One instance owns one file."""

    def __init__(self, path: str | None = None, *, timeout_s: float = 5.0,
                 readonly: bool = False):
        self.path = os.path.abspath(os.path.expanduser(path or default_db_path()))
        self.timeout_s = timeout_s
        self.readonly = readonly
        self._conn: sqlite3.Connection | None = None

    # -- lifecycle ----------------------------------------------------------------------

    def exists(self) -> bool:
        return os.path.exists(self.path)

    def connect(self) -> sqlite3.Connection:
        """Open the database, set the pragmas and make sure the schema is the one we expect."""
        if self._conn is not None:
            return self._conn
        if os.path.islink(self.path):
            # A symlink at the cache path is a sibling-escape surface: it could point at a
            # fleet store, and the write scope would then allow a write into that store.
            # The cache path is Behold's own file or nothing.
            raise CacheError(
                f"cache path is a symlink: {self.path}; refusing to write through it")
        parent = os.path.dirname(self.path)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        if self.readonly:
            conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True,
                                    timeout=self.timeout_s)
        else:
            conn = sqlite3.connect(self.path, timeout=self.timeout_s, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        if not self.readonly:
            self._set_journal_mode(conn)
            conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        self._conn = conn
        if not self.readonly:
            self._ensure_schema(conn)
        return conn

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            finally:
                self._conn = None

    def __enter__(self) -> "Cache":
        return self

    def __exit__(self, *exc: Any) -> bool:
        self.close()
        return False

    def _set_journal_mode(self, conn: sqlite3.Connection) -> None:
        """Put the database in WAL mode, tolerating a concurrent opener.

        Changing the journal mode needs a brief exclusive lock, and SQLite does **not**
        wait for it: with another connection already open, the pragma fails with
        "database is locked" instead of waiting for the busy timeout. That is not an
        error — the database is in WAL mode whoever created it chose WAL — but it must not
        take the run down, and it must not be reported as a failed write.
        """
        try:
            mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        except sqlite3.Error:
            mode = ""
        if mode == "wal":
            return
        try:
            conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.OperationalError:
            # Another connection holds the lock. The mode belongs to the database file,
            # not to this connection, and the writer that holds it is setting it too.
            pass

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        """Create the schema, migrate a known older one, or refuse an unknown one.

        The migration is explicit and bounded: a version 1 database is converted in
        place, keeping the newest row per pane as the current row (with an **empty**
        incarnation, because a version 1 row carries no ordering information) and moving
        the rest into the history table. An empty incarnation cannot refuse anything, so
        the first real observation takes ownership -- see
        :meth:`Cache._decide_ownership`.
        """
        user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        meta_version = 0
        try:
            row = conn.execute(
                "SELECT value FROM cache_meta WHERE key = 'schema_version'").fetchone()
        except sqlite3.OperationalError:
            # A fresh database has no meta table yet.
            row = None
        if row is not None:
            try:
                meta_version = int(row["value"])
            except (TypeError, ValueError) as exc:
                raise CacheError(
                    f"cache schema version is not a number: {row['value']!r}") from exc
        version = max(user_version, meta_version)
        if version and version != SCHEMA_VERSION and version not in MIGRATABLE_FROM:
            raise CacheError(
                f"cache schema mismatch: database is v{version}, this build expects "
                f"v{SCHEMA_VERSION}; remove the file or point BEHOLD_CACHE_DB elsewhere")
        conn.execute("BEGIN IMMEDIATE")
        try:
            if version in MIGRATABLE_FROM:
                self._migrate(conn, from_version=version)
            for statement in _SCHEMA:
                conn.execute(statement)
            row = conn.execute(
                "SELECT value FROM cache_meta WHERE key = 'schema_version'").fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO cache_meta(key, value) VALUES ('schema_version', ?)",
                    (str(SCHEMA_VERSION),))
                conn.execute(
                    "INSERT OR REPLACE INTO cache_meta(key, value) VALUES ('created_at', ?)",
                    (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),))
            else:
                try:
                    stored = int(row["value"])
                except (TypeError, ValueError) as exc:
                    raise CacheError(f"cache schema version is not a number: {row['value']!r}") from exc
                if stored != SCHEMA_VERSION:
                    raise CacheError(
                        f"cache schema mismatch: database is v{stored}, this build expects "
                        f"v{SCHEMA_VERSION}; remove the file or point BEHOLD_CACHE_DB elsewhere")
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    def _migrate(self, conn: sqlite3.Connection, *, from_version: int) -> None:
        """Convert a version 1 database to the current schema, in place.

        Version 1 keyed ``pi_state_current`` by ``(pane_id, session_id)`` and had no
        incarnation. The conversion keeps **one current row per pane** -- the newest
        observation for that pane -- and retires the others into the history table, so the
        row count stops growing with every restart.
        """
        if from_version != 1:
            raise CacheError(f"no migration path from cache schema v{from_version}")
        columns = {row["name"] for row in conn.execute(
            "PRAGMA table_info(pi_state_current)").fetchall()}
        if not columns:
            # No table at all: nothing to convert.
            return
        if "incarnation" in columns:
            # Already the current shape; the version pragma was simply out of date.
            return
        conn.execute("ALTER TABLE pi_state_current RENAME TO pi_state_current_v1")
        for statement in _SCHEMA:
            conn.execute(statement)
        rows = conn.execute(
            "SELECT pane_id, session_id, seq, observed_at, observed_at_epoch, "
            "state_json, sha256, writer FROM pi_state_current_v1").fetchall()
        by_pane: dict[str, list[sqlite3.Row]] = {}
        for row in rows:
            by_pane.setdefault(str(row["pane_id"]), []).append(row)
        now = time.time()
        for pane_id, pane_rows in by_pane.items():
            pane_rows.sort(key=lambda r: float(r["observed_at_epoch"]), reverse=True)
            newest = pane_rows[0]
            conn.execute(
                """INSERT INTO pi_state_current
                       (pane_id, session_id, incarnation, incarnation_boot_id,
                        incarnation_start_ticks, incarnation_boot_epoch, seq,
                        observed_at, observed_at_epoch, mono_epoch, state_json, sha256,
                        writer)
                   VALUES (?, ?, '', '', 0, ?, ?, ?, ?, NULL, ?, ?, ?)""",
                (pane_id, str(newest["session_id"]), float(newest["observed_at_epoch"]),
                 int(newest["seq"]), str(newest["observed_at"]),
                 float(newest["observed_at_epoch"]), str(newest["state_json"]),
                 str(newest["sha256"]), str(newest["writer"])))
            for retired in pane_rows[1:]:
                conn.execute(
                    """INSERT INTO pi_state_history
                           (pane_id, session_id, incarnation, seq, observed_at,
                            observed_at_epoch, retired_at)
                       VALUES (?, ?, '', ?, ?, ?, ?)""",
                    (pane_id, str(retired["session_id"]), int(retired["seq"]),
                     str(retired["observed_at"]), float(retired["observed_at_epoch"]), now))
        conn.execute("DROP TABLE pi_state_current_v1")
        conn.execute(
            "INSERT OR REPLACE INTO cache_meta(key, value) VALUES ('migrated_from', ?)",
            (str(from_version),))
        conn.execute(
            "INSERT OR REPLACE INTO cache_meta(key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),))

    # -- meta ---------------------------------------------------------------------------

    def meta(self) -> dict[str, str]:
        conn = self.connect()
        rows = conn.execute("SELECT key, value FROM cache_meta ORDER BY key").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def stats(self) -> dict[str, Any]:
        conn = self.connect()
        pi_rows = int(conn.execute("SELECT COUNT(*) FROM pi_state_current").fetchone()[0])
        history_rows = int(conn.execute("SELECT COUNT(*) FROM pi_state_history").fetchone()[0])
        snap_rows = int(conn.execute("SELECT COUNT(*) FROM herdr_snapshot_current").fetchone()[0])
        return {
            "path": self.path,
            "schema_version": SCHEMA_VERSION,
            "rows": {"pi_state_current": pi_rows, "pi_state_history": history_rows,
                     "herdr_snapshot_current": snap_rows},
        }

    # -- pi state -------------------------------------------------------------------

    def upsert_pi_state(self, *, pane_id: str, session_id: str, seq: int,
                        observed_at: str, observed_at_epoch: float,
                        state: Mapping[str, Any], writer: str,
                        incarnation: str = "", boot_id: str = "",
                        start_ticks: int = 0, boot_epoch: float = 0.0,
                        mono_epoch: float | None = None) -> dict[str, Any]:
        """Write one lane's runtime state, under the **ownership** rule.

        The write is atomic (``BEGIN IMMEDIATE``) and the *incarnation* decides, never
        the clock:

        * the same incarnation may only move forward (its ``seq`` must be greater);
        * an incarnation that started **later** takes the pane over;
        * an incarnation that started **earlier** may not take it back -- that is the
          late reporter, and it is refused (``stale_incarnation``);
        * a record from a different boot is ordered by the boot epoch, and two boot
          epochs too close to order are **refused** (``ambiguous_incarnation``) rather
          than guessed.

        A row with an empty incarnation (a migrated version 1 row) carries no ordering
        information and therefore cannot refuse anything: the first real observation
        takes the pane over.
        """
        clean = sanitize_state(state)
        digest = digest_of(clean)
        conn = self.connect()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT * FROM pi_state_current WHERE pane_id = ?", (pane_id,)).fetchone()
            verdict = self._decide_ownership(
                row,
                incarnation=incarnation, boot_id=boot_id, start_ticks=start_ticks,
                boot_epoch=boot_epoch, seq=seq)
            if verdict.get("status") != "written":
                conn.execute("COMMIT")
                return verdict
            if row is not None:
                self._retire(conn, row, now=time.time())
            conn.execute(
                """INSERT INTO pi_state_current
                       (pane_id, session_id, incarnation, incarnation_boot_id,
                        incarnation_start_ticks, incarnation_boot_epoch, seq,
                        observed_at, observed_at_epoch, mono_epoch, state_json, sha256,
                        writer)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(pane_id) DO UPDATE SET
                       session_id = excluded.session_id,
                       incarnation = excluded.incarnation,
                       incarnation_boot_id = excluded.incarnation_boot_id,
                       incarnation_start_ticks = excluded.incarnation_start_ticks,
                       incarnation_boot_epoch = excluded.incarnation_boot_epoch,
                       seq = excluded.seq,
                       observed_at = excluded.observed_at,
                       observed_at_epoch = excluded.observed_at_epoch,
                       mono_epoch = excluded.mono_epoch,
                       state_json = excluded.state_json,
                       sha256 = excluded.sha256,
                       writer = excluded.writer""",
                (pane_id, session_id, incarnation, boot_id, int(start_ticks),
                 float(boot_epoch), int(seq), observed_at, float(observed_at_epoch),
                 None if mono_epoch is None else float(mono_epoch),
                 canonical_json(clean), digest, writer))
            self._prune_history(conn, pane_id=pane_id)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        return {"status": "written", "sha256": digest, "seq": int(seq),
                "incarnation": incarnation, "reason": verdict.get("reason")}

    def _decide_ownership(self, row: sqlite3.Row | None, *, incarnation: str,
                           boot_id: str, start_ticks: int, boot_epoch: float,
                           seq: int) -> dict[str, Any]:
        """Decide whether an incoming observation may take (or keep) the pane.

        The rule is a total order on *incarnations*, not on timestamps:

        ``same incarnation`` -> only a strictly greater ``seq`` moves forward;
        ``same boot, later start`` -> the new incarnation takes the pane;
        ``same boot, earlier start`` -> refused (a late reporter may not take it back);
        ``different boot`` -> ordered by the boot epoch, and refused when the two epochs
        are too close to order.

        The one thing that is never done here is guessing: an unorderable record is
        refused, and the refusal says why.
        """
        if row is None:
            return {"status": "written", "reason": "first_observation"}
        stored_incarnation = str(row["incarnation"] or "")
        if not stored_incarnation:
            # A migrated row carries no ordering information: it cannot refuse anything.
            return {"status": "written", "reason": "legacy_owner_replaced"}
        if stored_incarnation == incarnation:
            if int(seq) > int(row["seq"]):
                return {"status": "written", "reason": "same_incarnation_newer_seq"}
            return {"status": "stale_rejected", "reason": "seq_not_newer",
                    "stored_seq": int(row["seq"]), "incoming_seq": int(seq),
                    "stored_incarnation": stored_incarnation}
        stored_boot = str(row["incarnation_boot_id"] or "")
        stored_ticks = int(row["incarnation_start_ticks"] or 0)
        stored_boot_epoch = float(row["incarnation_boot_epoch"] or 0.0)
        if boot_id and stored_boot and boot_id == stored_boot:
            if int(start_ticks) > stored_ticks:
                return {"status": "written", "reason": "new_incarnation"}
            return {"status": "stale_incarnation", "reason": "older_incarnation",
                    "stored_incarnation": stored_incarnation,
                    "incoming_incarnation": incarnation}
        if boot_epoch and stored_boot_epoch:
            delta = float(boot_epoch) - stored_boot_epoch
            if delta > BOOT_EPOCH_AMBIGUITY_S:
                return {"status": "written", "reason": "new_boot"}
            if delta < -BOOT_EPOCH_AMBIGUITY_S:
                return {"status": "stale_incarnation", "reason": "older_boot",
                        "stored_incarnation": stored_incarnation,
                        "incoming_incarnation": incarnation}
        return {"status": "ambiguous_incarnation", "reason": "ambiguous_boot_order",
                "stored_incarnation": stored_incarnation,
                "incoming_incarnation": incarnation}

    def _retire(self, conn: sqlite3.Connection, row: sqlite3.Row, *, now: float) -> None:
        """Move a replaced row into the bounded history."""
        conn.execute(
            """INSERT INTO pi_state_history
                   (pane_id, session_id, incarnation, seq, observed_at,
                    observed_at_epoch, retired_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (str(row["pane_id"]), str(row["session_id"]), str(row["incarnation"] or ""),
             int(row["seq"]), str(row["observed_at"]), float(row["observed_at_epoch"]), now))

    def _prune_history(self, conn: sqlite3.Connection, *, pane_id: str) -> None:
        """Bound the retired rows: per pane, and in total.

        The bound is what keeps the file from growing with the fleet's uptime: a lane
        that restarts a hundred times leaves eight retired rows behind, not a hundred.
        """
        conn.execute(
            """DELETE FROM pi_state_history
                WHERE pane_id = ? AND id NOT IN (
                    SELECT id FROM pi_state_history WHERE pane_id = ?
                    ORDER BY id DESC LIMIT ?)""",
            (pane_id, pane_id, HISTORY_ROWS_PER_PANE))
        conn.execute(
            """DELETE FROM pi_state_history
                WHERE id NOT IN (
                    SELECT id FROM pi_state_history ORDER BY id DESC LIMIT ?)""",
            (HISTORY_MAX_ROWS,))

    def read_pi_state(self, pane_id: str, *, session_id: str | None = None,
                      now: float | None = None,
                      freshness_s: float = DEFAULT_FRESHNESS_S) -> CacheRead:
        """Read one lane's cached state, with its freshness verdict.

        With ``session_id`` the read is identity-checked: a row belonging to another
        session is reported as ``identity_mismatch`` instead of being returned.

        One row exists per pane. The identity check is therefore a comparison, not a
        key: a lane whose session changed (``/new``, ``/resume``) is reported as a
        mismatch until the reporter publishes the new session's observation.
        """
        conn = self.connect()
        row = conn.execute(
            "SELECT * FROM pi_state_current WHERE pane_id = ?", (pane_id,)).fetchone()
        if row is None:
            return CacheRead(state=ABSENT, reason="no cached state for this pane")
        if session_id and str(row["session_id"]) != session_id:
            return CacheRead(
                state=IDENTITY_MISMATCH,
                session_id=str(row["session_id"]),
                reason=(f"cached state belongs to session {row['session_id']}, "
                        f"not {session_id}"))
        return self._read_from_row(row, now=now, freshness_s=freshness_s)

    def _read_from_row(self, row: sqlite3.Row, *, now: float | None,
                       freshness_s: float) -> CacheRead:
        observed_epoch = float(row["observed_at_epoch"])
        moment = now if now is not None else time.time()
        age = moment - observed_epoch
        mono = row["mono_epoch"]
        skew = None if mono is None else float(mono) - observed_epoch
        incarnation = str(row["incarnation"] or "")
        if age < 0:
            # The observation claims a moment in the future. The clock moved backwards,
            # so its age is unknown -- and an unknown age is not a fresh observation.
            return CacheRead(
                state=CLOCK_DISPUTED,
                reason=(f"the observation is timestamped {abs(age):.1f}s in the future: "
                        f"the clock moved backwards, so its age is unknown"),
                observed_at=str(row["observed_at"]), seq=int(row["seq"]),
                session_id=str(row["session_id"]), incarnation=incarnation,
                mono_epoch=None if mono is None else float(mono), clock_skew_s=skew)
        if skew is not None and abs(skew) > CLOCK_SKEW_LIMIT_S:
            # The reporter's wall clock and its monotone clock disagree: the clock moved
            # while the reporter was running. The age is then not trustworthy, so the
            # observation is disputed rather than called fresh.
            return CacheRead(
                state=CLOCK_DISPUTED,
                reason=(f"the reporter's clock and its monotone clock disagree by "
                        f"{skew:.1f}s: the clock moved, so the observation's age is "
                        f"not trustworthy"),
                observed_at=str(row["observed_at"]), age_s=age, seq=int(row["seq"]),
                session_id=str(row["session_id"]), incarnation=incarnation,
                mono_epoch=float(mono), clock_skew_s=skew)
        try:
            value = json.loads(row["state_json"])
        except ValueError:
            return CacheRead(state=UNREADABLE, reason="state_json is not valid JSON",
                             observed_at=str(row["observed_at"]))
        if not isinstance(value, dict):
            return CacheRead(state=UNREADABLE, reason="state_json is not a JSON object",
                             observed_at=str(row["observed_at"]))
        return CacheRead(
            state=FRESH if age <= freshness_s else STALE,
            value=value,
            observed_at=str(row["observed_at"]),
            age_s=age,
            seq=int(row["seq"]),
            sha256=str(row["sha256"]),
            session_id=str(row["session_id"]),
            incarnation=incarnation,
            mono_epoch=None if mono is None else float(mono),
            clock_skew_s=skew,
            reason=None if age <= freshness_s else
            f"observed {age:.1f}s ago, older than the {freshness_s:.0f}s freshness window",
        )

    def pi_state_freshness(self, *, now: float | None = None,
                            freshness_s: float = DEFAULT_FRESHNESS_S) -> dict[str, Any]:
        """Tally of the cached pi rows by freshness state.

        The tally counts the **current** rows -- one per pane -- and reads them inside a
        read transaction, so a concurrent ingest or prune cannot make the summary
        disagree with what a reader would see. Retired rows live in the history table and
        are reported separately, never mixed into the freshness count.
        """
        conn = self.connect()
        rows: list[sqlite3.Row] = []
        history = 0
        try:
            conn.execute("BEGIN DEFERRED")
            rows = conn.execute(
                "SELECT pane_id, session_id, observed_at_epoch, mono_epoch, incarnation "
                "FROM pi_state_current").fetchall()
            history = int(conn.execute(
                "SELECT COUNT(*) FROM pi_state_history").fetchone()[0])
            conn.execute("COMMIT")
        except sqlite3.OperationalError:
            # A transaction was already open (an ingest is in flight): read the rows
            # anyway. SQLite gives a consistent view for these single statements.
            rows = conn.execute(
                "SELECT pane_id, session_id, observed_at_epoch, mono_epoch, incarnation "
                "FROM pi_state_current").fetchall()
            history = int(conn.execute(
                "SELECT COUNT(*) FROM pi_state_history").fetchone()[0])
        moment = now if now is not None else time.time()
        tally = {FRESH: 0, STALE: 0, ABSENT: 0, IDENTITY_MISMATCH: 0, UNREADABLE: 0,
                 CLOCK_DISPUTED: 0}
        panes: set[str] = set()
        for row in rows:
            panes.add(str(row["pane_id"]))
            age = moment - float(row["observed_at_epoch"])
            mono = row["mono_epoch"]
            skew = None if mono is None else float(mono) - float(row["observed_at_epoch"])
            if age < 0 or (skew is not None and abs(skew) > CLOCK_SKEW_LIMIT_S):
                tally[CLOCK_DISPUTED] += 1
            else:
                tally[FRESH if age <= freshness_s else STALE] += 1
        return {"rows": len(rows), "panes": len(panes), "history_rows": history,
                "by_state": tally}

    # -- herdr topology -----------------------------------------------------------------

    def upsert_herdr_snapshot(self, *, protocol: int, seq: int, observed_at: str,
                               observed_at_epoch: float, payload: Mapping[str, Any],
                               source: str, policy: Any = None,
                               admission: Any = None) -> dict[str, Any]:
        """Store the sanitized topology. There is exactly one row (id = 1).

        The payload is filtered by the **policy** and the **admission map** before it is
        written: a held workspace's, a reserved tab's or a reserved pane's metadata is
        not persisted. Without both, the filter fails closed and only the protocol
        number is kept.
        """
        clean = sanitize_topology(payload, policy=policy, admission=admission)
        digest = digest_of(clean)
        conn = self.connect()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT seq FROM herdr_snapshot_current WHERE id = 1").fetchone()
            if row is not None and int(row["seq"]) > int(seq):
                conn.execute("COMMIT")
                return {"status": "stale_rejected", "reason": "seq_not_newer",
                        "stored_seq": int(row["seq"]), "incoming_seq": int(seq),
                        "sha256": digest}
            conn.execute(
                """INSERT INTO herdr_snapshot_current
                       (id, protocol, seq, observed_at, observed_at_epoch, payload_json,
                        sha256, source)
                   VALUES (1, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       protocol = excluded.protocol,
                       seq = excluded.seq,
                       observed_at = excluded.observed_at,
                       observed_at_epoch = excluded.observed_at_epoch,
                       payload_json = excluded.payload_json,
                       sha256 = excluded.sha256,
                       source = excluded.source""",
                (int(protocol), int(seq), observed_at, float(observed_at_epoch),
                 canonical_json(clean), digest, source))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        return {"status": "written", "sha256": digest, "seq": int(seq)}

    def read_herdr_snapshot(self, *, now: float | None = None,
                             freshness_s: float = DEFAULT_FRESHNESS_S) -> CacheRead:
        conn = self.connect()
        row = conn.execute("SELECT * FROM herdr_snapshot_current WHERE id = 1").fetchone()
        if row is None:
            return CacheRead(state=ABSENT, reason="no cached topology snapshot")
        observed_epoch = float(row["observed_at_epoch"])
        moment = now if now is not None else time.time()
        age = max(0.0, moment - observed_epoch)
        try:
            payload = json.loads(row["payload_json"])
        except ValueError:
            return CacheRead(state=UNREADABLE, reason="payload_json is not valid JSON")
        if not isinstance(payload, dict):
            return CacheRead(state=UNREADABLE, reason="payload_json is not a JSON object")
        return CacheRead(
            state=FRESH if age <= freshness_s else STALE,
            value=payload,
            observed_at=row["observed_at"],
            age_s=age,
            seq=int(row["seq"]),
            sha256=row["sha256"],
            reason=None if age <= freshness_s else
            f"observed {age:.1f}s ago, older than the {freshness_s:.0f}s freshness window",
        )

    # -- the spool protocol ---------------------------------------------------------------

    def ingest_inbox(self, inbox_dir: str | None = None, *,
                         admission_map: Any = None, policy: Any = None,
                         now: float | None = None) -> dict[str, Any]:
            """Apply the pi extension's spool records to the cache.

            **The admission map decides before the file is opened.** The map is what the
            roster published for this run: the deny ids *and* the topology's pane→tab and
            pane→workspace mapping. So a held workspace's record, a reserved pane's record
            and the record of a lane inside a **reserved tab** are all refused without being
            read -- the reserved tab no longer depends on the tab id being inside the record.

            The refusal is a refusal *of the whole file*, and it happens in this order:

            1. the file's name must yield **both** a pane id and a tab id. A name without a
               tab cannot be placed in the topology before the file is opened, and the
               reserved-tab refusal depends on that placement, so such a file is refused
               rather than opened;
            2. the map must know the pane;
            3. the map's tab for the pane must be the tab in the name -- a pane that moved
               since the map was published is refused, not admitted on the new claim;
            4. the pane must not be a reserved pane, the tab must not be a reserved tab, and
               the workspace must not be held.

            Only then is the file opened, and what happens after the open is **defence in
            depth, not a pre-read**: the record must agree with its own file name about the
            pane and the tab, and a record that does not is refused and never stored.

            A record is applied only when it parses, carries the expected record version,
            and carries an incarnation (a record without one cannot be ordered, so it is
            refused rather than guessed at).

            Without an admission map the ingest refuses **everything**: "admission could not
            be established" is not "admit".
            """
            result: dict[str, Any] = {
                "files": 0, "written": 0, "stale_rejected": 0, "stale_incarnation": 0,
                "ambiguous_incarnation": 0, "skipped_malformed": 0, "skipped_version": 0,
                "skipped_identity": 0, "skipped_denied": 0, "skipped_name": 0,
                "skipped_mismatch": 0, "skipped_unknown": 0, "skipped_admission": 0,
                "skipped_no_tab_identity": 0, "skipped_moved": 0,
                "skipped_superseded": 0, "pruned": 0,
                "panes": [], "refused": [],
            }
            if admission_map is None:
                result["skipped_admission"] = 1
                result["reason"] = ("no admission map: the ingest refuses every record rather "
                                    "than guess which lanes are admitted")
                return result
            directory = inbox_dir or inbox_dir_for(self.path)
            if not os.path.isdir(directory):
                return result
            try:
                names = sorted(os.listdir(directory))
            except OSError:
                return result
            # The records that were opened and understood, grouped by the pane they
            # are about. The owner of each pane is chosen from the whole group, so the
            # result does not depend on the order the files happen to be listed in.
            candidates: dict[str, list[dict[str, Any]]] = {}
            for name in names:
                if not name.endswith(".json"):
                    continue
                result["files"] += 1
                # 1. The name carries the pane id and the tab id. The admission map is
                #    applied to the NAME, so a refused lane's record is never opened.
                pane_from_name, tab_from_name, inc_from_name, seq_from_name = \
                    spool_file_parts(name)
                if pane_from_name is None:
                    result["skipped_name"] += 1
                    continue
                if tab_from_name is None:
                    # No tab in the name: the pane's current tab cannot be established
                    # before the file is opened, and the reserved-tab refusal depends on
                    # it. Refuse rather than open.
                    result["skipped_no_tab_identity"] += 1
                    result["refused"].append({"pane": pane_from_name,
                                              "reason": "no_tab_identity"})
                    continue
                admitted, reason = admission_map.decide(pane_from_name, tab_id=tab_from_name)
                if not admitted:
                    reason_text = str(reason)
                    if reason_text.startswith("unknown_pane"):
                        result["skipped_unknown"] += 1
                    elif "mismatch" in reason_text:
                        result["skipped_moved"] += 1
                    else:
                        result["skipped_denied"] += 1
                    result["refused"].append({"pane": pane_from_name, "reason": reason_text})
                    continue
                if not _is_pane_id(pane_from_name):
                    result["skipped_name"] += 1
                    continue
                path = os.path.join(directory, name)
                try:
                    with open(path, "r", encoding="utf-8") as fh:
                        record = json.load(fh)
                except (OSError, ValueError):
                    result["skipped_malformed"] += 1
                    continue
                if not isinstance(record, dict):
                    result["skipped_malformed"] += 1
                    continue
                version = record.get("behold_state")
                if version != STATE_RECORD_VERSION:
                    result["skipped_version"] += 1
                    continue
                pane_id = record.get("pane_id")
                session_id = record.get("session_id")
                incarnation = record.get("incarnation")
                seq = record.get("seq")
                observed_at = record.get("observed_at")
                observed_epoch = record.get("observed_at_epoch")
                mono_epoch = record.get("mono_epoch")
                boot_id = record.get("boot_id")
                start_ticks = record.get("incarnation_start_ticks")
                boot_epoch = record.get("incarnation_boot_epoch")
                tab_id = record.get("tab_id")
                if not isinstance(pane_id, str) or not pane_id:
                    result["skipped_malformed"] += 1
                    continue
                if not isinstance(session_id, str) or not session_id:
                    result["skipped_malformed"] += 1
                    continue
                if not isinstance(incarnation, str) or not incarnation:
                    # Without an incarnation there is no ordering, and no ownership. The
                    # record is refused rather than stored as an unordered truth.
                    result["skipped_malformed"] += 1
                    continue
                if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1:
                    result["skipped_malformed"] += 1
                    continue
                if not isinstance(observed_at, str) or not observed_at:
                    result["skipped_malformed"] += 1
                    continue
                if isinstance(observed_epoch, bool) or not isinstance(observed_epoch, (int, float)):
                    observed_epoch = time.time()
                if isinstance(mono_epoch, bool) or not isinstance(mono_epoch, (int, float)):
                    mono_epoch = None
                if not isinstance(boot_id, str):
                    boot_id = ""
                if isinstance(start_ticks, bool) or not isinstance(start_ticks, int):
                    start_ticks = 0
                if isinstance(boot_epoch, bool) or not isinstance(boot_epoch, (int, float)):
                    boot_epoch = 0.0
                # 2. Defence in depth (the file is already open): the file must be named for
                #    the pane it claims to be about, and the record's own tab must agree
                #    with the name. Neither of these is a pre-read check.
                if pane_from_name != pane_id:
                    result["skipped_identity"] += 1
                    continue
                # The record's own incarnation must be the one in its name. A name that
                # says one incarnation and a record that claims another is a collision
                # or a tampered file: it is refused, not stored.
                if inc_from_name is not None and _safe_component(incarnation) != inc_from_name:
                    result["skipped_identity"] += 1
                    result["refused"].append(
                        {"pane": pane_id, "reason": "incarnation_name_mismatch"})
                    continue
                state_block = record.get("state") if isinstance(record.get("state"), Mapping) else {}
                record_tab = tab_id if isinstance(tab_id, str) and tab_id else None
                if record_tab is None and isinstance(state_block, Mapping):
                    candidate = state_block.get("herdr_tab_id")
                    if isinstance(candidate, str) and candidate:
                        record_tab = candidate
                if record_tab is not None and record_tab != tab_from_name:
                    result["skipped_mismatch"] += 1
                    result["refused"].append(
                        {"pane": pane_id, "reason": f"tab_mismatch:{record_tab}!={tab_from_name}"})
                    continue
                candidates.setdefault(pane_id, []).append({
                    "path": path,
                    "name": name,
                    "session_id": session_id,
                    "seq": int(seq),
                    "observed_at": observed_at,
                    "observed_at_epoch": float(observed_epoch),
                    "state": state_block,
                    "writer": str(record.get("writer") or "pi-extension"),
                    "incarnation": incarnation,
                    "boot_id": boot_id,
                    "start_ticks": int(start_ticks),
                    "boot_epoch": float(boot_epoch),
                    "mono_epoch": None if mono_epoch is None else float(mono_epoch),
                })
            # 3. The owner of the pane. Several reporters may have written for the same
            #    pane, each in its own file, and the order between them has to be
            #    decided before anything is stored: the newest incarnation owns the
            #    pane, and within one incarnation the highest sequence number is the
            #    observation. An order that cannot be decided is refused.
            for pane_id, records in sorted(candidates.items()):
                owner, reason = _choose_owner(records)
                if owner is None:
                    result["ambiguous_incarnation"] += len(records)
                    result["refused"].append({"pane": pane_id, "reason": reason})
                    continue
                for other in records:
                    if other is owner:
                        continue
                    result["skipped_superseded"] += 1
                    result["refused"].append(
                        {"pane": pane_id, "reason": f"superseded:{other['incarnation']}"})
                outcome = self.upsert_pi_state(
                    pane_id=pane_id,
                    session_id=owner["session_id"],
                    seq=owner["seq"],
                    observed_at=owner["observed_at"],
                    observed_at_epoch=owner["observed_at_epoch"],
                    state=owner["state"],
                    writer=owner["writer"],
                    incarnation=owner["incarnation"],
                    boot_id=owner["boot_id"],
                    start_ticks=owner["start_ticks"],
                    boot_epoch=owner["boot_epoch"],
                    mono_epoch=owner["mono_epoch"])
                status = str(outcome.get("status"))
                if status == "written":
                    result["written"] += 1
                    result["panes"].append(pane_id)
                elif status == "stale_rejected":
                    result["stale_rejected"] += 1
                elif status == "stale_incarnation":
                    result["stale_incarnation"] += 1
                else:
                    result["ambiguous_incarnation"] += 1
                # 4. The cleanup. Only files that are **strictly superseded** are
                #    removed, and the owner's own file is kept: it is the writer's
                #    sequence seed, and dropping it would send the sequence back to 1.
                #    Every name is unique per (incarnation, sequence) and is never
                #    reused, so unlinking a file cannot destroy a newer record for
                #    the same lane. The only record the cleanup can lose is one the
                #    reader would have refused anyway (a superseded incarnation's).
                for other in records:
                    if other is owner:
                        continue
                    if _prune_spool_file(other["path"]):
                        result["pruned"] += 1
            return result

@dataclass
class CacheSummary:
    """The cache's state as the roster reports it. Never a claim of truth."""

    mode: str
    enabled: bool
    path: str
    state: str
    schema_version: int | None = None
    reason: str | None = None
    rows: dict[str, int] = dc_field(default_factory=dict)
    snapshot: dict[str, Any] | None = None
    pi_state: dict[str, Any] | None = None
    writes: str = "disabled"

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "enabled": self.enabled,
            "path": self.path,
            "state": self.state,
            "schema_version": self.schema_version,
            "reason": self.reason,
            "writes": self.writes,
            "rows": dict(self.rows),
            "snapshot": self.snapshot,
            "pi_state": self.pi_state,
            "note": ("cached values are last-observed runtime state, not disk truth; a "
                     "freshness verdict is a wall-clock age, not proof that the value is "
                     "still current"),
        }


def summarize(cache: Cache | None, *, mode: str, enabled: bool,
              now: float | None = None,
              freshness_s: float = DEFAULT_FRESHNESS_S) -> CacheSummary:
    """Build the roster-facing summary of a cache (or of its absence)."""
    if cache is None:
        return CacheSummary(mode=mode, enabled=False, path="", state="disabled",
                            reason="not opened for this run",
                            writes="disabled")
    summary = CacheSummary(mode=mode, enabled=enabled, path=cache.path, state="absent",
                           schema_version=SCHEMA_VERSION, writes="enabled")
    if not cache.exists():
        summary.state = "absent"
        summary.reason = "no cache file yet"
        return summary
    try:
        summary.rows = cache.stats()["rows"]
        snapshot = cache.read_herdr_snapshot(now=now, freshness_s=freshness_s)
        summary.snapshot = snapshot.to_dict()
        summary.pi_state = cache.pi_state_freshness(now=now, freshness_s=freshness_s)
        summary.state = "present"
    except CacheError as exc:
        summary.state = "unreadable"
        summary.reason = str(exc)
    except (sqlite3.Error, OSError) as exc:
        summary.state = "unreadable"
        summary.reason = f"{exc.__class__.__name__}: {exc}"
    return summary
