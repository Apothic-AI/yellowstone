"""Lane assembly: one lane record, every operator field, provenance attached.

The field ids are the plan's (§4): ``H-*`` herdr, ``P-*`` pi session, ``T-*`` tokens and
timings, ``R-*`` repo, ``M-*`` mode/profile/rooms, ``G-*`` goals and dagr, ``D-*`` TODOs,
``C-*`` crons, ``E-*``/``S-*`` extensions, skills and prompts, ``J-*`` jobs and monitors,
``B-*`` beads. ``FIELD-LEDGER.md`` in this tree maps each id to its exact output key, its
state in this tranche and its remaining gate.

Held lanes (denied workspace ``w2``, reserved pane ``wE:t19``) are short-circuited *before*
any process, session or state path is opened: their path-derived fields are ``held`` and
only the snapshot handles (H-1..H-6) exist, because those come from the one snapshot read
the whole roster is built on and are not session content.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field as dc_field
from typing import Any, Callable

from . import field as F
from . import cache as cache_mod
from . import guard, identity, procfs, session, util
from .sources import Paths, fleet_state, herdr, pi_state, repo

HELD_REASON_PREFIX = "deny_pre_read_policy"


@dataclass
class Context:
    paths: Paths
    policy: guard.Policy
    snapshot: herdr.Snapshot
    as_of: float
    as_of_iso: str
    pil: "identity.PilAccess"
    leaf_hint: str | None = None
    models: dict[tuple[str, str | None], dict[str, Any]] = dc_field(default_factory=dict)
    dagr: list[dict[str, Any]] = dc_field(default_factory=list)
    beads: list[dict[str, Any]] = dc_field(default_factory=list)
    timings: dict[str, list[float]] = dc_field(default_factory=dict)
    diagnostics: list[dict[str, Any]] = dc_field(default_factory=list)
    #: The reporter cache, when it is enabled for this run. ``None`` means there is no
    #: cache to join against — the P-11 field then says so instead of guessing.
    runtime_cache: Any = None
    #: The freshness window for a cached observation, in seconds.
    cache_freshness_s: float = 120.0
    _settings: dict[str, dict[str, Any]] = dc_field(default_factory=dict)
    _crons: dict[str, dict[str, Any]] = dc_field(default_factory=dict)

    def time(self, name: str, started: float) -> None:
        self.timings.setdefault(name, []).append((time.perf_counter() - started) * 1000.0)

    def settings_for(self, instance_dir: str | None) -> dict[str, Any]:
        key = instance_dir or "<none>"
        if key not in self._settings:
            self._settings[key] = pi_state.settings_summary(
                self.paths.agent_dir, instance_dir, self.policy
            )
        return self._settings[key]

    def crons_for(self, cwd: str | None) -> dict[str, Any]:
        key = cwd or "<none>"
        if key not in self._crons:
            tasks_path = (
                str(self.paths.state_dir) + "/cron/tasks.json" if self.paths.state_dir else None
            )
            self._crons[key] = fleet_state.crons_for(cwd, tasks_path, self.policy)
        return self._crons[key]

def _add(fields: dict[str, F.Field], f: F.Field) -> None:
    fields[f.key] = f


def _value(fields: dict[str, F.Field], key: str, default: Any = None) -> Any:
    return F.value_of(fields, key, default)


@dataclass
class BuiltLane:
    pane_id: str | None
    workspace_id: str | None
    tab_id: str | None
    admitted: bool
    admission_reason: str | None
    identity: identity.Identity | None
    fields: dict[str, F.Field]
    handles: dict[str, Any]
    source_timings: dict[str, float] = dc_field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.pane_id,
            "handles": self.handles,
            "admission": {"admitted": self.admitted, "reason": self.admission_reason},
            "identity": self.identity.to_dict() if self.identity else None,
            "fields": {k: v.to_dict() for k, v in self.fields.items()},
        }


def build_lane(agent: dict[str, Any], ctx: Context) -> BuiltLane:
    pane_id = agent.get("pane_id") if isinstance(agent.get("pane_id"), str) else None
    workspace_id = agent.get("workspace_id") if isinstance(agent.get("workspace_id"), str) else None
    tab_id = agent.get("tab_id") if isinstance(agent.get("tab_id"), str) else None
    pane = ctx.snapshot.pane(pane_id)
    ws = ctx.snapshot.workspace(workspace_id)
    tab = ctx.snapshot.tab(tab_id)

    fields: dict[str, F.Field] = {}
    name, name_layer = herdr.pane_name(agent, pane, tab)
    status, status_source = herdr.status_value(agent, pane)
    handles = {
        "pane_id": pane_id,
        "workspace_id": workspace_id,
        "tab_id": tab_id,
        "workspace_label": ws.get("label") if isinstance(ws.get("label"), str) else None,
        "name": name,
        "name_layer": name_layer,
        "agent_status": status,
    }

    # -- admission first: a held/reserved lane's values are never emitted --------------
    admitted, reason = ctx.policy.admit_lane(workspace_id, pane_id, tab_id)

    if not admitted:
        # Deny BEFORE emitting anything: no label, no status, no cwd, no env, no path.
        # The handles below are the deny key itself (`workspace=w2` / `pane=wE:t19`), which
        # is what identifies the refusal; everything the snapshot said about the lane is
        # dropped rather than rendered.
        for key in _ALL_FIELD_KEYS:
            _add(fields, F.held(key, f"{HELD_REASON_PREFIX}:{reason}",
                                source="withheld before any value or path read"))
        held_handles = {"pane_id": pane_id, "workspace_id": workspace_id, "tab_id": None,
                        "workspace_label": None, "name": None, "name_layer": None,
                        "agent_status": None}
        return BuiltLane(pane_id, workspace_id, tab_id, False, reason, None, fields, held_handles)

    # -- H-1..H-6: snapshot metadata (admitted lanes only) ---------------------------
    _add(fields, F.present("H-1", ws.get("label"), source="snapshot workspaces[].label",
                           observed_at=ctx.as_of_iso, privacy=0)
         if isinstance(ws.get("label"), str)
         else F.absent("H-1", "workspace has no label", source="snapshot workspaces[].label",
                       observed_at=ctx.as_of_iso))
    _add(fields, F.present("H-2", workspace_id, source="snapshot workspaces[].workspace_id",
                           observed_at=ctx.as_of_iso) if workspace_id
         else F.absent("H-2", "agent has no workspace_id", source="snapshot agents[]"))
    _add(fields, F.present("H-3", pane_id, source="snapshot agents[].pane_id",
                           observed_at=ctx.as_of_iso) if pane_id
         else F.absent("H-3", "agent has no pane_id", source="snapshot agents[]"))
    if name:
        _add(fields, F.present("H-4", name, source=name_layer, observed_at=ctx.as_of_iso,
                               note=f"winning layer: {name_layer}"))
    else:
        _add(fields, F.absent("H-4", "no name layer produced a value",
                              source="tabs[].label > agents[].name > display_agent > panes[].label > terminal_title_stripped"))
    if status:
        value = {
            "status": status,
            "state_change_seq": agent.get("state_change_seq"),
            "completion_seq": agent.get("completion_seq"),
            "interactive_ready": agent.get("interactive_ready"),
            "restore_error": pane.get("restore_error"),
        }
        missing = [k for k, v in value.items() if v is None]
        _add(fields, F.present("H-5", value, source=status_source, observed_at=ctx.as_of_iso,
                               note=("herdr-observed status value, not a conclusion about progress"
                                     + (f"; not reported by herdr for this lane: {', '.join(missing)}"
                                        if missing else ""))))
    else:
        _add(fields, F.unknown("H-5", "no agent_status on agent or pane",
                               source="snapshot agents[]/panes[]"))
    cwd = agent.get("cwd") if isinstance(agent.get("cwd"), str) else None
    fg_cwd = agent.get("foreground_cwd") if isinstance(agent.get("foreground_cwd"), str) else None
    if cwd and fg_cwd and util.realpath(cwd) != util.realpath(fg_cwd):
        _add(fields, F.divergent("H-6", {"cwd": cwd, "foreground_cwd": fg_cwd},
                                 "cwd and foreground_cwd differ",
                                 source="snapshot agents[].cwd / foreground_cwd",
                                 observed_at=ctx.as_of_iso))
    elif cwd or fg_cwd:
        _add(fields, F.present("H-6", {"cwd": cwd or fg_cwd, "foreground_cwd": fg_cwd},
                               source="snapshot agents[].cwd", observed_at=ctx.as_of_iso))
    else:
        _add(fields, F.absent("H-6", "agent has no cwd", source="snapshot agents[].cwd"))

    # -- identity: which session is this lane's, validated --------------------------
    started = time.perf_counter()
    # The lane *name* is a handle used only to locate a candidate pil record; ownership is
    # still proven by paneId + pid + session validation below.
    pin_for_name = fleet_state.room_pin(ctx.paths.agent_dir, pane_id, ctx.policy)
    ident = identity.resolve(
        agent,
        policy=ctx.policy,
        pil=ctx.pil,
        proc_root=ctx.paths.proc_root,
        loader=lambda p, pol: session.load(p, pol, leaf_hint=ctx.leaf_hint),
        leaf_hint=ctx.leaf_hint,
        name_hint=pin_for_name.get("name"),
    )
    ctx.time("identity+session", started)
    view = ident.session
    if view is not None:
        for code in view.diagnostics:
            ctx.diagnostics.append({"lane": pane_id, "code": "session", "detail": code,
                                    "session": view.realpath})
    # The instance is taken only from the verified lane process's own `PI_CODING_AGENT_DIR`.
    # Deriving it from the session path would be a guess: a session can be opened with any
    # --session-dir, so path containment is not ownership.
    # Instance and profile are only resolved for a *trusted* admitted identity. On any
    # disagreement the preload is skipped entirely, so no profile file is opened.
    instance = (
        pi_state.instance_from_agent_dir(ident.env.get("PI_CODING_AGENT_DIR"),
                                        ctx.paths.instances_dir)
        if ident.trusted else None
    )
    if ident.session is not None and ident.state not in identity.TRUSTED_STATES:
        ctx.diagnostics.append(
            {"lane": pane_id, "code": "identity_untrusted", "state": ident.state,
             "disagreements": ident.disagreements}
        )

    lane = BuiltLane(pane_id, workspace_id, tab_id, True, None, ident, fields, handles)
    lane.source_timings = {k: round(v[-1], 3) for k, v in ctx.timings.items() if v}

    if view is None:
        for key in _PATH_DERIVED_KEYS:
            if key not in fields:
                _add(fields, F.unknown(key, f"no validated session: {ident.state}",
                                       source="identity resolution"))
        _fill_reporter_observation(fields, ctx, ident, pane_id)
        _fill_state_only(fields, ctx, ident, instance, cwd, pane_id, workspace_id)
        return lane

    now = ctx.as_of
    entry_ts = view.last_entry_ts()
    # pi keeps the selected leaf in memory only; a file alone cannot prove which branch is
    # *current*. So the branch below is explicitly DISK_RECONSTRUCTED, and the exact runtime
    # selection is a typed unknown rather than a claim.
    _add(fields, F.present("P-4", {"session_id": view.header_id,
                                   "validated_against_filename": view.identity_checks()["header_matches_filename"],
                                   "leaf_id": view.leaf_id, "leaf_source": view.leaf_source,
                                   "leaf_authority": "DISK_RECONSTRUCTED",
                                   "runtime_leaf": None,
                                   "chain_state": view.chain_state,
                                   "entries_on_chain": len(view.chain),
                                   "entries_in_file": len(view.entries)},
                           source="session header + id/parentId tree (disk)",
                           observed_at=util.iso(entry_ts), age_s=util.age_s(entry_ts, now),
                           note=("DISK_RECONSTRUCTED: the leaf is the last file entry because pi "
                                 "does not persist it; this is not proof of the runtime-selected "
                                 "branch (a native branch() can move the leaf with no file append). "
                                 "Exact runtime leaf: unknown (no live integration).")
                                if view.leaf_source == "last_file_entry" else
                                "explicit leaf hint supplied; still not runtime-attested"))
    spellings = [view.path]
    if util.realpath(view.path) != view.path:
        spellings.append(view.realpath)
    _add(fields, F.present("P-5", {"path": view.realpath, "reported_path": view.path,
                                   "spellings": len(set(spellings))},
                           source=ident.session_source, observed_at=ctx.as_of_iso))
    _add(fields, F.present("P-6", util.iso(view.header_ts), source="session header timestamp",
                           observed_at=ctx.as_of_iso) if view.header_ts
         else F.absent("P-6", "session header has no timestamp", source="session header"))

    # P-7 session duration: live vs historical is stated, never conflated
    if view.header_ts:
        if ident.proc is not None and ident.proc.available:
            value = max(0.0, now - view.header_ts)
            method = "observed_now - header.timestamp (lane process present)"
        else:
            end = entry_ts or view.header_ts
            value = max(0.0, end - view.header_ts)
            method = "last_entry_timestamp - header.timestamp (no live process; frozen at last write)"
        _add(fields, F.derived("P-7", round(value, 3), method, unit="s",
                               source="session header + last entry", observed_at=util.iso(entry_ts),
                               age_s=util.age_s(entry_ts, now)))
    else:
        _add(fields, F.unknown("P-7", "no header timestamp", source="session header"))

    span = view.turn_span()
    if span:
        _add(fields, F.derived("P-8", span, "last_assistant_or_user_ts - last_user_ts",
                               unit="s", source="session messages on the active branch",
                               observed_at=span["end"],
                               note="last observed turn span, not a live 'still running' duration"))
    else:
        _add(fields, F.absent("P-8", "no user message on the active branch", source="session messages"))

    session_name, name_ts = view.session_name()
    _add(fields, F.present("P-9", session_name, source="session_info entry", privacy=1,
                           observed_at=util.iso(name_ts)) if session_name
         else F.absent("P-9", "no session_info name", source="session_info entry", privacy=1))
    if view.parent_session:
        _add(fields, F.present("P-10", view.parent_session, source="session header parentSession",
                               privacy=1, observed_at=ctx.as_of_iso))
    else:
        _add(fields, F.absent("P-10", "session is not a fork", source="session header parentSession",
                              privacy=1))

    # -- model ------------------------------------------------------------------
    sel_provider, sel_model, sel_ts = view.selected_model()
    phys_provider, phys_model, phys_ts = view.physical_model()
    model_value = {"selected": {"provider": sel_provider, "model": sel_model},
                   "physical": {"provider": phys_provider, "model": phys_model},
                   "differ": bool(sel_model and phys_model and (sel_model != phys_model or sel_provider != phys_provider))}
    provider_value = {"selected": sel_provider, "physical": phys_provider,
                      "differ": bool(sel_provider and phys_provider and sel_provider != phys_provider)}
    model_value = {"selected": sel_model, "physical": phys_model,
                   "differ": bool(sel_model and phys_model and sel_model != phys_model)}
    for key, value in (("P-1", provider_value), ("P-2", model_value)):
        if value["selected"] or value["physical"]:
            _add(fields, F.divergent(key, value, "selected != physical (virtual-model indirection)",
                                     source="model_change entry + last assistant message",
                                     observed_at=util.iso(phys_ts or sel_ts))
                 if value["differ"]
                 else F.present(key, value, source="model_change entry + last assistant message",
                                observed_at=util.iso(phys_ts or sel_ts)))
        else:
            _add(fields, F.absent(key, "no model_change and no assistant message on the active branch",
                                  source="session entries"))
    thinking, thinking_source = view.thinking_level()
    _add(fields, F.present("P-3", thinking, source=thinking_source,
                           observed_at=util.iso(entry_ts)) if thinking
         else F.absent("P-3", "no thinking level recorded", source="thinking_level_change / assistant"))

    # -- tokens / context / timings ---------------------------------------------
    totals = view.totals()
    context_used, context_ts_raw, context_ts = view.context_tokens()
    if context_used is not None:
        _add(fields, F.derived("T-1", context_used,
                               "last assistant usage.input+output+cacheRead+cacheWrite (pi's own accounting)",
                               unit="tokens", source="last assistant message usage",
                               observed_at=util.iso(context_ts), age_s=util.age_s(context_ts, now)))
    else:
        _add(fields, F.absent("T-1", "no assistant usage on the active branch",
                              source="session messages"))
    ctx_window, window_source = pi_state.context_max(ctx.models, phys_provider, phys_model)
    if ctx_window:
        _add(fields, F.present("T-2", ctx_window, source=f"models-store contextWindow ({window_source})",
                               observed_at=ctx.as_of_iso, method=None))
    else:
        _add(fields, F.unknown("T-2", f"no contextWindow: {window_source}", source="models-store.json"))
    if context_used is not None and ctx_window:
        _add(fields, F.derived("T-3", round(100.0 * context_used / ctx_window, 2),
                               "T-1 / T-2 * 100", unit="%", source="T-1 + T-2",
                               observed_at=util.iso(context_ts), age_s=util.age_s(context_ts, now)))
    else:
        _add(fields, F.unknown("T-3", "T-1 or T-2 unknown; refusing to assume a context size",
                               source="T-1, T-2"))

    _add(fields, F.derived("T-4", totals,
                           "sum over assistant usage + usage entries + compaction/branch_summary "
                           "usage on the DISK_RECONSTRUCTED active branch (unknown usage.kind "
                           "counted as usage)",
                           unit="tokens", source="session usage entries",
                           observed_at=util.iso(entry_ts), age_s=util.age_s(entry_ts, now)))
    linear = view.linear_totals()
    if linear["totalTokens"] != totals["totalTokens"]:
        previous = fields["T-4"]
        _add(fields, F.derived(
            "T-4", previous.value, previous.method or "",
            unit=previous.unit, source=previous.source, observed_at=previous.observed_at,
            age_s=previous.age_s,
            note=(f"active-branch sum differs from a branch-blind file sum "
                  f"({totals['totalTokens']:.0f} vs {linear['totalTokens']:.0f}): "
                  f"abandoned branches are excluded by design")))
    cache = view.cache_stats()
    if cache:
        _add(fields, F.derived("T-5", {"cacheRead": cache["cacheRead"],
                                       "cacheWrite": cache["cacheWrite"],
                                       "input": cache["input"],
                                       "hit_rate_pct": None if cache["hit_rate"] is None else round(100.0 * cache["hit_rate"], 2),
                                       "hit_rate_ratio": None if cache["hit_rate"] is None else round(cache["hit_rate"], 6)},
                               "ΣcacheRead / (ΣcacheRead + Σinput) on the active branch; raw counts and both ratio forms",
                               source="session usage entries", observed_at=util.iso(entry_ts),
                               age_s=util.age_s(entry_ts, now)))
    else:
        _add(fields, F.absent("T-5", "no usage entries", source="session usage entries"))
    if totals.get("cost"):
        _add(fields, F.derived("T-6", {"cost": totals["cost"], "estimated": totals["cost_estimated"]},
                               "Σ usage.cost{input,output,cacheRead,cacheWrite,total}; estimated when any totalFromProvider is false",
                               privacy=1, source="session usage cost", observed_at=util.iso(entry_ts),
                               age_s=util.age_s(entry_ts, now)))
    else:
        _add(fields, F.absent("T-6", "no cost recorded on usage entries", source="session usage cost",
                              privacy=1))
    tps = view.tps()
    if tps["tps"] is not None:
        _add(fields, F.derived("T-7", {"tps": round(tps["tps"], 2), "samples": tps["samples"],
                                       "window": tps["window"],
                                       "output_tokens": tps["output_tokens"],
                                       "duration_ms": tps["duration_ms"]},
                               "Σ output tokens / Σ durationMs over the last N assistant messages with durationMs",
                               source="assistant durationMs (persisted timings)",
                               observed_at=util.iso(entry_ts),
                               note="derived from persisted message durations; not a live stream rate"))
    else:
        _add(fields, F.unknown("T-7", "no assistant message carries durationMs (legacy session)",
                               source="assistant durationMs"))
    _add(fields, F.unknown("T-8", "pi persists total durationMs, not time-to-first-token; TTFT is runtime-only",
                           source="session format (no ttft field)",
                           note="requires the separately reviewed P3 live extension"))

    # -- repo -------------------------------------------------------------------
    _fill_repo(fields, ctx, view, agent, ws)

    # -- mode / profile / rooms -------------------------------------------------
    _fill_mode_profile_rooms(fields, ctx, view, ident, instance, pane_id)

    # -- goals / todos / crons --------------------------------------------------
    _fill_goals_todos_crons(fields, ctx, view, ident, instance, cwd)

    # -- extensions / skills / prompts -----------------------------------------
    _fill_extensions_skills_prompts(fields, ctx, view, instance, ident)

    # -- jobs / monitors --------------------------------------------------------
    _fill_jobs(fields, ctx, view)

    # -- dagr / beads -----------------------------------------------------------
    _fill_dagr_beads(fields, ctx, ident, workspace_id, pane_id)

    # -- the reporter's runtime observation --------------------------------------
    _fill_reporter_observation(fields, ctx, ident, pane_id)

    lane.source_timings = {k: round(v[-1], 3) for k, v in ctx.timings.items() if v}
    return lane


# --- helpers -----------------------------------------------------------------------

_ALL_FIELD_KEYS = (
    "H-1", "H-2", "H-3", "H-4", "H-5", "H-6",
    "P-1", "P-2", "P-3", "P-4", "P-5", "P-6", "P-7", "P-8", "P-9", "P-10", "P-11",
    "T-1", "T-2", "T-3", "T-4", "T-5", "T-6", "T-7", "T-8",
    "R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7",
    "M-1", "M-2", "M-3", "M-5", "M-6", "M-7",
    "G-1", "G-2", "G-3", "G-4", "D-1", "D-2", "C-1", "C-2",
    "E-1", "E-2", "S-1", "S-2", "S-3", "S-4",
    "J-1", "J-2", "J-3", "B-1", "B-2",
)

_PATH_DERIVED_KEYS = (
    "P-1", "P-2", "P-3", "P-4", "P-5", "P-6", "P-7", "P-8", "P-9", "P-10", "P-11",
    "T-1", "T-2", "T-3", "T-4", "T-5", "T-6", "T-7", "T-8",
    "R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7",
    "M-1", "M-2", "M-3", "M-5", "M-6", "M-7",
    "G-1", "G-2", "G-3", "G-4", "D-1", "D-2", "C-1", "C-2",
    "E-1", "E-2", "S-1", "S-2", "S-3", "S-4",
    "J-1", "J-2", "J-3", "B-1", "B-2",
)


def _fill_reporter_observation(fields: dict[str, F.Field], ctx: Context,
                               ident: identity.Identity, pane_id: str | None) -> None:
    """P-11: the reporter's runtime observation for **this** lane's session.

    The join is on ``(pane id, session id)``:

    * the pane id is the lane's own pane, and the lane is admitted before this runs — a
      held or reserved lane never reaches here, so no cache read happens for it;
    * the session id is the lane's **validated** session id. A cached observation that
      belongs to another session is an ``identity_mismatch`` and its value is **not**
      returned;
    * a cached observation older than the freshness window is reported as ``stale``. It is
      never presented as current, and the age travels with it.

    The observation is a **last observation**, not a disk truth and not a liveness
    proof: the disk-derived fields (``P-1``..``P-10``) stay exactly as they were, and
    this field never replaces them. The cached row names the *incarnation* that wrote
    it (the reporting process's boot id, pid and start time), which says **who** wrote
    it -- never that the process is still running.
    """
    cache = ctx.runtime_cache
    if cache is None:
        _add(fields, F.absent("P-11", "the cache is not enabled for this run",
                              source="behold cache (not enabled)"))
        return
    if not pane_id:
        _add(fields, F.unknown("P-11", "the lane has no pane id to join on",
                               source="identity resolution"))
        return
    session_id = ident.session_id
    if not session_id:
        _add(fields, F.unknown("P-11", f"no validated session: {ident.state}",
                               source="identity resolution"))
        return
    read = cache.read_pi_state(pane_id, session_id=session_id,
                               freshness_s=ctx.cache_freshness_s)
    source = "behold cache pi_state_current (reporter observation)"
    if read.state == cache_mod.ABSENT:
        _add(fields, F.absent("P-11", "no reporter observation for this lane and session",
                              source=source))
        return
    if read.state == cache_mod.IDENTITY_MISMATCH:
        _add(fields, F.unknown(
            "P-11",
            f"identity_mismatch: the cached observation belongs to session "
            f"{read.session_id}, not {session_id}",
            source=source))
        return
    if read.state == cache_mod.UNREADABLE:
        _add(fields, F.error("P-11", read.reason or "the cached observation is unreadable",
                              source=source))
        return
    if read.state == cache_mod.CLOCK_DISPUTED:
        _add(fields, F.unknown(
            "P-11",
            f"clock_disputed: {read.reason or 'the observation timestamp is not trustworthy'}",
            source=source))
        return
    observed = read.value or {}
    value = {
        "freshness": "fresh" if read.state == cache_mod.FRESH else "stale",
        "observed_at": read.observed_at,
        "age_s": None if read.age_s is None else round(read.age_s, 3),
        "seq": read.seq,
        "incarnation": read.incarnation,
        "clock_skew_s": None if read.clock_skew_s is None else round(read.clock_skew_s, 3),
        "session_match": "matched",
        "observed": observed,
        "unavailable": cache_mod.observation_gaps(observed),
    }
    note = ("a last observation reported by the lane's reporter, and not proof that the "
            "lane is alive now: the record carries the reporting process's incarnation, "
            "not a liveness proof. The disk-derived fields (P-1..P-10) remain the "
            "authority for this lane")
    if read.state == cache_mod.STALE:
        _add(fields, F.last_observed(
            "P-11", value,
            read.reason or "the observation is older than the freshness window",
            source=source, observed_at=read.observed_at, age_s=read.age_s, note=note))
        return
    _add(fields, F.observed("P-11", value, source=source, observed_at=read.observed_at,
                            age_s=read.age_s, note=note))


def _fill_repo(fields: dict[str, F.Field], ctx: Context, view: session.SessionView,
               agent: dict[str, Any], ws: dict[str, Any]) -> None:
    """R-1..R-7 with the git/jj adapters **absent** (V3).

    Detection (`.git`/`.jj` presence) is a pure stat and stays. Everything that needed a
    child process is a typed unknown carrying `repo-adapter-not-isolated`: an exact argv is
    not containment, and repository config can make even a read-only git argv run a helper
    writer, so the capability was removed rather than shipped behind an opt-in flag.
    """
    cwd = agent.get("cwd") if isinstance(agent.get("cwd"), str) else view.header_cwd
    detection = repo.detect(cwd)
    _add(fields, F.present("R-7", "NO_REPO" if detection.kind == "none" else detection.kind,
                           source=".git/.jj presence at lane cwd (stat only, no child)",
                           observed_at=ctx.as_of_iso,
                           note="absence of a repository is an expected state, not an error"))

    for key, label in (("R-1", "git branch + oid"),
                       ("R-3", "git dirty counts"),
                       ("R-4", "git ahead/behind/stash")):
        _add(fields, F.unknown(key, repo.NOT_ISOLATED,
                               source=f"{label}: adapter removed in V3",
                               note="requires a separately reviewed isolated execution boundary"))
    # R-2 keeps the herdr-side worktree identity, which needs no child, and says which half
    # is missing.
    worktree = ws.get("worktree") if isinstance(ws.get("worktree"), dict) else None
    if worktree:
        _add(fields, F.unknown(
            "R-2", repo.NOT_ISOLATED,
            source="snapshot workspaces[].worktree (herdr half only)",
            note=("herdr reports "
                  + (worktree.get("repo_name") or "a repository")
                  + "; the git rev-parse cross-check is disabled because it needs a child")))
    else:
        _add(fields, F.unknown("R-2", "no worktree record and no git adapter",
                               source="snapshot workspaces[].worktree"))

    # R-5: cheap detection + a TTL-aware token from the snapshot; no jj invocation.
    tokens = ws.get("tokens") if isinstance(ws.get("tokens"), dict) else {}
    bookmark_token = tokens.get("jj_bookmark")
    bookmark = bookmark_expired = None
    if isinstance(bookmark_token, str):
        bookmark = bookmark_token
    elif isinstance(bookmark_token, dict):
        bookmark = bookmark_token.get("value") if isinstance(bookmark_token.get("value"), str) else None
        expires = bookmark_token.get("expires_at") or bookmark_token.get("expiresAt")
        if isinstance(expires, str):
            ts = util.parse_iso(expires)
            bookmark_expired = ts is not None and ts < ctx.as_of
    if bookmark and bookmark_expired:
        _add(fields, F.expired("R-5", "jj_bookmark token TTL passed",
                               source="snapshot workspaces[].tokens.jj_bookmark"))
    elif bookmark or detection.has_jj:
        _add(fields, F.present("R-5", {"jj_workspace": detection.has_jj,
                                       "jj_bookmark": bookmark},
                               source=".jj presence (stat) + snapshot tokens.jj_bookmark",
                               observed_at=ctx.as_of_iso,
                               note="detection only: no jj process is run"))
    else:
        _add(fields, F.absent("R-5", "no .jj directory and no jj_bookmark token",
                              source=".jj presence + snapshot tokens"))
    _add(fields, F.unknown("R-6", repo.NOT_ISOLATED,
                           source="jj bookmark/change/status: adapter removed in V3",
                           note="a plain jj read can snapshot a working copy; removing the adapter avoids the question"))


def _fill_mode_profile_rooms(fields: dict[str, F.Field], ctx: Context, view: session.SessionView,
                             ident: identity.Identity, instance: str | None, pane_id: str | None) -> None:
    mode = view.mode_state()
    if mode and mode.get("state"):
        state = mode["state"]
        records = state.get("fingerprints") or {}
        definitions = []
        for key, fp in sorted(records.items()):
            path = fp.get("path")
            label = None
            if path and os.path.exists(path):
                try:
                    raw = guard.read_json(path, ctx.policy, "mode-definition-label")
                    if isinstance(raw, dict) and isinstance(raw.get("label"), str):
                        label = raw["label"]
                except (OSError, ValueError, guard.DeniedRead):
                    label = None
            definitions.append({"key": key, "path": path, "digest": fp.get("digest"),
                                "scope": fp.get("scope"), "label": label})
        # Only pi-mode-state.v3 records per-lane fingerprints with paths and digests. An
        # older version is reported as-is and its digest is not re-interpreted.
        version_note = None
        if mode.get("customType") != "pi-mode-state.v3":
            version_note = (f"recorded as {mode.get('customType')}; only v3 fingerprint "
                            f"semantics are interpreted, so drift is left unverifiable")
        _add(fields, F.present("M-1", {"baseKey": state.get("baseKey"),
                                       "overlayKeys": state.get("overlayKeys"),
                                       "driftPolicy": state.get("driftPolicy"),
                                       "activatedAt": state.get("activatedAt"),
                                       "source": state.get("source"),
                                       "definitions": definitions,
                                       "customType": mode.get("customType")},
                               source="session custom mode state + mode definition files (path/digest/label only)",
                               privacy=1, observed_at=mode.get("timestamp"), note=version_note))
        drift = pi_state.mode_drift(
            state.get("fingerprints") if mode.get("customType") == "pi-mode-state.v3" else None,
            policy=ctx.policy,
                                    global_mode_dir=ctx.paths.global_mode_dir,
                                    cwd=view.header_cwd)
        if drift["state"] == "drift":
            _add(fields, F.present("M-2", drift, source="recomputed pi-modes definition digest",
                                   privacy=1, note="recorded digest != current file digest"))
        elif drift["state"] in ("matched", "partial"):
            _add(fields, F.present("M-2", drift, source="recomputed pi-modes definition digest",
                                   privacy=1))
        else:
            _add(fields, F.unknown("M-2", drift.get("reason") or "digest not recomputable",
                                   source="mode definition files", privacy=1,
                                   note="behold does not invent a digest algorithm"))
    else:
        _add(fields, F.absent("M-1", "no pi-mode-state.v3 entry on the active branch",
                              source="session custom entries", privacy=1))
        _add(fields, F.unknown("M-2", "no recorded mode fingerprint", source="session custom entries",
                               privacy=1))

    declared = ident.env.get("PI_PROFILE") if ident.trusted else None
    profile = (
        pi_state.profile_state(
            os.path.join(ctx.paths.instances_dir, instance)
            if instance and ctx.paths.instances_dir else None,
            ctx.paths.profiles_dir,
            ctx.policy,
        )
        if ident.trusted else {"error": f"noaccess:{ident.untrusted_reason()}", "selected": None,
                               "resolved": None, "catalog": None, "instance": None, "path": None}
    )
    if profile.get("selected") or declared:
        value = {
            # Exactly one allowlisted environment key is ever emitted, and only its value:
            # no env dump, no other keys, no HERDR_*, no paths from the environment.
            "declared": {"profile": declared,
                         "source": "process env key PI_PROFILE (process-start; single allowlisted key)",
                         "may_be_stale_after": "/profile"},
            "selected": {"value": profile.get("selected"), "source": profile.get("selected_source"),
                         "path": profile.get("path")},
            "resolved": profile.get("resolved"),
            "instance": profile.get("instance"),
            "catalog": profile.get("catalog"),
        }
        notes = []
        if declared and profile.get("selected") and declared != profile["selected"]:
            notes.append("declared PI_PROFILE != saved launch-plan profile; the process-start value can be stale after /profile")
        _add(fields, F.present("M-3", value,
                               source="process env key PI_PROFILE + instances/<instance>/pi-profile.json",
                               privacy=1, observed_at=ctx.as_of_iso,
                               note="; ".join(notes) if notes else None))
    else:
        _add(fields, F.unknown("M-3", profile.get("error") or "no declared or saved profile",
                               source="process env (single allowlisted key) + per-instance profile",
                               privacy=1,
                               note=None if ident.trusted else
                               "identity is not verified: no profile or instance preload"))

    pin = fleet_state.room_pin(ctx.paths.agent_dir, pane_id, ctx.policy)
    if pin.get("name"):
        _add(fields, F.present("M-5", {"name": pin["name"], "procId": pin["procId"]},
                               source=pin.get("path"), observed_at=ctx.as_of_iso))
    else:
        _add(fields, F.absent("M-5", pin.get("error") or "no room pin for this pane",
                              source=pin.get("path")))
    membership = fleet_state.room_membership(ctx.paths.agent_dir, pin.get("name"), ctx.policy)
    if membership.get("error") and not membership.get("rooms"):
        _add(fields, F.unknown("M-6", membership["error"], source="rooms/registry + rooms/rooms",
                               privacy=1))
    else:
        _add(fields, F.present("M-6", {"rooms": membership["rooms"],
                                       "room_count": membership["room_count"],
                                       "registry_count": membership["registry_count"]},
                               source="rooms/registry + rooms/rooms (names/counts only)",
                               privacy=1, observed_at=ctx.as_of_iso))
    _add(fields, F.unknown("M-7", "presence/inbox depth is deferred to P3 (opt-in runtime read)",
                           source="rooms/presence + inbox", privacy=1))


def _fill_goals_todos_crons(fields: dict[str, F.Field], ctx: Context, view: session.SessionView,
                            ident: identity.Identity, instance: str | None, cwd: str | None) -> None:
    goals = view.goal_state()
    if not goals:
        _add(fields, F.absent("G-1", "no per-session goal state entry", source="session custom entries",
                              privacy=1))
        _add(fields, F.absent("G-2", "no per-session goal state entry", source="session custom entries",
                              privacy=1))
    else:
        state = goals.get("state") or {}
        if state.get("text_only") and not state.get("statuses"):
            reason = "goal state is text-only; count withheld (goal text is class 2)"
            _add(fields, F.unknown("G-1", reason, source="session custom goal entry", privacy=1))
            _add(fields, F.unknown("G-2", reason, source="session custom goal entry", privacy=1))
        else:
            _add(fields, F.present("G-1", {"count": state.get("count"),
                                           "by_status": state.get("statuses")},
                                   source="session custom goal entry (structured counts only)",
                                   privacy=1, observed_at=goals.get("timestamp")))
            _add(fields, F.present("G-2", state.get("queue_depth"),
                                   source="session custom goal entry (depth only)", privacy=1,
                                   observed_at=goals.get("timestamp")))

    todos = view.todo_state()
    mirror = pi_state.todo_mirror(
        os.path.join(ctx.paths.instances_dir, instance) if instance and ctx.paths.instances_dir else None,
        view.header_id, ctx.policy)
    if todos and todos.get("state"):
        state = todos["state"]
        session_total = state.get("total")
        value = {"open": state.get("by_status", {}).get("in_progress", 0)
                 + state.get("by_status", {}).get("pending", 0),
                 "completed": state.get("by_status", {}).get("completed", 0),
                 "total": session_total,
                 "by_status": state.get("by_status"),
                 "source": "session custom pi-core-todo-state (active branch)",
                 "session_store_total": session_total,
                 "instance_store_total": mirror.get("total") if mirror.get("found") else None,
                 "instance_store_path": mirror.get("path") if mirror.get("found") else None}
        if mirror.get("found") and mirror.get("total") is not None and session_total is not None \
                and mirror["total"] != session_total:
            _add(fields, F.conflict("D-1", value,
                                    f"CONFLICT(session={session_total}, instance={mirror['total']})",
                                    source="session custom entry vs instance pi-todo-state.json",
                                    privacy=1, observed_at=todos.get("timestamp")))
        else:
            _add(fields, F.present("D-1", value, source="session custom pi-core-todo-state (active branch)",
                                   privacy=1, observed_at=todos.get("timestamp")))
    elif mirror.get("found"):
        _add(fields, F.present("D-1", {"total": mirror.get("total"), "by_status": mirror.get("counts"),
                                       "source": "instance pi-todo-state.json (no session entry)"},
                               source=mirror.get("path"), privacy=1))
    else:
        _add(fields, F.absent("D-1", "no todo state in session or instance store",
                              source="session custom + instance pi-todo-state.json", privacy=1))
    _add(fields, F.withheld("D-2", "TODO subjects are class 2 and are never exported; counts only"))

    crons = ctx.crons_for(cwd)
    if crons.get("error"):
        _add(fields, F.unknown("C-1", crons["error"], source=crons.get("path"), privacy=1))
    else:
        _add(fields, F.present("C-1", {"tasks": crons["tasks"], "count": crons["count"]},
                               source="cron tasks.json filtered by projectDir (id/name/schedule only)",
                               privacy=1, observed_at=ctx.as_of_iso,
                               note="prompt fields present in the store were skipped, not read into output"))
    _add(fields, F.withheld("C-2", "cron prompt bodies are class 2 and are never read into output"))


def _fill_extensions_skills_prompts(fields: dict[str, F.Field], ctx: Context,
                                    view: session.SessionView, instance: str | None,
                                    ident: identity.Identity) -> None:
    replay = view.replay()
    inferred = pi_state.inferred_extensions(replay)
    _add(fields, F.inferred("E-1", inferred, inferred["limitation"],
                            source="session system-message replay (toolsAdded/toolsRemoved + skills section)",
                            observed_at=util.iso(view.last_entry_ts())))
    settings = (
        ctx.settings_for(os.path.join(ctx.paths.instances_dir, instance)
                         if instance and ctx.paths.instances_dir else None)
        if ident.trusted else {"packages": [], "prompt_paths": [], "skill_paths": [],
                               "sources": [], "error": f"noaccess:{ident.untrusted_reason()}"}
    )
    if settings.get("packages"):
        _add(fields, F.present("E-2", {"packages": settings["packages"],
                                       "count": len(settings["packages"])},
                               source="settings.json package entries (name+ref only)",
                               observed_at=ctx.as_of_iso))
    else:
        _add(fields, F.absent("E-2", settings.get("error") or "no package entries in settings",
                              source="settings.json"))

    profile = (
        pi_state.profile_state(
            os.path.join(ctx.paths.instances_dir, instance)
            if instance and ctx.paths.instances_dir else None,
            ctx.paths.profiles_dir, ctx.policy)
        if ident.trusted else {"resolved": None}
    )
    resolved_skills = (profile.get("resolved") or {}).get("skills") or []
    loaded = [{"name": name, "path": location} for name, location in sorted(replay["skills"].items())]
    resolved_names = sorted({s["name"] for s in resolved_skills})
    loaded_names = sorted({s["name"] for s in loaded})
    if loaded:
        value = {"loaded": loaded, "loaded_count": len(loaded),
                 "resolved_skill_names": resolved_names,
                 "resolved_count": len(resolved_names)}
        if resolved_names and loaded_names != resolved_names:
            _add(fields, F.conflict("S-1", value,
                                    "CONFLICT(session skills section != saved profile resolution)",
                                    source="session skills section + pi-profile.json resolved.skills"))
        else:
            _add(fields, F.present("S-1", value,
                                   source="session skills section (names+paths) + pi-profile.json resolved.skills",
                                   observed_at=util.iso(view.last_entry_ts()),
                                   note="metadata listing only; skill bodies were not read"))
    else:
        _add(fields, F.absent("S-1", "no skills section on the active branch",
                              source="session system messages"))
    _add(fields, F.withheld("S-2", "skill bodies are class 2; only names and paths are emitted"))

    prompt_paths = settings.get("prompt_paths", [])
    sections = replay.get("sections", [])
    _add(fields, F.present("S-3", {"configured_paths": prompt_paths,
                                   "configured_count": len(prompt_paths),
                                   "loaded_section_names": sections,
                                   "loaded_is_not_proof_of_bodies": True},
                           source="settings.json prompt sources + session system-message section names",
                           observed_at=ctx.as_of_iso,
                           note="configured != loaded; section names prove which sections were present, not their bodies"))
    _add(fields, F.withheld("S-4", "prompt bodies are class 2; only paths and section names are emitted"))


def _fill_jobs(fields: dict[str, F.Field], ctx: Context, view: session.SessionView) -> None:
    bg_calls = view.last_tool_calls({"bash_bg"})
    mon_calls = view.last_tool_calls({"monitor"})
    bg = fleet_state.bg_jobs(ctx.paths.bg_dir, bg_calls, {"as_of": ctx.as_of}, ctx.policy)
    if bg.get("error") and not bg.get("log_count"):
        _add(fields, F.last_observed("J-1", {"tool_calls": bg_calls}, bg["error"],
                                     source="session tool calls + pi-bg logs", privacy=1))
    else:
        _add(fields, F.last_observed(
            "J-1",
            {"log_files": bg["log_files"], "log_count": bg["log_count"], "tool_calls": bg_calls},
            "as_of last tool call; a log file's size/mtime is not a running state",
            source="pi-bg/*.log stats + session bash_bg calls", privacy=1))
    _add(fields, F.last_observed("J-2", fleet_state.monitor_calls(mon_calls),
                                 fleet_state.monitor_calls(mon_calls)["limitation"],
                                 source="session monitor tool calls", privacy=1))
    bizzy = fleet_state.bizzy_state(ctx.paths.agent_dir, ctx.policy)
    _add(fields, F.unknown("J-3", "bizzy.json holds only disabledTools; there is no persistable monitor registry",
                           source="bizzy.json", privacy=1,
                           note=f"disabledTools={bizzy.get('disabledTools')}"))


def _fill_dagr_beads(fields: dict[str, F.Field], ctx: Context, ident: identity.Identity,
                     workspace_id: str | None, pane_id: str | None) -> None:
    recent = str(ctx.paths.state_dir) + "/dagr/recent" if ctx.paths.state_dir else None
    dagr = fleet_state.dagr_runs(recent, pane_id, {"as_of": ctx.as_of}, ctx.policy,
                                 preloaded=ctx.dagr)
    if dagr.get("error") and not dagr.get("count"):
        _add(fields, F.unknown("G-3", dagr["error"], source=dagr.get("path"), privacy=1))
        _add(fields, F.unknown("G-4", dagr["error"], source=dagr.get("path"), privacy=1))
    elif dagr.get("count") == 0:
        _add(fields, F.absent("G-3", "no dagr run names this pane", source=recent, privacy=1))
        _add(fields, F.absent("G-4", "no dagr run names this pane", source=recent, privacy=1))
    else:
        _add(fields, F.present("G-3", {"runs": dagr["runs"], "count": dagr["count"]},
                               source="dagr run.json matched on orchestrator/task locator pane",
                               privacy=1, observed_at=ctx.as_of_iso,
                               note="task state values are as recorded; not progress inference"))
        _add(fields, F.present("G-4", {"stale": dagr["stale"],
                                       "oldest_generated_age_s": dagr["oldest_generated_age_s"]},
                               source="observed_at - run.generated_at vs run.events",
                               privacy=1, observed_at=ctx.as_of_iso))

    beads = fleet_state.beads_for_lane(
        ctx.paths.beads_file, pane_id=pane_id,
        trusted_session_id=ident.trusted_session_id, workspace_id=workspace_id,
        policy=ctx.policy, preloaded=ctx.beads,
        untrusted_reason=ident.untrusted_reason())
    if beads.get("error"):
        _add(fields, F.unknown("B-1", beads["error"], source=beads.get("path"), privacy=1,
                               note=f"join={beads['join']}"))
    else:
        _add(fields, F.present("B-1", {"count": beads["count"],
                                       "by_status": beads["by_status"],
                                       "issues": beads["issues"],
                                       "join": beads["join"],
                                       "scoped_project_label": beads["scoped_project_label"],
                                       "rejected": beads["rejected"]},
                               source="beads export filtered by metadata.agent_pane + metadata.agent_session",
                               privacy=1, observed_at=ctx.as_of_iso,
                               note="labels scope the project only; owner/label/prompt-text joins are rejected"))
    _add(fields, F.withheld("B-2", "bead description/notes are class 2; ids and counts only"))


def _fill_state_only(fields: dict[str, F.Field], ctx: Context, ident: identity.Identity,
                     instance: str | None, cwd: str | None, pane_id: str | None,
                     workspace_id: str | None) -> None:
    """Fill the fields that do not need a session file (repo, rooms, crons, dagr, beads)."""
    fake_view = session.SessionView(
        path="", realpath="", version=None, header_id=None, header_cwd=cwd,
        header_ts=None, parent_session=None, entries=[], by_id={}, leaf_id=None,
        leaf_source="none", chain=[], chain_state=session.CHAIN_EMPTY,
    )
    agent = {"cwd": cwd}
    _fill_repo(fields, ctx, fake_view, agent, ctx.snapshot.workspace(workspace_id))
    pin = fleet_state.room_pin(ctx.paths.agent_dir, pane_id, ctx.policy)
    if pin.get("name"):
        _add(fields, F.present("M-5", {"name": pin["name"], "procId": pin["procId"]},
                               source=pin.get("path"), observed_at=ctx.as_of_iso))
    else:
        _add(fields, F.absent("M-5", pin.get("error") or "no room pin for this pane",
                              source=pin.get("path")))
    membership = fleet_state.room_membership(ctx.paths.agent_dir, pin.get("name"), ctx.policy)
    if membership.get("rooms"):
        _add(fields, F.present("M-6", {"rooms": membership["rooms"],
                                       "room_count": membership["room_count"],
                                       "registry_count": membership["registry_count"]},
                               source="rooms/registry + rooms/rooms (names/counts only)",
                               privacy=1, observed_at=ctx.as_of_iso))
    else:
        _add(fields, F.unknown("M-6", membership.get("error") or "no membership",
                               source="rooms", privacy=1))
    crons = ctx.crons_for(cwd)
    if crons.get("error"):
        _add(fields, F.unknown("C-1", crons["error"], source=crons.get("path"), privacy=1))
    else:
        _add(fields, F.present("C-1", {"tasks": crons["tasks"], "count": crons["count"]},
                               source="cron tasks.json filtered by projectDir", privacy=1,
                               observed_at=ctx.as_of_iso))
    _add(fields, F.withheld("C-2", "cron prompt bodies are class 2"))
    _fill_dagr_beads(fields, ctx, ident, workspace_id, pane_id)
