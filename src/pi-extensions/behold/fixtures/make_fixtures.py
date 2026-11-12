#!/usr/bin/env python3
"""Build the synthetic fixture fleet used by the tests and the read-only proof.

Everything here is synthetic **by construction**: no capture of the live fleet is involved,
and every store that must never surface in output carries an unmistakable sentinel
(``SENTINEL_*``). The generator also creates a real (throwaway) git repository under
``repos/`` so the repo adapter is exercised by a genuine ``git status``, and a ``.jj``
directory is present for the jj lane without ever invoking jj.

Layout (all relative to the root argument)::

    herdr/snapshot.json
    proc/sys/kernel/random/boot_id
    proc/<pid>/stat, proc/<pid>/environ
    pil/sessions/<lane>.json
    instances/<instance>/{pi-profile,pi-profile-state,pi-todo-state,settings}.json
    instances/<instance>/{modes,sessions}/...
    profiles/{leader,worker}.json
    modes/{leader,worker}.json
    models-store.json
    agent/{bizzy,pi-goal,settings}.json, agent/rooms/...
    state/{cron/tasks.json, dagr/..., beads/issues.json, pi-bg/*.log}
    repos/<name>/            (real git repo, throwaway)

Purge safety: ``--root`` must be empty or a previously generated fixture (it contains
``FIXTURE_STAMP``), otherwise the generator refuses. It never writes outside the root.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

STAMP = "FIXTURE_STAMP"
BASE = datetime(2026, 11, 11, 2, 0, 0, tzinfo=timezone.utc)
AS_OF = "2026-11-11T03:00:00Z"

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

BOOT_ID = "11111111-2222-3333-4444-555555555555"
U_PIN = "aaaaaaaa-0000-4000-8000-000000000001"


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def epoch_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def _write_json(path: str, value: Any) -> None:
    _write(path, json.dumps(value, indent=2, sort_keys=False) + "\n")


# --- session builder -------------------------------------------------------------

class Sess:
    def __init__(self, uuid: str, cwd: str, start: datetime, version: int = 3,
                 parent_session: str | None = None):
        self.uuid = uuid
        self.cwd = cwd
        self.start = start
        self.version = version
        self.lines: list[dict[str, Any]] = []
        self.header = {"type": "session", "version": version, "id": uuid,
                       "timestamp": iso(start), "cwd": cwd}
        if parent_session:
            self.header["parentSession"] = parent_session
        self._n = 0
        self._last: str | None = None

    def _id(self) -> str:
        self._n += 1
        return f"e{self._n:04d}"

    def branch_from(self, entry_id: str) -> None:
        """Move the leaf back to an earlier entry (what /tree does) without adding a line."""
        self._last = entry_id

    def add(self, entry: dict[str, Any], *, parent: str | None = "__last__") -> str:
        eid = entry.pop("id", None) or self._id()
        entry = {"id": eid, "parentId": self._last if parent == "__last__" else parent, **entry}
        entry.setdefault("timestamp", iso(self.start + timedelta(minutes=self._n)))
        self.lines.append(entry)
        self._last = eid
        return eid

    def system(self, sections: dict[str, Any], tools_added: Iterable[str] = (),
               tools_removed: Iterable[str] = ()) -> str:
        return self.add({
            "type": "message",
            "message": {
                "role": "system",
                "content": "",
                "sections": sections,
                "toolsAdded": [{"name": n, "description": "synthetic", "parameters": {}} for n in tools_added],
                "toolsRemoved": [{"name": n, "description": "synthetic", "parameters": {}} for n in tools_removed],
                "timestamp": epoch_ms(self.start),
            },
        })

    def user(self, text: str = "") -> str:
        return self.add({
            "type": "message",
            "message": {"role": "user", "content": text, "timestamp": epoch_ms(self.start)},
        })

    def assistant(self, *, provider: str, model: str, usage: dict[str, Any] | None,
                  duration_ms: float | None = 1200.0, stop: str = "stop",
                  error: str | None = None, thinking: str | None = "high",
                  tools: Iterable[str] = (), text: str = "") -> str:
        content: list[dict[str, Any]] = []
        if text:
            content.append({"type": "text", "text": text})
        for name in tools:
            content.append({"type": "toolCall", "id": "call_" + name, "name": name,
                            "arguments": {"note": SENTINELS["tool_arguments"]}})
        msg: dict[str, Any] = {
            "role": "assistant",
            "content": content,
            "api": "synthetic",
            "provider": provider,
            "model": model,
            "usage": usage if usage is not None else {},
            "stopReason": stop,
            "timestamp": epoch_ms(self.start),
        }
        if thinking:
            msg["thinkingLevel"] = thinking
        if duration_ms is not None:
            msg["durationMs"] = duration_ms
        if error:
            msg["errorMessage"] = error
        return self.add({"type": "message", "message": msg})

    def model_change(self, provider: str, model_id: str) -> str:
        return self.add({"type": "model_change", "provider": provider, "modelId": model_id})

    def thinking_change(self, level: str) -> str:
        return self.add({"type": "thinking_level_change", "thinkingLevel": level})

    def usage(self, kind: str, usage: dict[str, Any], provider: str, model: str) -> str:
        return self.add({"type": "usage", "kind": kind, "provider": provider, "model": model,
                         "usage": usage})

    def compaction(self, tokens_before: int, first_kept: str, usage: dict[str, Any] | None = None) -> str:
        entry: dict[str, Any] = {
            "type": "compaction",
            "summary": SENTINELS["session_message"],
            "firstKeptEntryId": first_kept,
            "tokensBefore": tokens_before,
            "systemMessage": {"role": "system", "content": "synthetic", "toolsAdded": [], "timestamp": epoch_ms(self.start)},
        }
        if usage:
            entry["usage"] = usage
        return self.add(entry)

    def branch_summary(self, from_id: str, usage: dict[str, Any] | None = None) -> str:
        entry: dict[str, Any] = {"type": "branch_summary", "fromId": from_id,
                                 "summary": SENTINELS["session_message"]}
        if usage:
            entry["usage"] = usage
        return self.add(entry)

    def custom(self, custom_type: str, data: Any) -> str:
        return self.add({"type": "custom", "customType": custom_type, "data": data})

    def context_edit(self, target_id: str) -> str:
        return self.add({"type": "context_edit", "targetId": target_id, "replacement": None})

    def session_info(self, name: str) -> str:
        return self.add({"type": "session_info", "name": name})

    def text(self, *, truncate_last: bool = False) -> str:
        lines = [json.dumps(self.header)] + [json.dumps(line) for line in self.lines]
        body = "\n".join(lines)
        if truncate_last:
            # A live session being appended to right now: the final object is half-written.
            body += "\n" + '{"type":"message","id":"e9999","parentId":"e9998","timestamp":"2026-11-11T02:59:5'
        else:
            body += "\n"
        return body


def usage(inp: int, out: int, cache_read: int = 0, cache_write: int = 0,
          total_from_provider: bool = False, cost: float | None = None) -> dict[str, Any]:
    total = inp + out + cache_read + cache_write
    cost_total = cost if cost is not None else round(total / 1_000_000 * 3, 6)
    return {
        "input": inp,
        "output": out,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "reasoning": 0,
        "totalTokens": total,
        "cost": {"input": round(inp / 1e6, 6), "output": round(out / 1e6, 6),
                 "cacheRead": round(cache_read / 1e6, 6), "cacheWrite": round(cache_write / 1e6, 6),
                 "total": cost_total, "totalFromProvider": total_from_provider},
    }


SKILLS_SECTION = (
    "\n\nThe following skills provide specialized instructions for specific tasks.\n"
    "Use the read tool to load a skill's file when the task matches its description.\n"
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.\n"
    "\n<available_skills>\n"
    "  <skill>\n    <name>beads</name>\n"
    f"    <description>{SENTINELS['skill_body']}</description>\n"
    "    <location>/synthetic/skills/beads/SKILL.md</location>\n  </skill>\n"
    "  <skill>\n    <name>context-economy</name>\n"
    f"    <description>{SENTINELS['skill_body']}</description>\n"
    "    <location>/synthetic/skills/context-economy/SKILL.md</location>\n  </skill>\n"
    "</available_skills>"
)


MODE_FINGERPRINT_MODE = {
    "schemaVersion": 1,
    "key": "leader",
    "label": "Leader",
    "description": "synthetic leader mode",
    "promptStrategy": "append",
    "systemPrompt": "Synthetic leader prompt body.",
    "requires": ["worker"],
    "conflictsWith": [],
    "before": [],
    "after": [],
}


def mode_fingerprint(mode: dict[str, Any], scope: str, path: str) -> str:
    """Same canonical form as pi-modes' modeDefinitionFingerprint."""
    import hashlib

    canonical = json.dumps(
        {
            "schemaVersion": mode["schemaVersion"],
            "key": mode["key"],
            "label": mode["label"],
            "description": mode.get("description"),
            "promptStrategy": mode["promptStrategy"],
            "systemPrompt": mode["systemPrompt"],
            "requires": sorted(mode.get("requires") or []),
            "conflictsWith": sorted(mode.get("conflictsWith") or []),
            "before": sorted(mode.get("before") or []),
            "after": sorted(mode.get("after") or []),
            "scope": scope,
            "path": path,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# --- main generator ----------------------------------------------------------------

def generate(root: str, *, lanes: int = 61) -> dict[str, Any]:
    root = os.path.abspath(root)
    if os.path.exists(root) and os.listdir(root):
        if not os.path.exists(os.path.join(root, STAMP)):
            raise SystemExit(f"refusing to write into a non-fixture directory: {root}")
        shutil.rmtree(root)
    os.makedirs(root, exist_ok=True)
    _write(os.path.join(root, STAMP), "synthetic fixture fleet; safe to delete\n")

    paths = {
        "herdr": os.path.join(root, "herdr"),
        "proc": os.path.join(root, "proc"),
        "pil": os.path.join(root, "pil", "sessions"),
        "instances": os.path.join(root, "instances"),
        "profiles": os.path.join(root, "profiles"),
        "modes": os.path.join(root, "modes"),
        "agent": os.path.join(root, "agent"),
        "state": os.path.join(root, "state"),
        "repos": os.path.join(root, "repos"),
        "bg": os.path.join(root, "state", "pi-bg"),
    }
    for path in paths.values():
        os.makedirs(path, exist_ok=True)

    _write(os.path.join(paths["proc"], "sys/kernel/random/boot_id"), BOOT_ID + "\n")

    # -- profiles / modes / models ------------------------------------------------
    worker_profile = {
        "label": "Worker", "description": "synthetic worker profile",
        "skills": ["beads", "context-economy"], "tools": ["read", "bash", "edit"],
        "defaultProvider": "acme", "defaultModel": "acme-fast-1",
        "defaultThinkingLevel": "high",
    }
    leader_profile = dict(worker_profile, label="Leader", defaultModel="acme-large-1")
    for name, profile in (("worker", worker_profile), ("leader", leader_profile)):
        _write_json(os.path.join(paths["profiles"], f"{name}.json"), profile)

    global_mode = dict(MODE_FINGERPRINT_MODE)
    global_mode_path = os.path.join(paths["modes"], "leader.json")
    _write_json(global_mode_path, global_mode)
    drift_mode = dict(global_mode, systemPrompt="Synthetic leader prompt body. EDITED")
    _write_json(os.path.join(paths["modes"], "worker.json"), dict(drift_mode, key="worker", label="Worker"))

    models = {
        "providers": {
            "acme": {"models": [
                {"id": "acme-large-1", "name": "Acme Large", "api": "synthetic",
                 "provider": "acme", "reasoning": True, "contextWindow": 200000, "maxTokens": 32000},
                {"id": "acme-fast-1", "name": "Acme Fast", "api": "synthetic",
                 "provider": "acme", "reasoning": False, "contextWindow": 128000, "maxTokens": 16000},
            ]},
            "virtual": {"models": [
                {"id": "router-1", "name": "Virtual Router", "api": "synthetic",
                 "provider": "virtual", "reasoning": True, "contextWindow": 1000000, "maxTokens": 64000},
            ]},
            # acme-legacy is deliberately absent: the kappa lane must render T-2/T-3 unknown.
        }
    }
    _write_json(os.path.join(root, "models-store.json"), models)

    # -- agent state ---------------------------------------------------------------
    _write_json(os.path.join(paths["agent"], "rooms", "names.json"), {
        "pins": {
            f"pane:{p}": {"name": n, **({"procId": "1:R"} if i == 0 else {})}
            for i, (p, n) in enumerate([
                ("w1A:p1", "alpha-leader"), ("w1A:p2", "alpha-worker"),
                ("w1B:p1", "beta-worker"), ("w2:p1", "held-lane"),
                ("wE:t19", "reserved-lane"), ("w1C:p2", "delta-nosession"),
                ("w1D:p1", "epsilon-multimb"), ("w1D:p2", "zeta-partial"),
                ("w1E:p1", "eta-dead"), ("w1F:p1", "theta-todo-conflict"),
                ("w1F:p2", "iota-virtual"), ("w1G:p1", "kappa-jj"),
                ("w1G:p2", "lambda-privacy"), ("w1H:p1", "mu-restore"),
                ("w1H:p2", "nu-two-spelling"),
            ])
        }
    })
    os.makedirs(os.path.join(paths["agent"], "rooms", "registry"), exist_ok=True)
    _write_json(os.path.join(paths["agent"], "rooms", "registry", "leaders.json"),
                {"room": "leaders", "members": ["alpha-leader"]})
    rooms_dir = os.path.join(paths["agent"], "rooms", "rooms")
    _write_json(os.path.join(rooms_dir, "leaders.json"),
                {"room": "leaders", "members": ["alpha-leader", "beta-worker"],
                 "body": SENTINELS["room_body"]})
    _write_json(os.path.join(rooms_dir, "workers.json"),
                {"room": "workers", "members": ["alpha-worker", "kappa-jj"],
                 "body": SENTINELS["room_body"]})
    _write_json(os.path.join(paths["agent"], "bizzy.json"), {"disabledTools": ["agent_bg"]})
    _write_json(os.path.join(paths["agent"], "pi-goal.json"), {
        "toolVisibility": "after-first-goal",
        "experimental": {"goals": True, "notices": False},
        "rpc": {"enabled": True},
    })
    _write_json(os.path.join(paths["agent"], "settings.json"), {
        "packages": [
            {"name": "pi-modes", "ref": "v9"},
            {"name": "herdr-agent-state", "ref": "9"},
        ],
        "prompts": ["/synthetic/prompts/review.md"],
        "skills": ["/synthetic/skills"],
        "promptBody": SENTINELS["prompt_body"],
        "apiKey": SENTINELS["api_key"],
    })

    # -- cron / dagr / beads / bg --------------------------------------------------
    _write_json(os.path.join(paths["state"], "cron", "tasks.json"), {
        "version": 2,
        "tasks": [
            {"id": "task_alpha", "projectDir": os.path.join(paths["repos"], "alpha"),
             "name": "alpha-heartbeat", "schedule": "*/15 * * * *",
             "prompt": SENTINELS["cron_prompt"]},
            {"id": "task_other", "projectDir": "/synthetic/repos/other",
             "name": "other", "prompt": SENTINELS["cron_prompt"]},
        ],
    })
    os.makedirs(os.path.join(paths["state"], "dagr", "runs"), exist_ok=True)
    run_one = os.path.join(paths["state"], "dagr", "runs", "run-one.json")
    run_two = os.path.join(paths["state"], "dagr", "runs", "run-two.json")
    _write_json(run_one, {
        "dagr": 3,
        "run": {"id": "run-1", "title": SENTINELS["dagr_title"], "started_at": "2026-11-11T01:00:00Z",
                "orchestrator": {"pane": "w1A:p1"}},
        "generated_at": "2026-11-11T02:30:00Z",
        "projects": [],
        "tasks": [
            {"id": "t1", "title": "synthetic", "owner": "ctx", "state": "done",
             "attempts": [{"id": "a1", "actor": "ctx", "locator": {"pane": "w1A:p1"},
                           "state": "ok", "liveness": {"prompt_acknowledged": True}}]},
            {"id": "t2", "title": "synthetic", "owner": "ctx", "state": "running",
             "attempts": [{"id": "a2", "actor": "ctx", "locator": {"pane": "w1A:p2"},
                           "state": "running", "liveness": {}}]},
        ],
        "events": [{"timestamp": "2026-11-11T02:10:00Z"}],
    })
    _write_json(run_two, {
        "dagr": 3,
        "run": {"id": "run-2", "title": SENTINELS["dagr_title"], "started_at": "2026-11-11T01:30:00Z",
                "orchestrator": {"pane": "w1G:p1"}},
        "generated_at": "2026-11-11T02:00:00Z",
        "projects": [],
        "tasks": [
            {"id": "t3", "title": "synthetic", "owner": "jj", "state": "done",
             "attempts": [{"id": "a3", "actor": "jj", "locator": {"pane": "w1G:p1"}, "state": "ok"}]},
        ],
        # An event newer than generated_at makes this run stale.
        "events": [{"timestamp": "2026-11-11T02:45:00Z"}],
    })
    _write(os.path.join(paths["state"], "dagr", "recent"), run_one + "\n" + run_two + "\n")

    issues = [
        {"id": "bd-1", "title": SENTINELS["bead_title"], "status": "open", "priority": 1,
         "issue_type": "task", "labels": ["project:w1A"], "owner": "alpha-leader",
         "metadata": {"agent_pane": "w1A:p1", "agent_session": U_PIN},
         "description": SENTINELS["bead_description"], "notes": SENTINELS["bead_notes"]},
        {"id": "bd-2", "title": SENTINELS["bead_title"], "status": "in_progress", "priority": 2,
         "issue_type": "task", "labels": ["project:w1A"], "owner": "alpha-leader",
         "metadata": {"agent_pane": "w1A:p1", "agent_session": U_PIN},
         "description": SENTINELS["bead_description"], "notes": SENTINELS["bead_notes"]},
        # owner match but no metadata: must be rejected, not attributed
        {"id": "bd-3", "title": SENTINELS["bead_title"], "status": "open", "priority": 3,
         "issue_type": "task", "labels": ["project:w1A"], "owner": "w1A:p1",
         "description": SENTINELS["bead_description"], "notes": SENTINELS["bead_notes"]},
        # project label match but no metadata: must be rejected
        {"id": "bd-4", "title": SENTINELS["bead_title"], "status": "open", "priority": 4,
         "issue_type": "task", "labels": ["project:w1A"], "owner": "someone",
         "description": SENTINELS["bead_description"], "notes": SENTINELS["bead_notes"]},
        # right pane, wrong session: must be rejected
        {"id": "bd-5", "title": SENTINELS["bead_title"], "status": "closed", "priority": 1,
         "issue_type": "task", "labels": ["project:w1A"], "owner": "alpha-leader",
         "metadata": {"agent_pane": "w1A:p1",
                      "agent_session": "bbbbbbbb-0000-4000-8000-000000000002"},
         "description": SENTINELS["bead_description"], "notes": SENTINELS["bead_notes"]},
    ]
    _write_json(os.path.join(paths["state"], "beads", "issues.json"), issues)
    _write(os.path.join(paths["bg"], "bg-0001.log"), "synthetic job output\n" * 5)
    _write(os.path.join(paths["bg"], "bg-0002.log"), "synthetic job output\n")

    # -- repos --------------------------------------------------------------------
    repo_alpha = os.path.join(paths["repos"], "alpha")
    repo_beta = os.path.join(paths["repos"], "beta")
    _repo_markers(repo_alpha, dirty=True)
    _repo_markers(repo_beta, dirty=False)
    jj_dir = os.path.join(paths["repos"], "jjspace")
    os.makedirs(os.path.join(jj_dir, ".jj"), exist_ok=True)
    _write(os.path.join(jj_dir, ".jj", "repo"), "synthetic\n")

    # -- lanes --------------------------------------------------------------------
    agents: list[dict[str, Any]] = []
    workspaces: dict[str, dict[str, Any]] = {}
    panes: list[dict[str, Any]] = []
    tabs: dict[str, dict[str, Any]] = {}

    def ws(workspace_id: str, label: str | None, worktree: dict[str, Any] | None = None,
           tokens: dict[str, Any] | None = None) -> None:
        entry = {"workspace_id": workspace_id, "label": label, "number": len(workspaces) + 1,
                 "tab_count": 1, "pane_count": 1, "focused": False,
                 "agent_status": "idle"}
        if worktree:
            entry["worktree"] = worktree
        if tokens:
            entry["tokens"] = tokens
        workspaces[workspace_id] = entry

    def wt(name: str) -> dict[str, Any]:
        root_path = os.path.join(paths["repos"], name)
        return {"checkout_path": root_path, "is_linked_worktree": False,
                "repo_root": root_path, "repo_name": name,
                "repo_key": os.path.join(root_path, ".git")}

    def lane(*, pane: str, workspace: str, tab: str, name: str, status: str,
             cwd: str, pid: int, session_path: str | None, session_uuid: str | None,
             extra: dict[str, Any] | None = None) -> None:
        tab_id = f"{workspace}:{tab}"
        tabs[tab_id] = {"tab_id": tab_id, "workspace_id": workspace, "label": name}
        agent = {
            "pane_id": pane, "workspace_id": workspace, "tab_id": tab_id,
            "agent": "pi", "name": name, "cwd": cwd, "foreground_cwd": cwd,
            "agent_status": status, "state_change_seq": 7,
        }
        if session_path and session_uuid:
            agent["agent_session"] = {"value": session_path, "reporter_pid": pid, "seq": 3}
        if extra:
            agent.update(extra)
        agents.append(agent)
        panes.append({"pane_id": pane, "workspace_id": workspace, "tab_id": tab_id,
                      "agent_status": status, "label": None})

    def instance_for(instance: str, uuid: str, cwd: str) -> str:
        project = "--" + cwd.strip("/").replace("/", "-") + "--"
        return os.path.join(paths["instances"], instance, "sessions", project,
                            f"2026-11-11T02-00-00-000Z_{uuid}.jsonl")

    def write_session(path: str, sess: Sess, *, truncate_last: bool = False) -> None:
        _write(path, sess.text(truncate_last=truncate_last))

    def pil_record(lane_name: str, pane: str, workspace: str, path: str | None,
                   uuid: str | None, pid: int, updated: str, tab: str | None = None,
                   boot_id: str | None = BOOT_ID, starttime: int | None = None) -> None:
        # boot_id/starttime are the *expected* process tuple. A record that omits them is
        # "unrecorded" (never "verified"); the fixture records them so the check can be tested
        # in both directions.
        record: dict[str, Any] = {
            "lane": lane_name, "session": path, "sessionId": uuid, "paneId": pane,
            "workspaceId": workspace, "tabId": tab or f"{workspace}:t", "hostname": "synthetic",
            "pid": pid, "updatedAt": updated, "source": "extension",
        }
        if boot_id is not None:
            record["boot_id"] = boot_id
        if starttime is not None:
            record["starttime"] = starttime
        _write_json(os.path.join(paths["pil"], f"{lane_name}.json"), record)

    def proc_record(pid: int, comm: str, starttime: int, profile: str, lane_name: str,
                    instance: str = "launch-A", pane: str = "", workspace: str = "",
                    tab: str = "") -> None:
        rest = ["S", "1"] + ["0"] * 17 + [str(starttime)]
        _write(os.path.join(paths["proc"], str(pid), "stat"),
               f"{pid} ({comm}) " + " ".join(rest) + "\n")
        # PI_CODING_AGENT_DIR is the only provenance for the lane's instance: it comes from
        # the verified process, not from a session path guess.
        env = (f"PI_PROFILE={profile}".encode() + b"\0"
               + f"PI_MODE=worker".encode() + b"\0"
               + f"PI_ROOMS_NAME={lane_name}".encode() + b"\0"
               + f"PI_CODING_AGENT_DIR={os.path.join(paths['instances'], instance)}".encode() + b"\0"
               + f"HERDR_PANE_ID={pane}".encode() + b"\0"
               + f"HERDR_WORKSPACE_ID={workspace}".encode() + b"\0"
               + f"HERDR_TAB_ID={tab}".encode() + b"\0"
               + f"UNRELATED_SECRET={SENTINELS['env_value']}".encode() + b"\0")
        _write(os.path.join(paths["proc"], str(pid), "environ"), env.decode())

    # workspace + lanes for the special cases
    ws("w1A", "alpha-workspace", wt("alpha"))
    ws("w1B", "beta-workspace", wt("beta"))
    ws("w2", "held-workspace", wt("alpha"))
    ws("w1C", "gamma-workspace", wt("alpha"))
    ws("w1D", "delta-workspace", wt("alpha"))
    ws("w1E", "epsilon-workspace", wt("alpha"))
    ws("w1F", "zeta-workspace", wt("beta"))
    ws("w1G", "eta-workspace", None, {"jj_bookmark": "master:: @n"})
    ws("w1H", "theta-workspace", None)

    # 1. alpha-leader: full happy path
    cwd = os.path.join(paths["repos"], "alpha")
    s = Sess(U_PIN, cwd, BASE)
    s.system({"preamble": "synthetic", "skills": SKILLS_SECTION, "cwd": cwd},
             tools_added=["read", "bash", "edit", "write", "monitor", "bash_bg"])
    s.model_change("acme", "acme-large-1")
    s.thinking_change("high")
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-large-1", usage=usage(1000, 200, 20000, 0),
                tools=["bash_bg"])
    m2 = s.model_change("acme", "acme-large-1")
    s.assistant(provider="acme", model="acme-large-1", usage=usage(1200, 300, 30000, 0),
                tools=["monitor"])
    s.custom("pi-mode-state.v3", {
        "baseKey": "leader", "overlayKeys": [], "driftPolicy": "block",
        "activatedAt": iso(BASE), "source": "startup",
        "fingerprints": {"leader": {"digest": mode_fingerprint(MODE_FINGERPRINT_MODE, "global", global_mode_path),
                                    "scope": "global", "path": global_mode_path}},
    })
    s.custom("pi-core-todo-state", {"tasks": [
        {"id": 1, "subject": SENTINELS["todo_subject"], "status": "completed"},
        {"id": 2, "subject": SENTINELS["todo_subject"], "status": "in_progress"},
        {"id": 3, "subject": SENTINELS["todo_subject"], "status": "pending"},
    ], "nextId": 4})
    s.custom("pi-goals.state", {"goals": [
        {"id": "g1", "status": "active", "text": SENTINELS["goal_text"]},
        {"id": "g2", "status": "queued", "text": SENTINELS["goal_text"]},
    ], "queue": [{"id": "g2", "status": "queued", "text": SENTINELS["goal_text"]}]})
    s.session_info("alpha-leader")
    alpha_session = instance_for("launch-A", U_PIN, cwd)
    write_session(alpha_session, s)
    _write_json(os.path.join(paths["instances"], "launch-A", "pi-todo-state.json"),
                {U_PIN: {"tasks": [{"id": 1, "status": "completed"},
                                   {"id": 2, "status": "in_progress"},
                                   {"id": 3, "status": "pending"}], "nextId": 4}})
    _write_json(os.path.join(paths["instances"], "launch-A", "pi-profile.json"), {
        "profile": "leader", "source": "global", "agentDir": "/synthetic/agent",
        "tools": ["read", "bash", "edit"], "toolReferences": ["read", "bash"],
        "resolved": {"skills": [{"name": "beads", "filePath": "/synthetic/skills/beads/SKILL.md"},
                                {"name": "context-economy",
                                 "filePath": "/synthetic/skills/context-economy/SKILL.md"}]},
    })
    _write_json(os.path.join(paths["instances"], "launch-A", "pi-profile-state.json"),
                {"activeProfile": "worker"})
    _write_json(os.path.join(paths["instances"], "launch-A", "settings.json"),
                {"packages": [{"name": "pi-modes", "ref": "v9"}],
                 "prompts": ["/synthetic/prompts/alpha.md"]})
    _write_json(os.path.join(paths["instances"], "launch-A", "pi-profile.pi-profile.json"),
                {"not": "used"})
    lane(pane="w1A:p1", workspace="w1A", tab="t1", name="alpha-leader", status="working",
         cwd=cwd, pid=4001, session_path=alpha_session, session_uuid=U_PIN)
    pil_record("alpha-leader", "w1A:p1", "w1A", alpha_session, U_PIN, 4001, iso(BASE + timedelta(minutes=50)), tab="w1A:t1", starttime=900001)
    proc_record(4001, "pi", 900001, "leader", "alpha-leader", "launch-A", "w1A:p1", "w1A", "w1A:t1")

    # 2. alpha-worker: branching session with an abandoned, expensive branch
    u2 = "aaaaaaaa-0000-4000-8000-000000000002"
    cwd2 = os.path.join(paths["repos"], "alpha")
    s = Sess(u2, cwd2, BASE + timedelta(minutes=1))
    s.system({"preamble": "synthetic", "skills": SKILLS_SECTION, "cwd": cwd2},
             tools_added=["read", "bash"])
    s.model_change("acme", "acme-fast-1")
    s.user(SENTINELS["session_message"])
    shared = s.assistant(provider="acme", model="acme-fast-1", usage=usage(500, 100, 0, 0))
    # abandoned branch: huge usage + a different model, then a branch_summary returns
    abandoned = s.add({"type": "message", "message": {
        "role": "assistant", "content": [], "provider": "acme", "model": "acme-large-1",
        "usage": usage(900000, 900000, 0, 0), "stopReason": "stop",
        "timestamp": epoch_ms(BASE), "durationMs": 5000, "thinkingLevel": "high"}},
        parent=shared)
    s.thinking_change("low")
    s.add({"type": "custom", "customType": "pi.experiment", "data": {"note": SENTINELS["session_message"]}},
          parent=abandoned)
    # active branch continues from the shared assistant entry: the abandoned branch above
    # stays in the file but is NOT on the active chain.
    s.branch_from(shared)
    s.model_change("acme", "acme-fast-1")
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(800, 150, 1000, 0), duration_ms=900.0)
    branch_session = instance_for("launch-A", u2, cwd2)
    write_session(branch_session, s)
    lane(pane="w1A:p2", workspace="w1A", tab="t2", name="alpha-worker", status="idle",
         cwd=cwd2, pid=4002, session_path=branch_session, session_uuid=u2)
    pil_record("alpha-worker", "w1A:p2", "w1A", branch_session, u2, 4002, iso(BASE + timedelta(minutes=40)), tab="w1A:t2", starttime=900002)
    proc_record(4002, "pi", 900002, "worker", "alpha-worker", "launch-A", "w1A:p2", "w1A", "w1A:t2")

    # 3. beta-worker: herdr pin is stale (points at another valid session), pil record wins
    u3 = "aaaaaaaa-0000-4000-8000-000000000003"
    u3_old = "aaaaaaaa-0000-4000-8000-0000000000ff"
    cwd3 = os.path.join(paths["repos"], "beta")
    old = Sess(u3_old, cwd3, BASE - timedelta(hours=5))
    old.system({"preamble": "synthetic", "cwd": cwd3}, tools_added=["read"])
    old.user(SENTINELS["session_message"])
    old.assistant(provider="acme", model="acme-fast-1", usage=usage(100, 10))
    stale_pin_path = instance_for("launch-B", u3_old, cwd3)
    write_session(stale_pin_path, old)
    s = Sess(u3, cwd3, BASE + timedelta(minutes=2))
    s.system({"preamble": "synthetic", "skills": SKILLS_SECTION, "cwd": cwd3}, tools_added=["read", "bash"])
    s.model_change("acme", "acme-fast-1")
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(900, 90, 4000, 0))
    current_pil = instance_for("launch-B", u3, cwd3)
    write_session(current_pil, s)
    lane(pane="w1B:p1", workspace="w1B", tab="t1", name="beta-worker", status="working",
         cwd=cwd3, pid=4003, session_path=stale_pin_path, session_uuid=u3_old)
    pil_record("beta-worker", "w1B:p1", "w1B", current_pil, u3, 4003, iso(BASE + timedelta(minutes=35)), tab="w1B:t1", starttime=900003)
    proc_record(4003, "pi", 900003, "worker", "beta-worker", "launch-B", "w1B:p1", "w1B", "w1B:t1")

    # 4. held by workspace (w2) — must be denied before any path read. It has its own
    #    session file so a test can prove that file is never opened.
    u4 = "aaaaaaaa-0000-4000-8000-000000000004"
    held = Sess(u4, os.path.join(paths["repos"], "alpha"), BASE + timedelta(minutes=3))
    held.system({"preamble": SENTINELS["prompt_body"], "cwd": "/synthetic"}, tools_added=["read"])
    held.user(SENTINELS["session_message"])
    held.assistant(provider="acme", model="acme-fast-1", usage=usage(1, 1))
    held_session = os.path.join(paths["instances"], "launch-HELD", "sessions", "held", f"2026-11-11T02-00-00-000Z_{u4}.jsonl")
    write_session(held_session, held)
    pil_record("held-lane", "w2:p1", "w2", held_session, u4, 4004, iso(BASE + timedelta(minutes=4)), tab="w2:t1", starttime=900004)
    proc_record(4004, "pi", 900004, "worker", "held-lane", "launch-HELD", "w2:p1", "w2", "w2:t1")
    lane(pane="w2:p1", workspace="w2", tab="t1", name="held-lane", status="working",
         cwd=os.path.join(paths["repos"], "alpha"), pid=4004,
         session_path=held_session, session_uuid=u4)

    # 5a. held by reserved pane id (legacy fixture: the old fake pane literally `wE:t19`)
    ws("w1C", "gamma-workspace", wt("alpha"))
    lane(pane="wE:t19", workspace="w1C", tab="t1", name="reserved-lane", status="blocked",
         cwd=os.path.join(paths["repos"], "alpha"), pid=4005,
         session_path=alpha_session, session_uuid=U_PIN)

    # 5b. reserved TAB with an innocent-looking pane: workspace=wE, tab=wE:t19, pane=wE:p99.
    # This is the real topology the independent review used to show V2 admitting a lane.
    u5b = "aaaaaaaa-0000-4000-8000-000000000005"
    ws("wE", "reserved-workspace", wt("alpha"))
    reserved_tab = Sess(u5b, os.path.join(paths["repos"], "alpha"), BASE + timedelta(minutes=4))
    reserved_tab.system({"preamble": SENTINELS["prompt_body"], "cwd": "/synthetic"},
                        tools_added=["read"])
    reserved_tab.user(SENTINELS["session_message"])
    reserved_tab.assistant(provider="acme", model="acme-fast-1", usage=usage(999, 99))
    reserved_tab_session = os.path.join(paths["instances"], "launch-RESERVED", "sessions", "t19",
                                        f"2026-11-11T02-00-00-000Z_{u5b}.jsonl")
    write_session(reserved_tab_session, reserved_tab)
    pil_record("reserved-tab-lane", "wE:p99", "wE", reserved_tab_session, u5b, 4016,
               iso(BASE + timedelta(minutes=5)), tab="wE:t19", starttime=900016)
    proc_record(4016, "pi", 900016, "worker", "reserved-tab-lane", "launch-RESERVED", "wE:p99", "wE", "wE:t19")
    lane(pane="wE:p99", workspace="wE", tab="t19", name="reserved-tab-lane", status="working",
         cwd=os.path.join(paths["repos"], "alpha"), pid=4016,
         session_path=reserved_tab_session, session_uuid=u5b)

    # 6. no session source at all
    lane(pane="w1C:p2", workspace="w1C", tab="t2", name="delta-nosession", status="unknown",
         cwd=os.path.join(paths["repos"], "alpha"), pid=4006, session_path=None, session_uuid=None)

    # 7. multi-MB branching session (substantially bigger than 398 KiB)
    u7 = "aaaaaaaa-0000-4000-8000-000000000007"
    cwd7 = os.path.join(paths["repos"], "beta")
    s = Sess(u7, cwd7, BASE)
    s.system({"preamble": "synthetic", "skills": SKILLS_SECTION, "cwd": cwd7},
             tools_added=["read", "bash", "edit", "write"])
    s.model_change("acme", "acme-large-1")
    padding = "x" * 1600
    shared_id = s.user(SENTINELS["session_message"] + padding)
    for i in range(1150):
        s.assistant(provider="acme", model="acme-large-1",
                    usage=usage(400, 120, 2000, 0), duration_ms=700.0 + i,
                    text=padding)
        s.user(SENTINELS["session_message"] + padding)
    # abandoned tail from an earlier point; remember the real active leaf first
    active_leaf = s._last
    for i in range(40):
        s.add({"type": "message", "message": {
            "role": "assistant", "content": [{"type": "text", "text": padding}],
            "provider": "acme", "model": "acme-fast-1",
            "usage": usage(300000, 300000, 0, 0), "stopReason": "stop",
            "timestamp": epoch_ms(BASE), "durationMs": 100.0}}, parent=shared_id)
    s.branch_from(active_leaf)
    s.assistant(provider="acme", model="acme-large-1", usage=usage(700, 200, 5000, 0),
                duration_ms=800.0, text=padding)
    big_session = instance_for("launch-D", u7, cwd7)
    write_session(big_session, s)
    lane(pane="w1D:p1", workspace="w1D", tab="t1", name="epsilon-multimb", status="working",
         cwd=cwd7, pid=4007, session_path=big_session, session_uuid=u7)
    pil_record("epsilon-multimb", "w1D:p1", "w1D", big_session, u7, 4007, iso(BASE + timedelta(minutes=20)), tab="w1D:t1", starttime=900007)
    proc_record(4007, "pi", 900007, "worker", "epsilon-multimb", "launch-D", "w1D:p1", "w1D", "w1D:t1")

    # 8. partial final JSONL line + dead process
    u8 = "aaaaaaaa-0000-4000-8000-000000000008"
    s = Sess(u8, cwd7, BASE + timedelta(minutes=5))
    s.system({"preamble": "synthetic", "cwd": cwd7}, tools_added=["read"])
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(300, 30))
    partial_session = instance_for("launch-D", u8, cwd7)
    write_session(partial_session, s, truncate_last=True)
    lane(pane="w1D:p2", workspace="w1D", tab="t2", name="zeta-partial", status="idle",
         cwd=cwd7, pid=4008, session_path=partial_session, session_uuid=u8)
    pil_record("zeta-partial", "w1D:p2", "w1D", partial_session, u8, 4008, iso(BASE + timedelta(minutes=10)), tab="w1D:t2", starttime=900008)
    proc_record(4008, "pi", 900008, "worker", "zeta-partial", "launch-D", "w1D:p2", "w1D", "w1D:t2")

    # 9. dead lane: session + pil record, no process at all
    u9 = "aaaaaaaa-0000-4000-8000-000000000009"
    s = Sess(u9, cwd3, BASE - timedelta(hours=2))
    s.system({"preamble": "synthetic", "cwd": cwd3}, tools_added=["read"])
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(200, 20), duration_ms=None)
    dead_session = instance_for("launch-E", u9, cwd3)
    write_session(dead_session, s)
    lane(pane="w1E:p1", workspace="w1E", tab="t1", name="eta-dead", status="idle",
         cwd=cwd3, pid=4009, session_path=dead_session, session_uuid=u9)
    pil_record("eta-dead", "w1E:p1", "w1E", dead_session, u9, 4009,
               iso(BASE - timedelta(hours=1)), tab="w1E:t1", starttime=900009)

    # 10. TODO conflict: session 3 vs instance 5
    u10 = "aaaaaaaa-0000-4000-8000-000000000010"
    s = Sess(u10, cwd2, BASE + timedelta(minutes=6))
    s.system({"preamble": "synthetic", "cwd": cwd2}, tools_added=["read"])
    s.model_change("acme", "acme-fast-1")
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(400, 40))
    s.custom("pi-core-todo-state", {"tasks": [
        {"id": 1, "subject": SENTINELS["todo_subject"], "status": "completed"},
        {"id": 2, "subject": SENTINELS["todo_subject"], "status": "pending"},
        {"id": 3, "subject": SENTINELS["todo_subject"], "status": "pending"},
    ], "nextId": 4})
    conflict_session = instance_for("launch-A", u10, cwd2)
    write_session(conflict_session, s)
    _write_json(os.path.join(paths["instances"], "launch-A", "pi-todo-state.json"), {
        U_PIN: {"tasks": [{"id": 1, "status": "completed"}, {"id": 2, "status": "in_progress"},
                          {"id": 3, "status": "pending"}], "nextId": 4},
        u10: {"tasks": [{"id": 1, "status": "completed"}] + [
            {"id": i, "status": "pending"} for i in range(2, 6)], "nextId": 6},
    })
    lane(pane="w1F:p1", workspace="w1F", tab="t1", name="theta-todo-conflict", status="idle",
         cwd=cwd2, pid=4010, session_path=conflict_session, session_uuid=u10)
    pil_record("theta-todo-conflict", "w1F:p1", "w1F", conflict_session, u10, 4010,
               iso(BASE + timedelta(minutes=15)), tab="w1F:t1", starttime=900010)
    proc_record(4010, "pi", 900010, "worker", "theta-todo-conflict", "launch-A", "w1F:p1", "w1F", "w1F:t1")

    # 11. virtual model, legacy (no durationMs), cache_warm, compaction, failed response,
    #     text-only goal -> G-1 UNKNOWN, T-7 UNKNOWN
    u11 = "aaaaaaaa-0000-4000-8000-000000000011"
    s = Sess(u11, cwd3, BASE + timedelta(minutes=7))
    s.system({"preamble": "synthetic", "skills": SKILLS_SECTION, "cwd": cwd3}, tools_added=["read", "bash"])
    s.model_change("virtual", "router-1")
    s.user(SENTINELS["session_message"])
    kept = s.assistant(provider="acme", model="acme-fast-1", usage=usage(2000, 300, 50000, 0),
                       duration_ms=None)
    s.usage("cache_warm", usage(0, 0, 8000, 0), "acme", "acme-fast-1")
    s.usage("mystery-kind", usage(10, 1), "acme", "acme-fast-1")
    s.compaction(50000, kept, usage(100, 20))
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(2100, 120), duration_ms=None,
                stop="error", error=SENTINELS["session_message"])
    s.custom("pi-goal-state", {"objective": SENTINELS["goal_text"], "queue": SENTINELS["goal_text"]})
    virtual_session = instance_for("launch-B", u11, cwd3)
    write_session(virtual_session, s)
    lane(pane="w1F:p2", workspace="w1F", tab="t2", name="iota-virtual", status="blocked",
         cwd=cwd3, pid=4011, session_path=virtual_session, session_uuid=u11)
    pil_record("iota-virtual", "w1F:p2", "w1F", virtual_session, u11, 4011,
               iso(BASE + timedelta(minutes=25)), tab="w1F:t2", starttime=900011)
    proc_record(4011, "pi", 900011, "leader", "iota-virtual", "launch-B", "w1F:p2", "w1F", "w1F:t2")

    # 12. jj workspace, missing contextWindow for its model
    u12 = "aaaaaaaa-0000-4000-8000-000000000012"
    cwd12 = os.path.join(paths["repos"], "jjspace")
    s = Sess(u12, cwd12, BASE + timedelta(minutes=8))
    s.system({"preamble": "synthetic", "skills": SKILLS_SECTION, "cwd": cwd12}, tools_added=["read"])
    s.model_change("acme", "acme-legacy-1")
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-legacy-1", usage=usage(50, 5), duration_ms=None)
    jj_session = instance_for("launch-C", u12, cwd12)
    write_session(jj_session, s)
    lane(pane="w1G:p1", workspace="w1G", tab="t1", name="kappa-jj", status="idle",
         cwd=cwd12, pid=4012, session_path=jj_session, session_uuid=u12)
    pil_record("kappa-jj", "w1G:p1", "w1G", jj_session, u12, 4012, iso(BASE + timedelta(minutes=30)), tab="w1G:t1", starttime=900012)
    proc_record(4012, "pi", 900012, "worker", "kappa-jj", "launch-C", "w1G:p1", "w1G", "w1G:t1")

    # 13. privacy lane: every class-2 sentinel present in the stores it may touch
    u13 = "aaaaaaaa-0000-4000-8000-000000000013"
    s = Sess(u13, cwd2, BASE + timedelta(minutes=9))
    s.system({"preamble": SENTINELS["prompt_body"], "skills": SKILLS_SECTION, "cwd": cwd2},
             tools_added=["read", "bash", "monitor", "bash_bg"])
    s.model_change("acme", "acme-fast-1")
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(600, 60),
                tools=["monitor", "bash_bg"], text=SENTINELS["session_message"])
    s.custom("pi-core-todo-state", {"tasks": [
        {"id": 1, "subject": SENTINELS["todo_subject"], "status": "pending"}], "nextId": 2})
    s.custom("pi-goal-state", {"objective": SENTINELS["goal_text"], "queue": SENTINELS["goal_text"]})
    privacy_session = instance_for("launch-A", u13, cwd2)
    write_session(privacy_session, s)
    lane(pane="w1G:p2", workspace="w1G", tab="t2", name="lambda-privacy", status="working",
         cwd=cwd2, pid=4013, session_path=privacy_session, session_uuid=u13)
    pil_record("lambda-privacy", "w1G:p2", "w1G", privacy_session, u13, 4013,
               iso(BASE + timedelta(minutes=45)), tab="w1G:t2", starttime=900013)
    proc_record(4013, "pi", 900013, "worker", "lambda-privacy", "launch-A", "w1G:p2", "w1G", "w1G:t2")

    # 14. missing-field lane: restore_error, no worktree, no label, no completion_seq
    u14 = "aaaaaaaa-0000-4000-8000-000000000014"
    s = Sess(u14, cwd3, BASE + timedelta(minutes=10))
    s.system({"preamble": "synthetic", "cwd": cwd3}, tools_added=["read"])
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(80, 8))
    restore_session = instance_for("launch-B", u14, cwd3)
    write_session(restore_session, s)
    lane(pane="w1H:p1", workspace="w1H", tab="t1", name="mu-restore", status="unknown",
         cwd=cwd3, pid=4014, session_path=restore_session, session_uuid=u14)
    pil_record("mu-restore", "w1H:p1", "w1H", restore_session, u14, 4014,
               iso(BASE + timedelta(minutes=12)), tab="w1H:t1", starttime=900014)
    proc_record(4014, "pi", 900014, "worker", "mu-restore", "launch-B", "w1H:p1", "w1H", "w1H:t1")
    panes[-1]["restore_error"] = "terminal_restore_failed"
    panes[-1]["label"] = None
    agents[-1].pop("name", None)
    agents[-1].pop("completion_seq", None)
    tabs[agents[-1]["tab_id"]]["label"] = None

    # 15. two spellings: pin is a symlink to the same inode as the pil session path
    u15 = "aaaaaaaa-0000-4000-8000-000000000015"
    s = Sess(u15, cwd3, BASE + timedelta(minutes=11))
    s.system({"preamble": "synthetic", "cwd": cwd3}, tools_added=["read"])
    s.model_change("acme", "acme-fast-1")
    s.user(SENTINELS["session_message"])
    s.assistant(provider="acme", model="acme-fast-1", usage=usage(120, 12))
    real_session = instance_for("launch-B", u15, cwd3)
    write_session(real_session, s)
    alt_dir = os.path.join(root, "alt-spelling")
    os.makedirs(alt_dir, exist_ok=True)
    alt_link = os.path.join(alt_dir, f"2026-11-11T02-00-00-000Z_{u15}.jsonl")
    if os.path.lexists(alt_link):
        os.unlink(alt_link)
    os.symlink(real_session, alt_link)
    lane(pane="w1H:p2", workspace="w1H", tab="t2", name="nu-two-spelling", status="idle",
         cwd=cwd3, pid=4015, session_path=alt_link, session_uuid=u15)
    pil_record("nu-two-spelling", "w1H:p2", "w1H", real_session, u15, 4015,
               iso(BASE + timedelta(minutes=14)), tab="w1H:t2", starttime=900015)
    proc_record(4015, "pi", 900015, "worker", "nu-two-spelling", "launch-B", "w1H:p2", "w1H", "w1H:t2")

    # -- filler lanes to reach the roster scale ------------------------------------
    filler_needed = max(0, lanes - len(agents))
    for index in range(filler_needed):
        pane = f"w1Z:p{index + 1}"
        workspace = "w1Z"
        if workspace not in workspaces:
            ws(workspace, "filler-workspace", wt("beta"))
        uuid = f"cccccccc-0000-4000-8000-{index + 1:012d}"
        s = Sess(uuid, cwd3, BASE + timedelta(minutes=index))
        s.system({"preamble": "synthetic", "skills": SKILLS_SECTION, "cwd": cwd3},
                 tools_added=["read", "bash"])
        s.model_change("acme", "acme-fast-1")
        s.user(SENTINELS["session_message"])
        s.assistant(provider="acme", model="acme-fast-1", usage=usage(100 + index, 10 + index),
                    duration_ms=500.0)
        path = instance_for("launch-F", uuid, cwd3)
        write_session(path, s)
        lane(pane=pane, workspace=workspace, tab=f"t{index + 1}", name=f"filler-{index + 1}",
             status="idle", cwd=cwd3, pid=5000 + index, session_path=path, session_uuid=uuid)
        pil_record(f"filler-{index + 1}", pane, workspace, path, uuid, 5000 + index,
                   iso(BASE + timedelta(minutes=index)))
        proc_record(5000 + index, "pi", 950000 + index, "worker", f"filler-{index + 1}",
                    "launch-F", pane, workspace, f"{workspace}:t{index + 1}")

    workspaces["w1Z"] = workspaces.get("w1Z") or {
        "workspace_id": "w1Z", "label": "filler-workspace", "number": 99,
        "tab_count": filler_needed, "pane_count": filler_needed, "focused": False,
        "agent_status": "idle", "worktree": wt("beta")}

    snapshot = {
        "protocol": 22,
        "focused_workspace_id": "w1A",
        "focused_tab_id": "w1A:t1",
        "focused_pane_id": "w1A:p1",
        "workspaces": list(workspaces.values()),
        "tabs": list(tabs.values()),
        "panes": panes,
        "agents": agents,
        "layouts": [],
    }
    _write_json(os.path.join(paths["herdr"], "snapshot.json"), snapshot)

    return {
        "root": root,
        "lanes": len(agents),
        "as_of": AS_OF,
        "sentinels": SENTINELS,
        "sessions": {
            "held": held_session, "reserved_tab": reserved_tab_session,
            "alpha": alpha_session, "branching": branch_session, "stale_pin": stale_pin_path,
            "pil_truth": current_pil, "multi_mb": big_session, "partial": partial_session,
            "dead": dead_session, "todo_conflict": conflict_session,
            "virtual": virtual_session, "jj": jj_session, "privacy": privacy_session,
            "restore": restore_session, "two_spelling": real_session,
        },
    }


