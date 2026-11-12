"""The admission map: what the roster admits, published for the reporter and the ingester.

The roster's deny policy (:class:`behold.guard.Policy`) is a set of **ids**: a held
workspace, a reserved tab, a reserved pane. That is enough to refuse a lane the roster
knows about, and it is what the lane builder uses. It is *not* enough for the two other
consumers of the deny decision:

* the **ingester** sees a spool file named for a pane. It must decide, *before* the file
  is opened, whether that pane is refused. A pane that lives inside a **reserved tab** has
  an innocent-looking id (``wE:p99``), and the tab id is only knowable from inside the
  record — so refusing by the record's own claim means reading the record first. That is
  the read-then-discard this module exists to remove.
* the **reporter** knows its own pane, tab and workspace from the environment the lane was
  launched with. It must decide whether to write at all, before it writes.

So the roster **publishes** the decision it has already made, in a form both sides can
use without reading anything they are not allowed to read: the deny ids *and* the
topology's pane→tab / pane→workspace mapping. Both sides then apply the same rule, and
the rule is the same one the roster applied to the lane (:meth:`guard.Policy.admit_lane`).

The mapping covers the lanes that **may report**. A lane the holds refuse is not in it:
the refusal does not need the placement (the deny lists are enough — the reporter stays
silent before it writes, the ingester refuses before it opens a file), and publishing it
would publish the panes and tabs of a lane the roster holds. The deny ids themselves
*are* published, deliberately: both sides need them to refuse.

Four properties matter, and all four are enforced here:

* **Fail closed.** A missing, unreadable, malformed, wrong-version, incomplete,
  contradictory or **stale** map admits *nothing*. "I could not establish admission" is
  not "admit". A map whose deny list is absent is **not** an empty deny list: it is a
  broken map, and a broken map refuses everything.
* **Complete.** The pane→tab and pane→workspace mappings must cover exactly the same
  panes. A partial mapping would let a pane that the roster cannot place be admitted on
  the strength of the half it does know.
* **No silent weakening.** A caller that supplies a tab or workspace contradicting the
  map is refused as a mismatch, not believed. A pane that moved between the capture and
  the read is refused rather than admitted on the strength of the new claim.
* **The holds come first.** The deny lists are applied before the placement lookup, on
  both sides, so a refused lane is refused as *held* or *reserved* and not as an
  unknown pane. A pane id names its own workspace, so a held lane is recognised from the
  pane id alone.

The map carries the topology it was built from, so a reader can tell a fresh map from a
stale one: :attr:`AdmissionMap.captured_at_epoch` and
:attr:`AdmissionMap.topology_revision`.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from dataclasses import dataclass, field as dc_field
from typing import Any, Mapping

from . import guard

#: Version of the published admission map. A reader that does not understand this version
#: admits nothing: it cannot know what the writer meant.
ADMISSION_VERSION = 2

#: How long a published map stays usable. A map older than this is stale: the deny list
#: may have changed since it was written (an operator reserved a tab, a pane moved), and
#: admitting on a stale map is admitting on a guess.
ADMISSION_TTL_S = 300.0

#: How far a map's capture time may lie in the future before it is refused. A map dated
#: in the future is either a clock that moved or a hand-written one; neither may be
# trusted to be fresh, and a future date must not be clamped to "age 0".
FUTURE_TOLERANCE_S = 5.0

#: The file the map is published in, beside the cache database. It is Behold's own state,
#: in Behold's own directory — not a settings file and not a fleet store.
ADMISSION_FILE_NAME = "denied-lanes.json"

#: A safe handle: the shapes the roster's ids actually take. No path separators, no
#: whitespace, no control characters, and bounded in length — a handle that can name a
#: file is a handle that can be made to name one.
#: \A and \Z, not ^ and $: in Python "$" also matches just before a trailing newline, and
#: a handle that ends in a newline is a handle that can name something else.
SAFE_ID_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")


def _workspace_of_pane(pane_id: str) -> str | None:
    """The workspace a pane id names, or ``None`` if the id is not a pane id.

    ``w1A:p1`` is in ``w1A``. The handle says so, which is what lets a held lane be
    recognised from the pane id alone — the caller does not have to name its
    workspace for the hold to apply.
    """
    if not guard.is_pane_id(pane_id):
        return None
    return pane_id.split(":", 1)[0]


class AdmissionError(Exception):
    """The admission map is missing, malformed, incomplete, stale or contradictory."""


@dataclass(frozen=True)
class AdmissionMap:
    """What the roster admits, as published to the reporter and the ingester.

    The deny lists carry the holds; the two mappings carry the placement of the lanes
    that may report. A lane the holds refuse is in neither mapping: the refusal does
    not need its placement, and publishing it would publish the handles of a lane the
    roster holds.
    """

    captured_at: str
    captured_at_epoch: float
    topology_revision: str
    denied_workspaces: tuple[str, ...] = ()
    reserved_panes: tuple[str, ...] = ()
    reserved_tabs: tuple[str, ...] = ()
    pane_tab: Mapping[str, str] = dc_field(default_factory=dict)
    pane_workspace: Mapping[str, str] = dc_field(default_factory=dict)
    version: int = ADMISSION_VERSION

    # -- the topology it describes --------------------------------------------------------

    def knows(self, pane_id: str | None) -> bool:
        """Does this map place the pane in the topology at all?"""
        if not pane_id:
            return False
        return pane_id in self.pane_tab and pane_id in self.pane_workspace

    def tab_for(self, pane_id: str | None) -> str | None:
        if not pane_id:
            return None
        return self.pane_tab.get(pane_id)

    def workspace_for(self, pane_id: str | None) -> str | None:
        if not pane_id:
            return None
        return self.pane_workspace.get(pane_id)

    # -- the decision ------------------------------------------------------------------

    def decide(self, pane_id: str | None, *, tab_id: str | None = None,
               workspace_id: str | None = None) -> tuple[bool, str | None]:
        """Admit this lane or refuse it, with a stable reason code.

        The order is deliberate. The **holds** come first: they name the lanes that may
        never report, and they do not depend on the placement -- the map publishes the
        placement of the *admitted* lanes only, so a held lane looked up in the map
        first would be reported as "unknown" instead of as held.

        Then the **map** is the authority for the topology, so a caller's contradicting
        handle is a mismatch and not a new fact. A pane the map does not know is
        refused: the map is built from the topology the roster just read, and a pane
        that is not in it is a pane the roster cannot vouch for.
        """
        if not pane_id:
            return False, "no_pane"
        held = self.hold_reason(pane_id, tab_id=tab_id, workspace_id=workspace_id)
        if held is not None:
            return False, held
        known_tab = self.pane_tab.get(pane_id)
        known_workspace = self.pane_workspace.get(pane_id)
        if known_tab is None or known_workspace is None:
            return False, f"unknown_pane:{pane_id}"
        if tab_id is not None and tab_id != known_tab:
            return False, f"tab_mismatch:{pane_id}:{tab_id}!={known_tab}"
        if workspace_id is not None and workspace_id != known_workspace:
            return False, f"workspace_mismatch:{pane_id}:{workspace_id}!={known_workspace}"
        return True, None

    def hold_reason(self, pane_id: str | None, *, tab_id: str | None = None,
                    workspace_id: str | None = None) -> str | None:
        """The hold that refuses this lane, if there is one.

        The handles are the ones the caller already has: the pane id, the tab it names
        (or the tab the lane was launched with), and the workspace. A pane id names
        its own workspace -- ``w2:p1`` is in ``w2`` -- so a held lane is recognised
        even when the caller cannot name its workspace.
        """
        if not pane_id:
            return None
        if pane_id in self.reserved_panes:
            return f"reserved_pane:{pane_id}"
        if tab_id and tab_id in self.reserved_tabs:
            return f"reserved_tab:{tab_id}"
        if workspace_id is None:
            workspace_id = _workspace_of_pane(pane_id)
        if workspace_id and workspace_id in self.denied_workspaces:
            return f"held_workspace:{workspace_id}"
        return None

    def allows_write(self, pane_id: str | None, *, inherited_tab: str | None = None,
                     inherited_workspace: str | None = None
                     ) -> tuple[bool, str | None, str | None]:
        """May the reporter write for this pane, and under which tab?

        The reporter's own tab id is **inherited**: it is the tab the lane was launched
        with, and it does not follow a pane that moves. The map says where the pane is
        *now*, so the map is the authority for the placement, and the record is written
        under **the map's** tab — otherwise a pane that moved to another admitted tab
        would never be ingested again (the name and the map would disagree forever).

        The refusals are about the **reserved** set, and they are checked twice: once
        against the map's placement (where the pane is now) and once against the
        reporter's inherited handles (where the lane was launched). A lane launched in a
        reserved tab stays silent even if the map has moved it out.

        The order matches :meth:`decide`: the holds that do not need the placement come
        first, so a held lane is refused as held and not as unknown.

        Returns ``(allowed, reason, tab)``: the tab to write under, or ``None``.
        """
        if not pane_id:
            return False, "no_pane", None
        if pane_id in self.reserved_panes:
            return False, f"reserved_pane:{pane_id}", None
        if inherited_tab is not None and inherited_tab in self.reserved_tabs:
            return False, f"reserved_tab:{inherited_tab}", None
        if inherited_workspace is not None and inherited_workspace in self.denied_workspaces:
            return False, f"held_workspace:{inherited_workspace}", None
        if not self.knows(pane_id):
            return False, f"unknown_pane:{pane_id}", None
        current_tab = self.tab_for(pane_id)
        current_workspace = self.workspace_for(pane_id)
        if current_tab in self.reserved_tabs:
            return False, f"reserved_tab:{current_tab}", None
        if current_workspace in self.denied_workspaces:
            return False, f"held_workspace:{current_workspace}", None
        return True, None, current_tab

    # -- serialization ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "captured_at": self.captured_at,
            "captured_at_epoch": self.captured_at_epoch,
            "topology_revision": self.topology_revision,
            "denied_workspaces": list(self.denied_workspaces),
            "reserved_panes": list(self.reserved_panes),
            "reserved_tabs": list(self.reserved_tabs),
            "pane_tab": dict(self.pane_tab),
            "pane_workspace": dict(self.pane_workspace),
        }

    @classmethod
    def from_dict(cls, payload: Any, *, now: float | None = None) -> "AdmissionMap":
        """Parse a published map, or refuse it.

        Every failure is an :class:`AdmissionError`: the caller must not treat an
        unreadable map as an empty one. In particular a **missing** deny list is a broken
        map, not an empty deny list.
        """
        if not isinstance(payload, dict):
            raise AdmissionError("the admission map is not a JSON object")
        version = payload.get("version")
        if version != ADMISSION_VERSION:
            raise AdmissionError(
                f"unsupported admission map version {version!r}; this build reads "
                f"version {ADMISSION_VERSION}")
        captured_epoch = payload.get("captured_at_epoch")
        if isinstance(captured_epoch, bool) or not isinstance(captured_epoch, (int, float)):
            raise AdmissionError("the admission map carries no numeric captured_at_epoch")
        captured_epoch = float(captured_epoch)
        if not math.isfinite(captured_epoch):
            raise AdmissionError("the admission map's capture time is not a finite number")
        moment = time.time() if now is None else now
        if captured_epoch > moment + FUTURE_TOLERANCE_S:
            raise AdmissionError(
                f"the admission map's capture time is in the future "
                f"({captured_epoch - moment:.1f}s ahead): it cannot be trusted as fresh")
        pane_tab = _require_mapping(payload, "pane_tab")
        pane_workspace = _require_mapping(payload, "pane_workspace")
        if set(pane_tab) != set(pane_workspace):
            only_tab = sorted(set(pane_tab) - set(pane_workspace))
            only_workspace = sorted(set(pane_workspace) - set(pane_tab))
            raise AdmissionError(
                "the admission map's pane mappings are incomplete or contradictory "
                f"(tab-only: {only_tab[:5]}; workspace-only: {only_workspace[:5]})")
        return cls(
            captured_at=str(payload.get("captured_at") or ""),
            captured_at_epoch=captured_epoch,
            topology_revision=str(payload.get("topology_revision") or ""),
            denied_workspaces=_require_ids(payload, "denied_workspaces"),
            reserved_panes=_require_ids(payload, "reserved_panes"),
            reserved_tabs=_require_ids(payload, "reserved_tabs"),
            pane_tab=pane_tab,
            pane_workspace=pane_workspace,
        )

    def age_s(self, now: float | None = None) -> float:
        moment = time.time() if now is None else now
        return max(0.0, moment - self.captured_at_epoch)

    def is_stale(self, now: float | None = None, *, ttl_s: float = ADMISSION_TTL_S) -> bool:
        return self.age_s(now) > ttl_s


def _require_ids(payload: Mapping[str, Any], key: str) -> tuple[str, ...]:
    """A deny list that must be **present** and hold safe ids.

    The old reader returned an empty list for a missing or wrongly-typed list, which
    turned a broken map into "deny nothing" — a fail-open. A missing list is now a
    broken map, and a broken map refuses everything.
    """
    value = payload.get(key)
    if not isinstance(value, list):
        raise AdmissionError(f"the admission map's {key} is missing or not a list")
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not SAFE_ID_RE.match(item):
            raise AdmissionError(
                f"the admission map's {key} holds an entry that is not a safe handle")
        out.append(item)
    return tuple(sorted(out))


def _require_mapping(payload: Mapping[str, Any], key: str) -> dict[str, str]:
    """A pane mapping that must be present and hold safe handles on both sides."""
    value = payload.get(key)
    if not isinstance(value, dict):
        raise AdmissionError(f"the admission map's {key} is missing or not an object")
    out: dict[str, str] = {}
    for pane, handle in value.items():
        if not isinstance(pane, str) or not isinstance(handle, str):
            raise AdmissionError(f"the admission map's {key} is not a string→string map")
        if not SAFE_ID_RE.match(pane) or not SAFE_ID_RE.match(handle):
            raise AdmissionError(f"the admission map's {key} holds an unsafe handle")
        out[pane] = handle
    return out


# -- building ---------------------------------------------------------------------------


def build_map(*, policy: Any, panes: Any, topology_revision: str,
              captured_at_epoch: float | None = None,
              captured_at: str | None = None) -> AdmissionMap:
    """Build the map from the roster's policy and the topology it just read.

    ``panes`` is an iterable of pane records (``pane_id``, ``tab_id``, ``workspace_id``).
    The deny lists come from the **policy**, which is where the holds live — a map
    cannot carry a hold that the policy does not have.

    The map publishes the placement of the lanes that **may report**. A lane the holds
    refuse is not in it: the deny lists are published, and both sides refuse such a
    lane on those lists alone — the reporter before it writes, the ingester before it
    opens a file — so carrying the refused lanes' placement would publish handles that
    nothing needs. The refused lanes are still *refused*: a pane the map does not carry
    is refused by the fail-closed "unknown pane" rule, and the holds are applied first,
    so the reason is still "held" or "reserved" rather than "unknown".

    A pane the topology does not place (no tab, or no workspace) cannot be admitted:
    the roster does not know where it lives.
    """
    moment = time.time() if captured_at_epoch is None else captured_at_epoch
    denied_workspaces = tuple(sorted(policy.denied_workspaces))
    reserved_panes = tuple(sorted(policy.denied_panes))
    reserved_tabs = tuple(sorted(policy.denied_tabs))
    # First pass: the placement of every pane the topology mentions. A pane can be
    # described by more than one record (the pane entry and the agent entry), and one
    # of them may carry the workspace the other lacks.
    placement: dict[str, dict[str, str]] = {}
    for pane in panes or ():
        if not isinstance(pane, Mapping):
            continue
        pane_id = pane.get("pane_id")
        if not isinstance(pane_id, str) or not guard.is_pane_id(pane_id):
            # Only a canonical pane id names a lane. A record that cannot be named
            # cannot be placed, and a lane that cannot be placed is not in the map.
            continue
        entry = placement.setdefault(pane_id, {})
        tab_id = pane.get("tab_id")
        if isinstance(tab_id, str) and guard.is_tab_id(tab_id):
            entry["tab_id"] = tab_id
        workspace_id = pane.get("workspace_id")
        if isinstance(workspace_id, str) and guard.is_workspace_id(workspace_id):
            entry["workspace_id"] = workspace_id
    pane_tab: dict[str, str] = {}
    pane_workspace: dict[str, str] = {}
    for pane_id, entry in placement.items():
        tab_id = entry.get("tab_id")
        workspace_id = entry.get("workspace_id")
        # A pane id names its own workspace, so a held lane is recognised even when the
        # record does not name its workspace.
        effective_workspace = workspace_id or _workspace_of_pane(pane_id)
        if pane_id in reserved_panes:
            continue
        if tab_id is not None and tab_id in reserved_tabs:
            continue
        if effective_workspace is not None and effective_workspace in denied_workspaces:
            continue
        if tab_id is not None:
            pane_tab[pane_id] = tab_id
        if workspace_id is not None:
            pane_workspace[pane_id] = workspace_id
    return AdmissionMap(
        captured_at=captured_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(moment)),
        captured_at_epoch=float(moment),
        topology_revision=topology_revision,
        denied_workspaces=tuple(sorted(policy.denied_workspaces)),
        reserved_panes=tuple(sorted(policy.denied_panes)),
        reserved_tabs=tuple(sorted(policy.denied_tabs)),
        pane_tab=pane_tab,
        pane_workspace=pane_workspace,
    )


# -- publishing and reading ---------------------------------------------------------------


def admission_path(db_path: str) -> str:
    """Where the admission map is published, beside the cache database."""
    return os.path.join(os.path.dirname(os.path.abspath(db_path)), ADMISSION_FILE_NAME)


def publish(path: str, admission: AdmissionMap) -> str:
    """Write the map atomically: a temp file and a rename.

    A reader must never see a half-written map — it would parse as invalid and fail
    closed, which is safe but would stop the reporter for no reason.
    """
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    temp = f"{path}.tmp.{os.getpid()}"
    with open(temp, "w", encoding="utf-8") as fh:
        json.dump(admission.to_dict(), fh, indent=2, sort_keys=True)
        fh.write("\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(temp, path)
    return path


def load(path: str, *, now: float | None = None,
         ttl_s: float = ADMISSION_TTL_S) -> AdmissionMap:
    """Read the published map, or raise :class:`AdmissionError`.

    Missing, unreadable, malformed, wrong-version, incomplete, contradictory and stale
    all raise: every one of them means "admission could not be established".
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except FileNotFoundError as exc:
        raise AdmissionError(f"no admission map at {path}") from exc
    except OSError as exc:
        raise AdmissionError(f"the admission map at {path} is unreadable: {exc}") from exc
    except ValueError as exc:
        raise AdmissionError(f"the admission map at {path} is not valid JSON: {exc}") from exc
    admission = AdmissionMap.from_dict(payload, now=now)
    if admission.is_stale(now, ttl_s=ttl_s):
        raise AdmissionError(
            f"the admission map at {path} is stale: it was captured "
            f"{admission.age_s(now):.0f}s ago (limit {ttl_s:.0f}s)")
    return admission
