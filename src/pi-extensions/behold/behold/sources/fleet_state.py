"""Fleet state adapters: rooms, crons, dagr, beads, background-job logs.

Privacy rule for every one of these: read the file, keep only the allowlisted *structural*
keys, and never let a title, prompt, body, note, description or receipt reach the output.
Where a field is operator-useful but free text (bead title, dagr run title, monitor
description), it is withheld with a reason rather than published, per the approved
"counts and paths only" rule.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from .. import guard, util

# --- rooms ------------------------------------------------------------------------

def room_pin(agent_dir: str | None, pane_id: str | None, policy: guard.Policy) -> dict[str, Any]:
    """M-5: the lane's room name from ``rooms/names.json`` pins, keyed by pane."""
    out: dict[str, Any] = {"name": None, "procId": None, "path": None, "error": None}
    if not agent_dir or not pane_id:
        out["error"] = "no_agent_dir_or_pane"
        return out
    path = os.path.join(agent_dir, "rooms", "names.json")
    out["path"] = path
    if not os.path.exists(path):
        out["error"] = "rooms_names_missing"
        return out
    try:
        raw = guard.read_json(path, policy, "rooms-names")
    except (OSError, ValueError) as exc:
        out["error"] = f"unreadable:{exc.__class__.__name__}"
        return out
    pins = raw.get("pins") if isinstance(raw, dict) else None
    if not isinstance(pins, dict):
        out["error"] = "no_pins_object"
        return out
    entry = pins.get(f"pane:{pane_id}")
    if not isinstance(entry, dict):
        out["error"] = "no_pin_for_pane"
        return out
    if isinstance(entry.get("name"), str):
        out["name"] = entry["name"]
    if isinstance(entry.get("procId"), str):
        out["procId"] = entry["procId"]
    return out


def room_membership(agent_dir: str | None, name: str | None, policy: guard.Policy) -> dict[str, Any]:
    """M-6: room names the lane is listed in, plus counts. Names only, no bodies."""
    out: dict[str, Any] = {"rooms": [], "room_count": 0, "registry_count": 0, "error": None}
    if not agent_dir:
        out["error"] = "no_agent_dir"
        return out
    rooms_dir = os.path.join(agent_dir, "rooms", "rooms")
    registry_dir = os.path.join(agent_dir, "rooms", "registry")
    if os.path.isdir(registry_dir):
        try:
            out["registry_count"] = len(
                [n for n in os.listdir(registry_dir) if not n.startswith(".")]
            )
        except OSError:
            out["registry_count"] = 0
    if not name:
        out["error"] = "no_lane_name"
        return out
    if not os.path.isdir(rooms_dir):
        out["error"] = "rooms_dir_missing"
        return out
    try:
        entries = sorted(os.listdir(rooms_dir))
    except OSError as exc:
        out["error"] = f"rooms_unreadable:{exc.__class__.__name__}"
        return out
    for entry in entries:
        if entry.startswith("."):
            continue
        path = os.path.join(rooms_dir, entry)
        if not os.path.isfile(path):
            continue
        try:
            raw = guard.read_json(path, policy, "room-membership")
        except (OSError, ValueError, guard.DeniedRead):
            continue
        members = raw.get("members") if isinstance(raw, dict) else None
        names: list[str] = []
        if isinstance(members, list):
            for item in members:
                if isinstance(item, str):
                    names.append(item)
                elif isinstance(item, dict) and isinstance(item.get("name"), str):
                    names.append(item["name"])
        if name in names:
            room = raw.get("room") or raw.get("id") or os.path.splitext(entry)[0]
            out["rooms"].append(room if isinstance(room, str) else os.path.splitext(entry)[0])
    out["room_count"] = len(out["rooms"])
    return out


# --- crons ------------------------------------------------------------------------

CRON_ALLOWED_KEYS = ("id", "name", "projectDir", "schedule", "cron", "kind")


def crons_for(lane_cwd: str | None, tasks_path: str | None, policy: guard.Policy) -> dict[str, Any]:
    """C-1: crons whose ``projectDir`` is this lane's cwd. ``prompt`` is never read out."""
    out: dict[str, Any] = {"tasks": [], "count": 0, "path": tasks_path, "error": None,
                          "prompt_field_skipped": 0}
    if not tasks_path or not os.path.exists(tasks_path):
        out["error"] = "cron_tasks_missing"
        return out
    if not lane_cwd:
        out["error"] = "lane_cwd_unknown"
        return out
    try:
        raw = guard.read_json(tasks_path, policy, "cron-tasks")
    except (OSError, ValueError) as exc:
        out["error"] = f"unreadable:{exc.__class__.__name__}"
        return out
    tasks = raw.get("tasks") if isinstance(raw, dict) else None
    if not isinstance(tasks, list):
        out["error"] = "no_tasks_array"
        return out
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if task.get("projectDir") != lane_cwd:
            continue
        selected = {k: task[k] for k in CRON_ALLOWED_KEYS if isinstance(task.get(k), str)}
        if "prompt" in task:
            out["prompt_field_skipped"] += 1
        out["tasks"].append(selected)
    out["count"] = len(out["tasks"])
    return out


