"""herdr snapshot adapter: the authoritative workspace / pane / agent layer.

The snapshot is one JSON document (protocol-tagged). behold records the protocol and
**fails loudly** on an unknown one instead of silently mis-parsing fields; unknown *keys*
inside a known protocol are tolerated, because herdr adds them.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field as dc_field
from typing import Any

from .. import guard
from . import SUPPORTED_HERDR_PROTOCOLS, SourceError

AGENT_STATUSES = ("idle", "working", "blocked", "done", "unknown")


@dataclass(frozen=True)
class Observation:
    """What the roster knows about **when it saw** the topology.

    The topology has no timestamp of its own: a herdr snapshot document says what the
    panes are, not when they were that way. So the observation is the roster's own
    record of the moment it looked, and of how much that moment is worth.

    * ``kind`` — where the topology came from: ``live_capture`` (this process asked
      herdr), ``snapshot_file`` or ``fixture_tree`` (a file was read), or ``unknown``.
    * ``at_epoch`` / ``at`` — when the roster **observed** the topology. This is what
      the admission map is stamped with: the map says "this placement was observed
      then", so it must not claim a moment the roster did not have.
    * ``source`` — how the moment is known: ``capture_clock`` (the capture's own clock,
      which cannot be forged) or ``file_mtime`` (a file's mtime, which anyone can set,
      and which is therefore weak provenance).
    * ``source_epoch`` — when the **source** was made, when that is knowable: a file's
      mtime. A live capture has no separate source: the capture *is* the observation,
      so ``source_epoch`` equals ``at_epoch``.

    A **reused** snapshot keeps this record. A watch iteration that reuses a capture
    did not see the topology again, and must not pretend it did: re-reading the same
    capture is not observing it again.
    """

    kind: str = "unknown"
    at_epoch: float | None = None
    at: str | None = None
    source: str | None = None
    source_epoch: float | None = None


@dataclass
class Snapshot:
    protocol: int | None
    agents: list[dict[str, Any]]
    panes: list[dict[str, Any]]
    workspaces: list[dict[str, Any]]
    tabs: list[dict[str, Any]]
    source: str
    bytes: int
    duration_ms: float
    extra_keys: list[str] = dc_field(default_factory=list)
    #: The document as it was read, so a caller can store the topology it came from
    #: without reading the source a second time.
    raw: dict[str, Any] | None = None
    #: When this topology was observed, and how that moment is known. It travels with
    #: the snapshot: a reused snapshot keeps the observation it was read with.
    observation: Observation = dc_field(default_factory=Observation)

    def workspace(self, workspace_id: str | None) -> dict[str, Any]:
        for ws in self.workspaces:
            if ws.get("workspace_id") == workspace_id:
                return ws
        return {}

    def pane(self, pane_id: str | None) -> dict[str, Any]:
        for pane in self.panes:
            if pane.get("pane_id") == pane_id:
                return pane
        return {}

    def tab(self, tab_id: str | None) -> dict[str, Any]:
        for tab in self.tabs:
            if tab.get("tab_id") == tab_id:
                return tab
        return {}

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol": self.protocol,
            "agents": len(self.agents),
            "panes": len(self.panes),
            "workspaces": len(self.workspaces),
            "tabs": len(self.tabs),
            "source": self.source,
            "bytes": self.bytes,
            "duration_ms": round(self.duration_ms, 3),
        }


def load(path: str, policy: guard.Policy) -> Snapshot:
    started = time.perf_counter()
    try:
        raw = guard.read_json(path, policy, "herdr-snapshot")
    except guard.DeniedRead:
        raise
    except (OSError, ValueError) as exc:
        raise SourceError(f"snapshot unreadable: {exc.__class__.__name__}") from exc
    return _parse(raw, path, started, policy)


def parse_document(raw: Any, source: str, policy: guard.Policy, *,
                   bytes_: int | None = None) -> Snapshot:
    """Parse an in-memory snapshot document.

    The live capture path never writes the document to a file first: herdr prints it on
    stdout and it is parsed here, under the same protocol rules as a file snapshot.
    """
    return _parse(raw, source, time.perf_counter(), policy, bytes_=bytes_)


def _parse(raw: Any, source: str, started: float, policy: guard.Policy,
           bytes_: int | None = None) -> Snapshot:
    if not isinstance(raw, dict):
        raise SourceError("snapshot is not a JSON object")
    protocol = raw.get("protocol")
    if not isinstance(protocol, int):
        raise SourceError("snapshot has no integer protocol field; refusing to guess")
    if protocol not in SUPPORTED_HERDR_PROTOCOLS:
        raise SourceError(
            f"unsupported herdr protocol {protocol}; supported: {sorted(SUPPORTED_HERDR_PROTOCOLS)}"
        )
    known = {"protocol", "agents", "panes", "workspaces", "tabs", "layouts"}
    if bytes_ is None:
        bytes_ = os.path.getsize(source) if os.path.exists(source) else 0
    snap = Snapshot(
        protocol=protocol,
        agents=[a for a in raw.get("agents") or [] if isinstance(a, dict)],
        panes=[p for p in raw.get("panes") or [] if isinstance(p, dict)],
        workspaces=[w for w in raw.get("workspaces") or [] if isinstance(w, dict)],
        tabs=[t for t in raw.get("tabs") or [] if isinstance(t, dict)],
        source=source,
        bytes=bytes_,
        duration_ms=(time.perf_counter() - started) * 1000.0,
        extra_keys=sorted(set(raw.keys()) - known),
        raw=raw if isinstance(raw, dict) else None,
    )
    policy._record("snapshot", f"protocol={protocol} agents={len(snap.agents)}")
    return snap


def pane_name(agent: dict[str, Any], pane: dict[str, Any], tab: dict[str, Any]) -> tuple[str | None, str | None]:
    """H-4: layered name with the winning layer recorded.

    Precedence (plan §4.1): tab label -> agent name -> display_agent -> pane label ->
    stripped terminal title. The sidebar shows none of this today, which is the FT-11 gap;
    the roster resolves it and says *which* layer answered.
    """
    layers = (
        ("tabs[].label", tab.get("label")),
        ("agents[].name", agent.get("name")),
        ("agents[].display_agent", agent.get("display_agent")),
        ("panes[].label", pane.get("label")),
        ("agents[].terminal_title_stripped", agent.get("terminal_title_stripped")),
    )
    for name, value in layers:
        if isinstance(value, str) and value.strip():
            return value.strip(), name
    return None, None


def status_value(agent: dict[str, Any], pane: dict[str, Any]) -> tuple[str | None, str | None]:
    """Raw herdr status verbatim (``done`` is a legitimate herdr value, not progress)."""
    for source, record in (("panes[].agent_status", pane), ("agents[].agent_status", agent)):
        value = record.get("agent_status")
        if isinstance(value, str) and value in AGENT_STATUSES:
            return value, source
    if isinstance(agent.get("agent_status"), str):
        return agent["agent_status"], "agents[].agent_status (unrecognized value)"
    return None, None