def _repo_markers(path: str, *, dirty: bool) -> None:
    """Create a repo-shaped directory **without running git**.

    V3 built real throwaway repositories with `git init/commit`, which made the suite depend
    on a git binary even though no adapter reads repository state any more (`R-7` is a
    `stat` on `.git`/`.jj`). The marker shape is enough for every remaining assertion and
    keeps the suite genuinely hermetic: no child process is spawned anywhere in this file.
    """
    if os.path.exists(path):
        shutil.rmtree(path)
    os.makedirs(os.path.join(path, ".git"))
    for name in ("HEAD", "config"):
        _write(os.path.join(path, ".git", name), f"synthetic {name}\n")
    _write(os.path.join(path, "README.md"), "synthetic fixture repo\n")
    if dirty:
        _write(os.path.join(path, "staged.txt"), "staged\n")
        _write(os.path.join(path, "untracked.txt"), "untracked\n")


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="generate the synthetic behold fixture fleet")
    parser.add_argument("root", help="fixture root to (re)create")
    parser.add_argument("--lanes", type=int, default=61, help="total lane count (default 61)")
    parser.add_argument("--json", action="store_true", help="print the manifest as JSON")
    args = parser.parse_args(list(argv) if argv is not None else None)
    manifest = generate(args.root, lanes=args.lanes)
    if args.json:
        print(json.dumps(manifest, indent=2))
    else:
        print(f"fixtures at {manifest['root']} with {manifest['lanes']} lanes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
