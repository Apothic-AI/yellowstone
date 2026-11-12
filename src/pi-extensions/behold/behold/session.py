"""Session-file reading, active-branch resolution, and derived aggregates.

Why the branch matters (binding correction #1): a pi session file is a *tree* serialized
as JSONL. The "leaf" is the current position in that tree; ``parentId`` links define the
active path. pi persists ``id``/``parentId`` but not the leaf id: on load,
``SessionManager._buildIndex`` walks the file and sets ``leafId = entry.id`` for every
entry, so the reconstructed leaf is the last entry in *file order*, and
``buildSessionPath(entries, leafId)`` then walks ``parentId`` back to the root. behold does
the same thing explicitly, and labels it:

    leaf = explicit hint (only if it exists in this file) else last entry in file order
    active branch = the ancestor chain from that leaf

Everything "current" (selected model, thinking level, mode, TODOs, context tokens, totals)
is computed **only from the active chain**. Abandoned branches remain on disk and are
reachable through ``/tree``, so summing every line, or reading the last ``model_change``
in file order regardless of branch, is wrong exactly when a lane branches. Fixtures
``branching`` and ``branch_abandoned_usage`` assert the difference.

Nothing here retains message text, tool arguments, goal text, TODO subjects, skill bodies
or prompt bodies: the parser keeps roles, names, numbers and paths, and drops content
before anything else can see it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field as dc_field
from typing import Any

from . import util

# --- compact entry ----------------------------------------------------------------

#: numeric usage keys we keep (cost is a nested dict of the same shape)
USAGE_KEYS = ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")
COST_KEYS = ("input", "output", "cacheRead", "cacheWrite", "total")


@dataclass
class Entry:
    type: str
    id: str | None = None
    parent: str | None = None
    ts: float | None = None
    ts_raw: str | None = None
    # message entries
    role: str | None = None
    provider: str | None = None
    model: str | None = None
    thinking: str | None = None
    usage: dict[str, float] | None = None
    cost: dict[str, float] | None = None
    cost_total_from_provider: bool | None = None
    stop_reason: str | None = None
    has_error_message: bool = False
    duration_ms: float | None = None
    msg_ts_ms: float | None = None
    sections: list[str] = dc_field(default_factory=list)
    skills: list[tuple[str, str]] = dc_field(default_factory=list)
    tools_added: list[str] = dc_field(default_factory=list)
    tools_removed: list[str] = dc_field(default_factory=list)
    tool_calls: list[str] = dc_field(default_factory=list)
    has_text: bool = False
    # non-message entries
    model_id: str | None = None
    custom_type: str | None = None
    data_keys: list[str] = dc_field(default_factory=list)
    mode_state: dict[str, Any] | None = None
    todo_state: dict[str, Any] | None = None
    goal_state: dict[str, Any] | None = None
    tokens_before: float | None = None
    first_kept: str | None = None
    has_system_message: bool = False
    target_id: str | None = None
    replacement_is_null: bool | None = None
    from_id: str | None = None
    label_present: bool = False
    session_name: str | None = None
    usage_kind: str | None = None


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _usage(raw: Any) -> tuple[dict[str, float] | None, dict[str, float] | None, bool | None]:
    if not isinstance(raw, dict):
        return None, None, None
    usage = {k: v for k in USAGE_KEYS if (v := _num(raw.get(k))) is not None}
    cost_raw = raw.get("cost")
    cost = None
    from_provider = None
    if isinstance(cost_raw, dict):
        cost = {k: v for k in COST_KEYS if (v := _num(cost_raw.get(k))) is not None}
        if isinstance(cost_raw.get("totalFromProvider"), bool):
            from_provider = cost_raw["totalFromProvider"]
    return (usage or None), cost, from_provider


def _skills_from_section(text: str) -> list[tuple[str, str]]:
    """Extract (name, location) pairs from the ``<available_skills>`` listing only."""
    out: list[tuple[str, str]] = []
    name = location = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("<name>") and line.endswith("</name>"):
            name = line[len("<name>") : -len("</name>")]
        elif line.startswith("<location>") and line.endswith("</location>"):
            location = line[len("<location>") : -len("</location>")]
            if name and location:
                out.append((name, location))
            name = location = None
    return out


def _tool_names(content: Any) -> list[str]:
    """Tool *names* from assistant content blocks; arguments are never kept."""
    names: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "toolCall":
                name = block.get("name")
                if isinstance(name, str):
                    names.append(name)
    return names


def _custom_summary(custom_type: str, data: Any) -> dict[str, Any]:
    """Extract only structural, non-content facts from a ``custom`` entry.

    Goal text, TODO subjects, activeForm strings and any other free text are dropped
    here, at parse time, so no downstream code can leak them by accident.
    """
    out: dict[str, Any] = {"keys": sorted(data.keys()) if isinstance(data, dict) else []}
    if not isinstance(data, dict):
        return out
    if custom_type.startswith("pi-mode-state"):
        fingerprints = {}
        raw_fp = data.get("fingerprints")
        if isinstance(raw_fp, dict):
            for key, fp in raw_fp.items():
                if isinstance(fp, dict):
                    fingerprints[str(key)] = {
                        "path": fp.get("path") if isinstance(fp.get("path"), str) else None,
                        "digest": fp.get("digest") if isinstance(fp.get("digest"), str) else None,
                        "scope": fp.get("scope") if isinstance(fp.get("scope"), str) else None,
                    }
        out["mode"] = {
            "baseKey": data.get("baseKey") if isinstance(data.get("baseKey"), str) else None,
            "overlayKeys": [k for k in data.get("overlayKeys", []) if isinstance(k, str)]
            if isinstance(data.get("overlayKeys"), list)
            else [],
            "driftPolicy": data.get("driftPolicy") if isinstance(data.get("driftPolicy"), str) else None,
            "activatedAt": data.get("activatedAt") if isinstance(data.get("activatedAt"), str) else None,
            "source": data.get("source") if isinstance(data.get("source"), str) else None,
            "fingerprints": fingerprints,
        }
    if "todo" in custom_type:
        tasks = data.get("tasks")
        counts: dict[str, int] = {}
        if isinstance(tasks, list):
            for task in tasks:
                if isinstance(task, dict):
                    status = task.get("status")
                    if isinstance(status, str):
                        counts[status] = counts.get(status, 0) + 1
        out["todo"] = {
            "total": len(tasks) if isinstance(tasks, list) else None,
            "by_status": dict(sorted(counts.items())),
            "has_subjects": bool(
                isinstance(tasks, list)
                and any(isinstance(t, dict) and isinstance(t.get("subject"), str) for t in tasks)
            ),
        }
    if "goal" in custom_type:
        # Structured counts only. A free-text-only store yields text_only=True, which the
        # lane renders as UNKNOWN(withheld) rather than guessing a count from prose.
        goals = data.get("goals")
        queue = data.get("queue")
        statuses: dict[str, int] = {}
        text_only = False
        # Counts come from the goal list only; the queue is a separate depth so a queued goal
        # is never counted twice.
        if isinstance(goals, list):
            for item in goals:
                if isinstance(item, dict) and isinstance(item.get("status"), str):
                    statuses[item["status"]] = statuses.get(item["status"], 0) + 1
        else:
            for seq in (goals, queue):
                if isinstance(seq, str) and seq.strip():
                    text_only = True
        for key, value in data.items():
            if isinstance(value, str) and value.strip() and key not in ("activatedAt", "source"):
                text_only = True
        out["goal"] = {
            "statuses": dict(sorted(statuses.items())),
            "count": len(goals) if isinstance(goals, list) else (len(queue) if isinstance(queue, list) else None),
            "queue_depth": len(queue) if isinstance(queue, list) else None,
            "text_only": text_only,
        }
    return out


def _compact(raw: dict[str, Any]) -> Entry:
    etype = raw.get("type")
    entry = Entry(
        type=etype if isinstance(etype, str) else "unknown",
        id=raw.get("id") if isinstance(raw.get("id"), str) else None,
        parent=raw.get("parentId") if isinstance(raw.get("parentId"), str) else None,
        ts_raw=raw.get("timestamp") if isinstance(raw.get("timestamp"), str) else None,
    )
    entry.ts = util.parse_iso(entry.ts_raw)
    if entry.type == "message":
        msg = raw.get("message") if isinstance(raw.get("message"), dict) else {}
        entry.role = msg.get("role") if isinstance(msg.get("role"), str) else None
        entry.provider = msg.get("provider") if isinstance(msg.get("provider"), str) else None
        entry.model = msg.get("model") if isinstance(msg.get("model"), str) else None
        entry.thinking = msg.get("thinkingLevel") if isinstance(msg.get("thinkingLevel"), str) else None
        entry.usage, entry.cost, entry.cost_total_from_provider = _usage(msg.get("usage"))
        entry.stop_reason = msg.get("stopReason") if isinstance(msg.get("stopReason"), str) else None
        entry.has_error_message = isinstance(msg.get("errorMessage"), str) and bool(msg["errorMessage"])
        entry.duration_ms = _num(msg.get("durationMs"))
        entry.msg_ts_ms = _num(msg.get("timestamp"))
        sections = msg.get("sections")
        if isinstance(sections, dict):
            entry.sections = [str(k) for k in sections.keys()]
            skill_text = sections.get("skills")
            if isinstance(skill_text, str):
                entry.skills = _skills_from_section(skill_text)
        for key, target in (("toolsAdded", entry.tools_added), ("toolsRemoved", entry.tools_removed)):
            seq = msg.get(key)
            if isinstance(seq, list):
                for item in seq:
                    if isinstance(item, dict) and isinstance(item.get("name"), str):
                        target.append(item["name"])
        entry.tool_calls = _tool_names(msg.get("content"))
        entry.has_text = bool(msg.get("content"))
    elif entry.type == "model_change":
        entry.provider = raw.get("provider") if isinstance(raw.get("provider"), str) else None
        entry.model_id = raw.get("modelId") if isinstance(raw.get("modelId"), str) else None
        entry.model = entry.model_id
    elif entry.type == "thinking_level_change":
        entry.thinking = raw.get("thinkingLevel") if isinstance(raw.get("thinkingLevel"), str) else None
    elif entry.type == "usage":
        entry.usage_kind = raw.get("kind") if isinstance(raw.get("kind"), str) else None
        entry.provider = raw.get("provider") if isinstance(raw.get("provider"), str) else None
        entry.model = raw.get("model") if isinstance(raw.get("model"), str) else None
        entry.usage, entry.cost, entry.cost_total_from_provider = _usage(raw.get("usage"))
    elif entry.type == "compaction":
        entry.tokens_before = _num(raw.get("tokensBefore"))
        entry.first_kept = raw.get("firstKeptEntryId") if isinstance(raw.get("firstKeptEntryId"), str) else None
        entry.has_system_message = isinstance(raw.get("systemMessage"), dict)
        entry.usage, entry.cost, entry.cost_total_from_provider = _usage(raw.get("usage"))
    elif entry.type == "branch_summary":
        entry.from_id = raw.get("fromId") if isinstance(raw.get("fromId"), str) else None
        entry.usage, entry.cost, entry.cost_total_from_provider = _usage(raw.get("usage"))
    elif entry.type == "custom":
        entry.custom_type = raw.get("customType") if isinstance(raw.get("customType"), str) else None
        summary = _custom_summary(entry.custom_type or "", raw.get("data"))
        entry.data_keys = summary["keys"]
        if "mode" in summary:
            entry.mode_state = summary["mode"]
        if "todo" in summary:
            entry.todo_state = summary["todo"]
        if "goal" in summary:
            entry.goal_state = summary["goal"]
    elif entry.type == "custom_message":
        entry.custom_type = raw.get("customType") if isinstance(raw.get("customType"), str) else None
        entry.has_text = bool(raw.get("content"))
    elif entry.type == "label":
        entry.target_id = raw.get("targetId") if isinstance(raw.get("targetId"), str) else None
        entry.label_present = bool(raw.get("label"))
    elif entry.type == "context_edit":
        entry.target_id = raw.get("targetId") if isinstance(raw.get("targetId"), str) else None
        entry.replacement_is_null = raw.get("replacement") is None
    elif entry.type == "session_info":
        name = raw.get("name")
        entry.session_name = name if isinstance(name, str) else None
    return entry


# --- the view ---------------------------------------------------------------------

CHAIN_OK = "ok"
CHAIN_EMPTY = "empty"
CHAIN_BROKEN = "broken_parent"
CHAIN_CYCLE = "cycle"
LEAF_HINT_INVALID = "leaf_hint_invalid"


@dataclass
class SessionView:
    path: str
    realpath: str
    version: int | None
    header_id: str | None
    header_cwd: str | None
    header_ts: float | None
    parent_session: str | None
    entries: list[Entry]
    by_id: dict[str, Entry]
    leaf_id: str | None
    leaf_source: str  # last_file_entry | leaf_hint
    chain: list[Entry]
    chain_state: str
    diagnostics: list[str] = dc_field(default_factory=list)
    partial_tail: bool = False
    malformed: int = 0
    duplicate_ids: int = 0
    bytes_read: int = 0
    lines: int = 0

    # -- identity ------------------------------------------------------------------
    @property
    def filename_uuid(self) -> str | None:
        return util.session_uuid_from_filename(self.path)

    def identity_checks(self) -> dict[str, Any]:
        header_matches_filename = (
            self.header_id is not None
            and self.filename_uuid is not None
            and self.header_id.lower() == self.filename_uuid.lower()
        )
        return {
            "header_id": self.header_id,
            "filename_uuid": self.filename_uuid,
            "header_matches_filename": header_matches_filename,
            "realpath": self.realpath,
            "version": self.version,
        }

    # -- selected settings on the active chain -------------------------------------
    def selected_model(self) -> tuple[str | None, str | None, float | None]:
        provider = model = None
        ts = None
        for entry in self.chain:
            if entry.type == "model_change" and entry.model_id:
                provider, model, ts = entry.provider, entry.model_id, entry.ts
        return provider, model, ts

    def physical_model(self) -> tuple[str | None, str | None, float | None]:
        provider = model = ts = None
        for entry in self.chain:
            if entry.type == "message" and entry.role == "assistant" and entry.model:
                provider, model, ts = entry.provider, entry.model, entry.ts
        return provider, model, ts

    def thinking_level(self) -> tuple[str | None, str | None]:
        level, source = None, None
        for entry in self.chain:
            if entry.type == "thinking_level_change" and entry.thinking:
                level, source = entry.thinking, "thinking_level_change"
        if level is None:
            for entry in self.chain:
                if entry.type == "message" and entry.role == "assistant" and entry.thinking:
                    level, source = entry.thinking, "last assistant thinkingLevel"
        return level, source

    # -- usage ------------------------------------------------------------------
    def _totals(self, entries: list[Entry]) -> dict[str, Any]:
        usage = {k: 0.0 for k in USAGE_KEYS}
        cost = {k: 0.0 for k in COST_KEYS}
        cost_seen = False
        estimated = False
        assistants = 0
        usage_entries = 0
        compaction_usage = 0
        cache_warm = 0
        for entry in entries:
            if entry.type == "message" and entry.role == "assistant":
                assistants += 1
            if entry.type == "usage":
                usage_entries += 1
                if (entry.usage_kind or "").startswith("cache_warm"):
                    cache_warm += 1
            if entry.type == "compaction" and entry.usage:
                compaction_usage += 1
            if entry.usage:
                for key, value in entry.usage.items():
                    usage[key] = usage.get(key, 0.0) + value
                assistants += 0 if entry.type == "message" else 0
            if entry.cost:
                cost_seen = True
                if entry.cost_total_from_provider is False:
                    estimated = True
                for key, value in entry.cost.items():
                    cost[key] = cost.get(key, 0.0) + value
        total_tokens = usage.get("totalTokens") or (
            usage.get("input", 0) + usage.get("output", 0) + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0)
        )
        kinds: dict[str, int] = {}
        for entry in entries:
            if entry.type == "usage":
                kind = entry.usage_kind or "unknown"
                kinds[kind] = kinds.get(kind, 0) + 1
        return {
            "usage_kinds": dict(sorted(kinds.items())),
            "input": usage.get("input", 0.0),
            "output": usage.get("output", 0.0),
            "cacheRead": usage.get("cacheRead", 0.0),
            "cacheWrite": usage.get("cacheWrite", 0.0),
            "reasoning": usage.get("reasoning", 0.0),
            "totalTokens": total_tokens,
            "cost": {k: cost.get(k, 0.0) for k in COST_KEYS} if cost_seen else None,
            "cost_estimated": estimated,
            "usage_entries": usage_entries,
            "cache_warm_entries": cache_warm,
            "compaction_usage_entries": compaction_usage,
        }

    def totals(self) -> dict[str, Any]:
        return self._totals([e for e in self.chain if e.type != "session"])

    def linear_totals(self) -> dict[str, Any]:
        """Every line, branch-blind. Emitted only as a diagnostic cross-check."""
        return self._totals(self.entries)

    def context_tokens(self) -> tuple[float | None, str | None, float | None]:
        last = None
        for entry in self.chain:
            if entry.type == "message" and entry.role == "assistant" and entry.usage:
                last = entry
        if last is None or not last.usage:
            return None, None, None
        u = last.usage
        value = u.get("totalTokens")
        if value is None:
            value = (
                u.get("input", 0) + u.get("output", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0)
            )
        return value, last.ts_raw, last.ts

    def cache_stats(self) -> dict[str, Any] | None:
        totals = self.totals()
        read = totals["cacheRead"]
        written = totals["cacheWrite"]
        input_tokens = totals["input"]
        denom = read + input_tokens
        return {
            "cacheRead": read,
            "cacheWrite": written,
            "input": input_tokens,
            "hit_rate": (read / denom) if denom > 0 else None,
        }

    def tps(self, last_n: int = 20) -> dict[str, Any]:
        points: list[tuple[float, float]] = []
        for entry in self.chain:
            if entry.type == "message" and entry.role == "assistant":
                if entry.duration_ms and entry.usage and entry.usage.get("output") is not None:
                    points.append((entry.usage.get("output", 0.0), entry.duration_ms))
        window = points[-last_n:]
        tokens = sum(p[0] for p in window)
        ms = sum(p[1] for p in window)
        return {
            "samples": len(window),
            "total_samples": len(points),
            "output_tokens": tokens,
            "duration_ms": ms,
            "tps": (tokens / (ms / 1000.0)) if ms > 0 else None,
            "window": last_n,
        }

    # -- turn / timing ----------------------------------------------------------
    def turn_span(self) -> dict[str, Any] | None:
        last_user = None
        last_assistant = None
        for entry in self.chain:
            if entry.type == "message" and entry.role == "user":
                last_user = entry
            if entry.type == "message" and entry.role == "assistant":
                last_assistant = entry
        if last_user is None:
            return None
        end = None
        end_source = None
        if last_assistant is not None and (last_user.ts or 0) <= (last_assistant.ts or 0):
            end, end_source = last_assistant.ts, "last assistant message"
        else:
            end, end_source = last_user.ts, "last user message (no later assistant message)"
        if last_user.ts is None or end is None:
            return None
        return {
            "start": last_user.ts_raw,
            "end": util.iso(end),
            "end_source": end_source,
            "seconds": max(0.0, end - last_user.ts),
        }

    def counts(self) -> dict[str, Any]:
        def count(pred) -> int:
            return sum(1 for e in self.chain if pred(e))

        usage_kinds: dict[str, int] = {}
        for e in self.chain:
            if e.type == "usage":
                kind = e.usage_kind or "unknown"
                usage_kinds[kind] = usage_kinds.get(kind, 0) + 1
        return {
            "entries": len(self.chain),
            "entries_in_file": len(self.entries),
            "assistant": count(lambda e: e.type == "message" and e.role == "assistant"),
            "user": count(lambda e: e.type == "message" and e.role == "user"),
            "tool_results": count(lambda e: e.type == "message" and e.role == "toolResult"),
            "system_messages": count(
                lambda e: e.type == "message" and e.role == "system" and bool(e.sections)
            ),
            "compactions": count(lambda e: e.type == "compaction"),
            "branch_summaries": count(lambda e: e.type == "branch_summary"),
            "context_edits": count(lambda e: e.type == "context_edit"),
            "custom_entries": count(lambda e: e.type == "custom"),
            "usage_entries": count(lambda e: e.type == "usage"),
            "usage_kinds": dict(sorted(usage_kinds.items())),
            "failed_responses": count(
                lambda e: e.type == "message"
                and e.role == "assistant"
                and (e.stop_reason in ("error", "aborted") or e.has_error_message)
            ),
            "aborted_responses": count(
                lambda e: e.type == "message" and e.role == "assistant" and e.stop_reason == "aborted"
            ),
        }

    def last_entry_ts(self) -> float | None:
        for entry in reversed(self.chain):
            if entry.ts is not None:
                return entry.ts
        return None

    # -- replay: tools, skills ----------------------------------------------------
    def replay(self) -> dict[str, Any]:
        tools: set[str] = set()
        skills: dict[str, str] = {}
        sections: dict[str, bool] = {}
        for entry in self.chain:
            if entry.type != "message":
                continue
            for name in entry.tools_added:
                tools.add(name)
            for name in entry.tools_removed:
                tools.discard(name)
            for section in entry.sections:
                sections[section] = True
            if entry.skills:
                # a later skills section replaces the listing
                for name, location in entry.skills:
                    skills[name] = location
        return {
            "tools": sorted(tools),
            "skills": dict(sorted(skills.items())),
            "sections": sorted(sections),
        }

    # -- last custom states on the chain -----------------------------------------
    def last_custom(self, predicate) -> Entry | None:
        found = None
        for entry in self.chain:
            if entry.type == "custom" and predicate(entry):
                found = entry
        return found

    def mode_state(self) -> dict[str, Any] | None:
        entry = self.last_custom(lambda e: (e.custom_type or "").startswith("pi-mode-state"))
        return {"state": entry.mode_state, "timestamp": entry.ts_raw, "customType": entry.custom_type} if entry else None

    def todo_state(self) -> dict[str, Any] | None:
        entry = self.last_custom(lambda e: "todo" in (e.custom_type or ""))
        return {"state": entry.todo_state, "timestamp": entry.ts_raw, "customType": entry.custom_type} if entry else None

    def goal_state(self) -> dict[str, Any] | None:
        entry = self.last_custom(lambda e: "goal" in (e.custom_type or ""))
        return {"state": entry.goal_state, "timestamp": entry.ts_raw, "customType": entry.custom_type} if entry else None

    def session_name(self) -> tuple[str | None, float | None]:
        name = None
        ts = None
        for entry in self.chain:
            if entry.type == "session_info" and entry.session_name:
                name, ts = entry.session_name, entry.ts
        return name, ts

    def last_tool_calls(self, names: set[str]) -> list[dict[str, Any]]:
        hits: list[dict[str, Any]] = []
        for entry in self.chain:
            for name in entry.tool_calls:
                if name in names:
                    hits.append({"tool": name, "timestamp": entry.ts_raw})
        return hits

    def labels(self) -> int:
        return sum(1 for e in self.chain if e.type == "label" and e.label_present)


def load(
    path: str,
    policy: Any,
    *,
    leaf_hint: str | None = None,
) -> SessionView:
    result = util.read_jsonl(path, policy, "session")
    header = None
    entries_raw: list[dict[str, Any]] = []
    for raw in result.entries:
        if raw.get("type") == "session" and header is None:
            header = raw
            continue
        entries_raw.append(raw)
    entries = [_compact(raw) for raw in entries_raw]
    diagnostics: list[str] = []
    # Version 1 sessions are a linear sequence with no id/parentId (pi auto-migrates them on
    # load). Reading one means synthesizing the same linear chain, not reporting "no leaf".
    version = header.get("version") if isinstance(header, dict) and isinstance(header.get("version"), int) else None
    if version == 1 or any(e.id is None for e in entries):
        previous: str | None = None
        for index, entry in enumerate(entries):
            if entry.id is None:
                entry.id = f"v1-{index:05d}"
                entry.parent = previous
            previous = entry.id
        diagnostics.append("synthetic_ids_for_linear_session")
    by_id = {e.id: e for e in entries if e.id}
    if header is None:
        diagnostics.append("missing_session_header")
    if result.partial_tail:
        diagnostics.append("partial_final_line_ignored")
    if result.malformed:
        diagnostics.append(f"malformed_lines:{result.malformed}")
    if result.duplicate_ids:
        diagnostics.append(f"duplicate_entry_ids:{result.duplicate_ids}")

    leaf_id: str | None = None
    leaf_source = "last_file_entry"
    if leaf_hint:
        if leaf_hint in by_id:
            leaf_id, leaf_source = leaf_hint, "leaf_hint"
        else:
            diagnostics.append(LEAF_HINT_INVALID)
    if leaf_id is None:
        leaf_id = entries[-1].id if entries and entries[-1].id else None

    chain: list[Entry] = []
    chain_state = CHAIN_OK
    if not entries:
        chain_state = CHAIN_EMPTY
    else:
        seen: set[str] = set()
        current = by_id.get(leaf_id) if leaf_id else None
        if current is None and leaf_id is not None:
            chain_state = CHAIN_BROKEN
        while current is not None:
            if current.id in seen:
                chain_state = CHAIN_CYCLE
                diagnostics.append(f"cycle_at:{current.id}")
                break
            seen.add(current.id or "")
            chain.append(current)
            if current.parent is None:
                break
            nxt = by_id.get(current.parent)
            if nxt is None:
                chain_state = CHAIN_BROKEN
                diagnostics.append(f"missing_parent:{current.parent}")
                break
            current = nxt
        chain.reverse()

    return SessionView(
        path=path,
        realpath=util.realpath(path),
        version=header.get("version") if isinstance(header, dict) and isinstance(header.get("version"), int) else None,
        header_id=header.get("id") if isinstance(header, dict) and isinstance(header.get("id"), str) else None,
        header_cwd=header.get("cwd") if isinstance(header, dict) and isinstance(header.get("cwd"), str) else None,
        header_ts=util.parse_iso(header.get("timestamp")) if isinstance(header, dict) else None,
        parent_session=header.get("parentSession")
        if isinstance(header, dict) and isinstance(header.get("parentSession"), str)
        else None,
        entries=entries,
        by_id=by_id,
        leaf_id=leaf_id,
        leaf_source=leaf_source,
        chain=chain,
        chain_state=chain_state,
        diagnostics=diagnostics,
        partial_tail=result.partial_tail,
        malformed=result.malformed,
        duplicate_ids=result.duplicate_ids,
        bytes_read=result.bytes_read,
        lines=result.lines,
    )


def probe_rotation(path: str, previous: dict[str, Any] | None) -> tuple[bool, dict[str, Any]]:
    """Detect file replacement (rotation), not just growth.

    A rotated session keeps the same *logical* path but is a different inode; a truncated
    or renamed-and-recreated file can also be shorter than the last read. Both are
    reported so a watcher re-parses instead of polling a stale inode.
    """
    try:
        st = os.stat(path)
    except OSError:
        return (previous is not None), {"exists": False}
    current = {"exists": True, "inode": st.st_ino, "size": st.st_size, "mtime_ns": st.st_mtime_ns}
    if previous is None:
        return False, current
    rotated = previous.get("inode") != current["inode"] or current["size"] < previous.get("size", 0)
    return rotated, current
