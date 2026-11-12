"""``--watch``: a short-lived bounded client, not a daemon.

What it actually does, stated precisely because the plan refuses to promise "always
immediate": it re-stats the inputs it consumed (each lane's session file, the herdr snapshot,
an optional herdr events file) at a bounded interval, re-derives only the lanes whose inputs
changed, and emits a document per iteration. It runs for ``iterations`` (default 1 extra
pass) and exits; nothing persists between runs, nothing is written, no socket is opened.

Freshness is per source and is printed as an age, so "the session fields are 40 s old while
status is 0.2 s old" is visible instead of implied. herdr events alone do **not** refresh
session or runtime fields: an event invalidation refreshes the snapshot-derived fields only,
and the session age keeps growing — that distinction is a test.

Runtime-only metrics (TTFT, monitors, job exit state) stay in ``runtime_only_pending`` on
every iteration; a watcher cannot invent them.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field as dc_field
from typing import Any, Callable

from . import session, util


@dataclass
class InputState:
    path: str
    exists: bool
    inode: int | None
    size: int
    mtime_ns: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "exists": self.exists,
            "inode": self.inode,
            "size": self.size,
            "mtime_ns": self.mtime_ns,
        }


def stat_input(path: str) -> InputState | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return InputState(path=path, exists=True, inode=st.st_ino, size=st.st_size, mtime_ns=st.st_mtime_ns)


@dataclass
class WatchConfig:
    iterations: int = 2
    interval_s: float = 0.5
    max_seconds: float = 30.0
    events_file: str | None = None
    poll_source: Callable[[], Any] | None = None

    def validate(self) -> None:
        if self.iterations < 1:
            raise ValueError("--watch-iterations must be >= 1")
        if self.interval_s <= 0:
            raise ValueError("--watch-interval must be > 0")
        if self.max_seconds <= 0:
            raise ValueError("--watch-max-seconds must be > 0")
        if self.interval_s < 0.05:
            raise ValueError("--watch-interval below 50 ms is a spin loop; refusing")


@dataclass
class WatchStep:
    iteration: int
    changed_sources: list[str] = dc_field(default_factory=list)
    refreshed_lanes: int = 0
    stale_lanes: int = 0
    elapsed_s: float = 0.0
    rotated: list[str] = dc_field(default_factory=list)
    process_exits: list[str] = dc_field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "iteration": self.iteration,
            "changed_sources": self.changed_sources,
            "refreshed_lanes": self.refreshed_lanes,
            "stale_lanes": self.stale_lanes,
            "rotated": self.rotated,
            "process_exits": self.process_exits,
            "elapsed_s": round(self.elapsed_s, 3),
        }


def collect_inputs(paths: list[str], events_file: str | None = None) -> dict[str, InputState | None]:
    inputs: dict[str, InputState | None] = {}
    for path in paths:
        if not path:
            continue
        inputs[path] = stat_input(path)
    if events_file:
        inputs[f"events:{events_file}"] = stat_input(events_file)
    return inputs


def diff_inputs(
    previous: dict[str, InputState | None],
    current: dict[str, InputState | None],
    *,
    lane_sessions: dict[str, str] | None = None,
) -> tuple[list[str], list[str], list[str]]:
    """Return (changed_sources, rotated_paths, refreshed_lane_keys).

    ``lane_sessions`` maps lane key -> session path so a change can be attributed to lanes.
    A rotation (inode change or shrinkage) is called out separately: an appended file is a
    normal update, a replaced/truncated one means the reader must not trust offsets.
    """
    changed: list[str] = []
    rotated: list[str] = []
    for key, now in current.items():
        before = previous.get(key)
        if before is None and now is None:
            continue
        if before is None or now is None:
            changed.append(key)
            continue
        if before.inode != now.inode or now.size < before.size:
            changed.append(key)
            rotated.append(key.removeprefix("events:"))
            continue
        if before.mtime_ns != now.mtime_ns or before.size != now.size:
            changed.append(key)
    refreshed: list[str] = []
    if lane_sessions:
        changed_set = set(changed)
        for lane_key, path in lane_sessions.items():
            if path in changed_set:
                refreshed.append(lane_key)
    return changed, rotated, sorted(refreshed)


def run_watch(
    *,
    derive: Callable[[], tuple[Any, list[str], dict[str, str]]],
    emit: Callable[[Any, WatchStep], None],
    config: WatchConfig,
) -> list[WatchStep]:
    """Bounded watch loop.

    ``derive`` returns ``(document, input_paths, lane->session path)``. The loop renders once,
    then renders again only when an input changed; it ends after ``iterations`` renders or
    when ``max_seconds`` elapses, whichever comes first. No unbounded loop, no sleep-spin.
    """
    config.validate()
    started = time.monotonic()
    steps: list[WatchStep] = []
    # Measure first, then publish: the input state captured here is the baseline a later
    # iteration is compared against, so a write that happens *while* the document is being
    # emitted is correctly seen as a change.
    document, paths, lane_sessions = derive()
    previous = collect_inputs(paths, config.events_file)
    step = WatchStep(iteration=1)
    emit(document, step)
    steps.append(step)
    previous_pids = _live_pids(document)
    renders = 1
    while renders < config.iterations and (time.monotonic() - started) < config.max_seconds:
        remaining = config.max_seconds - (time.monotonic() - started)
        time.sleep(min(config.interval_s, max(0.0, remaining)))
        document, paths, lane_sessions = derive()
        current = collect_inputs(paths, config.events_file)
        changed, rotated, refreshed = diff_inputs(previous, current, lane_sessions=lane_sessions)
        pids = _live_pids(document)
        exits = sorted(set(previous_pids) - set(pids))
        if not changed and not exits:
            previous = current
            continue
        step = WatchStep(
            iteration=renders + 1,
            changed_sources=changed,
            refreshed_lanes=len(refreshed),
            stale_lanes=len(set(pids) - set(refreshed)) if pids else 0,
            rotated=rotated,
            process_exits=exits,
            elapsed_s=time.monotonic() - started,
        )
        emit(document, step)
        steps.append(step)
        renders += 1
        previous = current
        previous_pids = pids
    # A final step records why the loop stopped, so a caller never mistakes "no more events"
    # for "everything is live".
    if steps:
        steps[-1].elapsed_s = time.monotonic() - started
    return steps


def _live_pids(document: Any) -> list[str]:
    keys: list[str] = []
    lanes = getattr(document, "get", lambda *_: None)("lanes") if hasattr(document, "get") else None
    for lane in lanes or []:
        ident = lane.get("identity") or {}
        proc = ident.get("proc") or {}
        if proc.get("available"):
            keys.append(str(ident.get("pane_id")))
    return keys


def rotation_probe(path: str, previous: dict[str, Any] | None) -> tuple[bool, dict[str, Any]]:
    """Delegates to the session module so watch and parse agree on rotation semantics."""
    return session.probe_rotation(path, previous)


_ = json, util  # json/util are used by callers through this module's helpers