# --- dagr -------------------------------------------------------------------------

def load_dagr_runs(recent_path: str | None, policy: guard.Policy) -> list[dict[str, Any]]:
    """Parse the dagr index and every run it points at exactly once per process run."""
    if not recent_path or not os.path.exists(recent_path):
        return []
    try:
        index_text = guard.read_text(recent_path, policy, "dagr-index")
    except (OSError, ValueError, guard.DeniedRead):
        return []
    runs: list[dict[str, Any]] = []
    for path in [line.strip() for line in index_text.splitlines() if line.strip()]:
        if not os.path.exists(path):
            continue
        try:
            raw = guard.read_json(path, policy, "dagr-run")
        except (OSError, ValueError, guard.DeniedRead):
            continue
        if isinstance(raw, dict):
            runs.append({"path": path, "doc": raw})
    return runs


def dagr_runs(
    recent_path: str | None,
    pane_id: str | None,
    observations: dict[str, Any],
    policy: guard.Policy,
    *,
    preloaded: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """G-3/G-4: runs whose orchestrator or any task attempt names this pane.

    The locator only *maps* a run to a pane. It is not authority and not progress: task
    ``state`` values are reported as recorded, with the run's ``generated_at`` age and a
    staleness verdict when the run's own events are newer than its snapshot.
    """
    out: dict[str, Any] = {
        "runs": [],
        "count": 0,
        "path": recent_path,
        "error": None,
        "stale": False,
        "oldest_generated_age_s": None,
    }
    if preloaded is None:
        preloaded = load_dagr_runs(recent_path, policy)
        if not preloaded and (not recent_path or not os.path.exists(recent_path)):
            out["error"] = "dagr_index_missing"
            return out
    if not pane_id:
        out["error"] = "no_pane_id"
        return out
    now = observations.get("as_of") or time.time()
    for item in preloaded:
        path = item.get("path")
        raw = item.get("doc")
        if not isinstance(raw, dict):
            continue
        run = raw.get("run") if isinstance(raw.get("run"), dict) else {}
        orchestrator = run.get("orchestrator") if isinstance(run.get("orchestrator"), dict) else {}
        matched = orchestrator.get("pane") == pane_id
        tasks = raw.get("tasks") if isinstance(raw.get("tasks"), list) else []
        states: dict[str, int] = {}
        owners: dict[str, int] = {}
        task_count = 0
        for task in tasks:
            if not isinstance(task, dict):
                continue
            attempts = task.get("attempts") if isinstance(task.get("attempts"), list) else []
            pane_hit = False
            for attempt in attempts:
                if isinstance(attempt, dict):
                    locator = attempt.get("locator") if isinstance(attempt.get("locator"), dict) else {}
                    if locator.get("pane") == pane_id:
                        pane_hit = True
                        break
            if not pane_hit and not matched:
                continue
            task_count += 1
            state = task.get("state") if isinstance(task.get("state"), str) else "unknown"
            states[state] = states.get(state, 0) + 1
            owner = task.get("owner") if isinstance(task.get("owner"), str) else "unowned"
            owners[owner] = owners.get(owner, 0) + 1
        # The orchestrator pane alone is enough to attribute the run; task counts then cover
        # the whole run, which is what an operator wants to see for that lane.
        if not matched and task_count == 0:
            continue
        generated = util.parse_iso(raw.get("generated_at")) if isinstance(raw.get("generated_at"), str) else None
        events = raw.get("events") if isinstance(raw.get("events"), list) else []
        last_event_ts = None
        for event in events:
            if isinstance(event, dict):
                ts = util.parse_iso(event.get("timestamp") if isinstance(event.get("timestamp"), str) else None)
                if ts is not None and (last_event_ts is None or ts > last_event_ts):
                    last_event_ts = ts
        stale = bool(generated is not None and last_event_ts is not None and last_event_ts > generated)
        record = {
            "run_id": run.get("id") if isinstance(run.get("id"), str) else None,
            "title": None,
            "title_withheld": "class1_free_text",
            "started_at": run.get("started_at") if isinstance(run.get("started_at"), str) else None,
            "generated_at": raw.get("generated_at") if isinstance(raw.get("generated_at"), str) else None,
            "generated_age_s": None if generated is None else round(max(0.0, now - generated), 3),
            "task_states": dict(sorted(states.items())),
            "task_owners": dict(sorted(owners.items())),
            "tasks_matched": task_count if task_count else len(tasks),
            "orchestrator_match": matched,
            "stale": stale,
            "last_event_at": util.iso(last_event_ts),
            "path": path,
        }
        out["runs"].append(record)
        out["stale"] = out["stale"] or stale
    out["count"] = len(out["runs"])
    ages = [r["generated_age_s"] for r in out["runs"] if r["generated_age_s"] is not None]
    out["oldest_generated_age_s"] = max(ages) if ages else None
    if out["count"] == 0 and out["error"] is None:
        out["error"] = None
    return out


# --- beads ------------------------------------------------------------------------

def load_beads(issues_path: str | None, policy: guard.Policy) -> list[dict[str, Any]]:
    """Read the beads export once; the lane join runs against the parsed list."""
    if not issues_path or not os.path.exists(issues_path):
        return []
    try:
        raw = guard.read_json(issues_path, policy, "beads-export")
    except (OSError, ValueError, guard.DeniedRead):
        return []
    issues = raw if isinstance(raw, list) else raw.get("issues") if isinstance(raw, dict) else None
    return [i for i in issues if isinstance(i, dict)] if isinstance(issues, list) else []


def beads_for_lane(
    issues_path: str | None,
    *,
    pane_id: str | None,
    trusted_session_id: str | None,
    workspace_id: str | None,
    policy: guard.Policy,
    preloaded: list[dict[str, Any]] | None = None,
    untrusted_reason: str | None = None,
) -> dict[str, Any]:
    """B-1: the beads join is **explicit metadata only**.

    ``metadata.agent_pane`` and ``metadata.agent_session`` must both be present and must
    match the lane's pane and its *validated* session id. A matching ``owner``, a
    ``project:<workspace>`` label, or a bead id quoted in prompt text is **not** a join:
    labels establish project scope only, the owner is a mutable handle, and prompt content
    is never parsed. Without validated session identity the join refuses, because an
    unvalidated attribution is worse than a count of zero with a reason.
    """
    out: dict[str, Any] = {
        "issues": [],
        "count": 0,
        "by_status": {},
        "scoped_project_label": None,
        "path": issues_path,
        "error": None,
        "join": "metadata.agent_pane+metadata.agent_session",
        "rejected": {"owner_only": 0, "label_only": 0, "incomplete_metadata": 0},
    }
    if preloaded is None:
        preloaded = load_beads(issues_path, policy)
        if not preloaded:
            out["error"] = "beads_export_missing" if not issues_path or not os.path.exists(issues_path) else "no_issues_array"
            return out
    if not pane_id:
        out["error"] = "no_pane_id"
        return out
    if not trusted_session_id:
        # No *trusted* session identity means no explicit join key: refuse, never fall back
        # to owner/label/prompt text, and never join on a disagreement.
        out["error"] = (
            f"identity_untrusted:{untrusted_reason}" if untrusted_reason
            else "session_identity_not_validated"
        )
        out["untrusted_reason"] = untrusted_reason
        return out
    issues = preloaded
    project_label = f"project:{workspace_id}" if workspace_id else None
    out["scoped_project_label"] = project_label
    by_status: dict[str, int] = {}
    for issue in issues:
        if not isinstance(issue, dict):
            continue
        metadata = issue.get("metadata") if isinstance(issue.get("metadata"), dict) else {}
        meta_pane = metadata.get("agent_pane") if isinstance(metadata.get("agent_pane"), str) else None
        meta_session = (
            metadata.get("agent_session") if isinstance(metadata.get("agent_session"), str) else None
        )
        labels = issue.get("labels") if isinstance(issue.get("labels"), list) else []
        owner_match = isinstance(issue.get("owner"), str) and issue.get("owner") == pane_id
        label_match = project_label is not None and project_label in labels
        if meta_pane is None or meta_session is None:
            if owner_match:
                out["rejected"]["owner_only"] += 1
            elif label_match:
                out["rejected"]["label_only"] += 1
            else:
                out["rejected"]["incomplete_metadata"] += 1
            continue
        if meta_pane != pane_id:
            continue
        # Exact match only. A suffix match ("anything<uuid>") is forgeable, and a path-shaped
        # value must equal the validated session's realpath exactly, not merely contain it.
        if meta_session.lower() != trusted_session_id.lower():
            continue
        status = issue.get("status") if isinstance(issue.get("status"), str) else "unknown"
        by_status[status] = by_status.get(status, 0) + 1
        out["issues"].append(
            {
                "id": issue.get("id") if isinstance(issue.get("id"), str) else None,
                "status": status,
                "priority": issue.get("priority") if isinstance(issue.get("priority"), int) else None,
                "issue_type": issue.get("issue_type") if isinstance(issue.get("issue_type"), str) else None,
                "title": None,
                "title_withheld": "class1_free_text",
            }
        )
    out["by_status"] = dict(sorted(by_status.items()))
    out["count"] = len(out["issues"])
    return out


# --- background jobs ---------------------------------------------------------------

def bg_jobs(
    bg_dir: str | None,
    tool_calls: list[dict[str, Any]],
    observations: dict[str, Any],
    policy: guard.Policy,
) -> dict[str, Any]:
    """J-1: last-observed only. A log file's size/mtime is not a running state.

    The ``jobs`` tool keeps its state in the extension runtime; the filesystem only shows
    logs. So this is ``as_of last tool call`` with the log path as evidence, never "running".
    """
    out: dict[str, Any] = {
        "log_files": [],
        "log_count": 0,
        "tool_calls": tool_calls,
        "tool_call_count": len(tool_calls),
        "path": bg_dir,
        "error": None,
        "state_basis": "last_observed (session tool calls + log file stats)",
    }
    if not bg_dir or not os.path.isdir(bg_dir):
        out["error"] = "bg_dir_missing"
        return out
    now = observations.get("as_of") or time.time()
    try:
        names = sorted(os.listdir(bg_dir))
    except OSError as exc:
        out["error"] = f"unreadable:{exc.__class__.__name__}"
        return out
    for name in names:
        if not name.endswith(".log"):
            continue
        path = os.path.join(bg_dir, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        out["log_files"].append(
            {
                "job_id": name[: -len(".log")],
                "size": st.st_size,
                "mtime_age_s": round(max(0.0, now - st.st_mtime), 3),
                "path": path,
            }
        )
    out["log_count"] = len(out["log_files"])
    return out


def monitor_calls(tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    """J-2: last-known monitor tool calls. Exit state is unknowable from the session."""
    return {
        "calls": tool_calls,
        "count": len(tool_calls),
        "limitation": "monitor exit state is runtime-only; a later exit cannot be seen in session data",
        "state_basis": "last_observed (session tool calls)",
    }


def bizzy_state(agent_dir: str | None, policy: guard.Policy) -> dict[str, Any]:
    """J-3: bizzy holds only ``disabledTools``; there is no monitor registry to read."""
    out: dict[str, Any] = {"disabledTools": [], "path": None, "error": None}
    if not agent_dir:
        out["error"] = "no_agent_dir"
        return out
    path = os.path.join(agent_dir, "bizzy.json")
    out["path"] = path
    if not os.path.exists(path):
        out["error"] = "bizzy_state_missing"
        return out
    try:
        raw = guard.read_json(path, policy, "bizzy")
    except (OSError, ValueError) as exc:
        out["error"] = f"unreadable:{exc.__class__.__name__}"
        return out
    if isinstance(raw, dict) and isinstance(raw.get("disabledTools"), list):
        out["disabledTools"] = [t for t in raw["disabledTools"] if isinstance(t, str)]
    return out


def goals_file(agent_dir: str | None, policy: guard.Policy) -> dict[str, Any]:
    """G-1/G-2 companion: the goal *config* file carries no goal text and no queue."""
    out: dict[str, Any] = {"path": None, "keys": [], "error": None}
    if not agent_dir:
        out["error"] = "no_agent_dir"
        return out
    path = os.path.join(agent_dir, "pi-goal.json")
    out["path"] = path
    if not os.path.exists(path):
        out["error"] = "goal_config_missing"
        return out
    try:
        raw = guard.read_json(path, policy, "pi-goal-config")
    except (OSError, ValueError) as exc:
        out["error"] = f"unreadable:{exc.__class__.__name__}"
        return out
    if isinstance(raw, dict):
        out["keys"] = sorted(raw.keys())
        out["has_goal_text"] = any(isinstance(v, str) and len(v) > 64 for v in raw.values())
    return out


_ = json  # json is used indirectly via guard.read_json; kept for type clarity
