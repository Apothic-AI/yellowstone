#!/usr/bin/env python3
"""Render the leader board: one row per leader lane, with goal state and staleness.

SOURCE: `behold roster --json` — not pane reads. This board used to read every leader
pane's footer (`herdr agent read --source visible`), one call per lane per run, to get the
goal state and the context number. Those fields now come from behold's derived fields:

    goal, goal elapsed   G-1  (the live goal-state entry: status, iteration, elapsed)
    context              T-3  (= T-1/T-2 from the session's terminal usage) — occupancy
    status               H-5
    session path         P-5  (validated, so the size column stats a proven file)
    mode / rooms / profile / model / thinking
                         M-1 / M-5 / M-3 / P-1,P-2 / P-3

Every lane carries the FIELD REASONS for whatever it could not answer: a lane whose goal
or context is unknown says why in the `why` column, because "unknown" without a reason is
the failure this board exists to avoid. A `held` lane (reserved workspace) stays `held`;
it is never rendered as unknown and never as blank.

CONTEXT IS OCCUPANCY. The column reads `occ%` and comes from T-1/T-2 — the tokens pi
reported on the branch's last assistant message over the physical model's window. It is
measured the same way on every lane and it needs no pane. Measured against the footer on
this lane in the same minute (2026-11-17T02:52Z): footer `34.8%/1.0M`, T-3 `34.54` — the
same reading, so the column is comparable with what the operator has been reading.


Why this exists
---------------
`herdr agent list` gives lifecycle status but no goal state, and nothing anywhere
tells you how long a lane has been in its current status. Both matter for the
overlord's job: a lane stuck in `working` for 50 minutes and a lane legitimately
building for 50 minutes are indistinguishable from the status field alone, and a
paused or blocked goal looks like an ordinary stop.

Design notes
------------
* Status and goal state are read from two different surfaces on purpose. Lifecycle
  comes from the herdr API (cheap, structured). Goal state comes from the pane's
  own footer line, because `herdr agent get`/`agent list` carry no goal fields --
  this was verified against panes that visibly report "Pursuing goal (47m)".
* Staleness is computed across runs from a persisted snapshot, not guessed from a
  single observation. First run has no baseline, so it reports `-` rather than
  inventing an elapsed time.
* A lane whose pane exists but whose agent is gone is reported as `no-agent`, not
  as some flavour of idle. Those need a different response.
* **Context is occupancy, from the session, not a pane reading.** `occ%` is `T-3` =
  `T-1` (the branch's last assistant `usage.totalTokens`) over `T-2` (the physical model's
  `contextWindow`, read from pi's own provider registry). One earlier version of this board
  argued the footer percentage was a *forward projection* and labelled it `ctx~`; that was
  inherited from a different extension's renderer and it is not what the replacement
  measures. Measured against the footer on this lane in the same minute
  (2026-11-17T02:52:18Z): footer `34.8%/1.0M`, `T-3` `34.54` — the same reading, so the
  column stays comparable with what the operator has been watching.
  The footer's *other* percentage, `CH99.8%`, is the cache-hit rate; it is not context.
* **A context number is never invented.** If `T-1` or `T-2` is unknown, `occ%` is `-` and
  the reason appears in the `why` block. It is not 0, and a lane with no agent is not
  "using nothing": it has no session to measure.
* A lane with no agent has no footer, so its context is `None`, not 0. The
  difference decides whether a lane is one tranche from losing its history or
  simply not running.
* Read-only. Never prompts, never mutates pane state.

Usage
-----
    ./leader-board.py                # table
    ./leader-board.py --json         # machine-readable
    ./leader-board.py --changed      # only lanes whose status changed since last run
    ./leader-board.py --arm          # just list pane ids of lanes worth watching

Exit codes: 0 always on a successful read (findings are data, not failure);
2 if herdr itself could not be queried.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

BEHOLD = os.environ.get("BEHOLD", "behold")
STATE_DIR = Path.home() / ".local" / "state" / "overlord"
SNAPSHOT = STATE_DIR / "leader-board.json"

# A leader tab is a tab whose label ends in "-leader" (or is exactly "leader").
# This is the operator's own naming convention for orchestrator tabs, so it is
# the authority on what a leader lane is -- not a hardcoded workspace list, which
# would rot the moment a space is added or renamed.
LEADER_LABEL = re.compile(r"(^|-)leader$", re.IGNORECASE)

# Goal state, strongest signal first. The footer strings come from
# pi-codex-goal's format.ts and are matched loosely so a wording tweak does not
# silently blank the column.
GOAL_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Highest specificity first: these are all rendered distinctively by the
    # extension, and each carries a different required response.
    (re.compile(r"Goal achieved", re.I), "achieved"),
    (re.compile(r"Goal unmet", re.I), "budgetLimited"),
    (re.compile(r"Goal abandoned", re.I), "budgetLimited"),
    (re.compile(r"Goal blocked", re.I), "blocked"),
    (re.compile(r"Goal needs attention", re.I), "attention"),
    (re.compile(r"Goal paused", re.I), "paused"),
    (re.compile(r"Pursuing goal", re.I), "active"),
]

# `Pursuing goal (1d 0h 11m)` -- the goal's own active duration, which is a
# lower bound on how long the lane has been going. Used to catch a lane that was
# already deep into a run before this tool ever saw it.
GOAL_ELAPSED = re.compile(
    r"\(\s*(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:\)|\s)", re.IGNORECASE
)
GOAL_DURATION_LINE = re.compile(r"(?:Pursuing|Goal achieved|Goal paused|Goal blocked)", re.IGNORECASE)

# Context occupancy, read off the pane footer: `67.1%/1.0M (auto)`. The qualifier
# is optional on purpose -- `(auto)` and `(fixed)` both appear and either way the
# percentage is the same reading. Matching the `/1.0M` denominator is what keeps
# this off `CH99.8%`, the cache-hit rate that sits a few characters to the left.
CTX_PATTERN = re.compile(
    r"([0-9]{1,3}(?:\.[0-9])?)%\s*/\s*([0-9.]+)\s*([KMG])\b\s*(?:\((auto|fixed)\))?",
    re.IGNORECASE,
)

# The operator's context-reset threshold, and the band that says "act at the next
# stop boundary". Both live here rather than in the renderer so the watcher and
# the board cannot disagree about where the line is.
CTX_RESET = 50.0
CTX_WARN = 40.0

# Per-lane overrides of the reset threshold, by lane name. Empty by standing decision, and
# the history matters more than the mechanism here: the operator set a tighter policy for one
# lane on 2026-11-04 (at >=250k of a 1.0M window, 25%, run the full compaction procedure
# rather than waiting for the global line), then relaxed it on 2026-11-08 to 50% — which is
# the global line, so the override was removed rather than left in as a no-op. The mechanism
# stays for any future tighter policy: add the lane here, beside the global line, so the board
# and the periodic wake cannot disagree about where the line is.
CTX_THRESHOLD_OVERRIDES: dict[str, float] = {}

# Statuses that mean the lane is not going to make progress on its own.
NEEDS_ATTENTION = {"blocked", "no-agent", "held"}


def herdr(*args: str) -> dict:
    """Run a herdr subcommand and return its parsed `result` object."""
    try:
        out = subprocess.run(
            ["herdr", *args],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"leader-board: herdr {' '.join(args)} failed: {exc}", file=sys.stderr)
        raise SystemExit(2)
    if out.returncode != 0:
        print(
            f"leader-board: herdr {' '.join(args)} exited {out.returncode}: "
            f"{out.stderr.strip()[:400]}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    try:
        return json.loads(out.stdout)["result"]
    except (json.JSONDecodeError, KeyError) as exc:
        print(f"leader-board: unparsable herdr output ({exc})", file=sys.stderr)
        raise SystemExit(2)


def parse_goal_elapsed(text: str) -> int | None:
    """Seconds of goal duration reported in a footer line, if any.

    Reads the `(1d 0h 11m)` / `(39m)` / `(12h 15m)` suffix pi-codex-goal appends.
    Returns None when the line carries no duration, so absence is never confused
    with zero.
    """
    if not GOAL_DURATION_LINE.search(text):
        return None
    m = GOAL_ELAPSED.search(text)
    if not m:
        return None
    d, h, mi = (int(g) if g else 0 for g in (m.group(1), m.group(2), m.group(3)))
    secs = d * 86400 + h * 3600 + mi * 60
    return secs or None


def parse_ctx(text: str) -> float | None:
    """Context occupancy percentage from a footer line, or None if absent.

    Anchored on the `/1.0M` denominator so the cache-hit rate (`CH99.8%`) can
    never be mistaken for context. Returns None -- not 0.0 -- when the line has
    no such field, because "no reading" and "empty context" are different facts.
    """
    for match in CTX_PATTERN.finditer(text):
        try:
            value = float(match.group(1))
        except ValueError:
            continue
        if 0.0 <= value <= 100.0:
            return value
    return None


def pane_footer(pane_id: str) -> tuple[str | None, str, int | None, float | None]:
    """Return (goal_state, last_line, goal_elapsed_secs, context_pct) from the footer.

    Deliberately tolerant: a resume/approval modal or a partially drawn frame
    means the goal cannot be determined, and that is reported as unknown rather
    than as "no goal". Reading a pane that has no agent is a normal outcome here,
    so it is not an error.

    Goal and context are read in one pass on purpose. Both live in the footer, so
    a second `herdr agent read` per lane would double the cost of every board run
    to re-read bytes already in hand.

    `--source visible` is required, not cosmetic. Reading a fullscreen pane's
    history (`recent`/`recent-unwrapped`, and the default) makes herdr inject SGR
    mouse-wheel events into the pane's pty to harvest scrollback
    (src/server/alt_screen_read.rs: send_wheel, SettleInitial/Harvest/Restore).
    The lane visibly scrolls up and snaps back — measured on an idle lane at
    ~1s per read, which is the FT-27 "TUI scrolls up then jumps back" report.
    The footer is on the visible screen, so this source answers the same question
    without touching the pty.
    """
    try:
        out = subprocess.run(
            ["herdr", "agent", "read", pane_id, "--source", "visible"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None, "", None, None
    if out.returncode != 0:
        return None, "", None, None
    lines = [ln.rstrip() for ln in out.stdout.splitlines() if ln.strip()]
    if not lines:
        return None, "", None, None
    # The footer is the last non-empty line, but the goal status can sit one
    # line above a trailing prompt hint, so scan the final few lines.
    tail = lines[-3:]
    goal: str | None = None
    elapsed: int | None = None
    # The context field is on the always-present metrics line, so look through
    # the whole tail for it: it outranks a goal line for cheapness and must not
    # be lost because the goal scan broke out early.
    ctx: float | None = None
    for line in reversed(tail):
        ctx = parse_ctx(line)
        if ctx is not None:
            break
    for line in tail:
        if elapsed is None:
            elapsed = parse_goal_elapsed(line)
        for pattern, state in GOAL_PATTERNS:
            if pattern.search(line):
                goal = state
                break
        if goal:
            break
    return goal, lines[-1][:160], elapsed, ctx


def load_snapshot() -> dict:
    if not SNAPSHOT.exists():
        return {}
    try:
        return json.loads(SNAPSHOT.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_snapshot(rows: list[dict], ctx_reset: float = CTX_RESET) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SNAPSHOT.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(
            {
                "written_at": int(time.time()),
                "ctx_reset": ctx_reset,
                "ctx_warn": CTX_WARN,
                "lanes": rows,
            },
            indent=1,
        )
    )
    tmp.replace(SNAPSHOT)


def behold_roster() -> dict:
    """One `behold roster --json` for the whole board. Never a pane read.

    A failure is fatal and loud: falling back to a pane read would reintroduce exactly the
    probing this conversion removed, and a silent fallback is how a fleet relearns to scroll.
    """
    proc = subprocess.run(
        [BEHOLD, "roster", "--cache", "off", "--json"],
        capture_output=True, text=True, timeout=180, check=False,
    )
    if proc.returncode != 0:
        raise SystemExit(f"behold roster failed rc={proc.returncode}: {proc.stderr.strip()[:400]}")
    return json.loads(proc.stdout)


def field_of(lane: dict, code: str) -> dict:
    return (lane.get("fields") or {}).get(code) or {}


def field_value(lane: dict, code: str) -> object:
    value = field_of(lane, code)
    return value.get("value") if value.get("state") in ("present", "derived", "last_observed") else None


def field_why(lane: dict, code: str) -> str | None:
    """`code=state:reason` for any field the board consumes that is not present.

    A bare `unknown` is not actionable: it does not say whether the session is missing, the
    pin is stale, or the workspace is held. The reason travels to the row.
    """
    value = field_of(lane, code)
    state = value.get("state")
    if state in ("present", "derived"):
        return None
    reason = value.get("reason") or value.get("note") or "no reason recorded"
    return f"{code}={state}:{reason}"


GOAL_LABELS = {
    "active": "pursuing",
    "queued": "queued",
    "paused": "paused",
    "blocked": "blocked",
    "usage_limited": "usage-limited",
    "budget_limited": "budget-limited",
    "complete": "achieved",
}


def held_rows(doc: dict) -> list[dict]:
    """Rows for panes the policy withheld — present as `held`, never dropped.

    A held lane has no name in the roster (`handles.name` is null, every field is `held`), so
    filtering on the `*-leader` label dropped it silently. Policy is a state, not a gap: the
    row is rendered by pane id with the admission reason, occupancy and size `-`, and a note
    that the name is withheld. The name is NOT guessed from the role records: 18 leader role
    records exist for retired lanes, so any 1:1 mapping would be a guess, and a guessed name on
    a held lane is worse than an honest `w2:p1A`.
    """
    rows: list[dict] = []
    for lane in doc.get("lanes", []):
        admission = lane.get("admission") or {}
        if admission.get("admitted") is not False:
            continue
        pane = str((lane.get("handles") or {}).get("pane_id") or lane.get("key") or "")
        workspace = str((lane.get("handles") or {}).get("workspace_id") or "")
        reason = str(admission.get("reason") or "held_by_policy")
        rows.append({
            "workspace": workspace,
            "workspace_label": "",
            "tab_id": "",
            "label": f"{pane} (name withheld)",
            "pane_id": pane,
            "cwd": "",
            "status": "held",
            "goal": None,
            "goal_elapsed": None,
            "ctx": None,            # never 0.0%: nothing was read
            "session_bytes": None,  # never 0: no session was opened
            "session_age": None,    # never 0: no session was opened
            "mode": None, "profile": None, "rooms": None, "model": None, "thinking": None,
            "why": [f"{reason} — identity and content withheld by policy; the row "
                    f"is listed so a held lane cannot vanish from the board"],
            "field_states": {code: "held" for code in
                             ("H-5", "G-1", "T-1", "T-2", "T-3", "M-1", "M-3", "M-5", "P-5")},
        })
    return rows


def collect() -> list[dict]:
    doc = behold_roster()
    rows: list[dict] = []
    for lane in doc.get("lanes", []):
        if (lane.get("admission") or {}).get("admitted") is False:
            continue  # handled by held_rows(), which does not filter on a name it cannot see
        label = str(field_value(lane, "H-4") or "")
        if not LEADER_LABEL.search(label.strip()):
            continue
        h5 = field_of(lane, "H-5")
        status = (field_value(lane, "H-5") or {}).get("status") if h5.get("state") == "present" else None
        if status is None:
            status = h5.get("state") or "unknown"
        goal_state = field_value(lane, "G-1") or {}
        goal = None
        if isinstance(goal_state, dict) and goal_state.get("status"):
            goal = GOAL_LABELS.get(goal_state["status"], goal_state["status"])
        # G-1 absent means "no goal recorded", which the column shows as `-`; the
        # summary line below counts those rather than repeating the word on every row.
        profile = field_value(lane, "M-3") or {}
        session_path = (field_value(lane, "P-5") or {}).get("path") if field_of(lane, "P-5").get("state") == "present" else None
        try:
            session_bytes = os.path.getsize(session_path) if session_path else None
        except OSError:
            session_bytes = None
        # The progress signal: how long since this lane last WROTE to its session.
        # A wedged lane's session mtime freezes; a lane in a long legitimate turn
        # keeps writing. Time-in-status alone cannot tell those apart, so it is
        # never used alone -- see the STALE note below.
        try:
            session_age = int(time.time() - os.path.getmtime(session_path)) if session_path else None
        except OSError:
            session_age = None
        def nested(value, *keys):
            for key in keys:
                if isinstance(value, dict):
                    value = value.get(key)
                else:
                    return None
            return value

        m1 = field_value(lane, "M-1")
        m3 = field_value(lane, "M-3")
        m5 = field_value(lane, "M-5")
        p2 = field_value(lane, "P-2")
        rig = {
            "mode": nested(m1, "baseKey"),
            "profile": nested(m3, "selected", "value") or nested(m3, "declared", "profile"),
            "rooms": nested(m5, "name"),
            "model": nested(p2, "selected") or (p2 if isinstance(p2, str) else None),
            "thinking": field_value(lane, "P-3") if isinstance(field_value(lane, "P-3"), str) else None,
        }
        rows.append({
            # The id, not the display label: the column is parsed by the watcher, and a
            # renamed workspace must not silently change a column's width or its meaning.
            "workspace": str(field_value(lane, "H-2") or ""),
            "workspace_label": str(field_value(lane, "H-1") or ""),
            "tab_id": str(field_value(lane, "H-3") or ""),
            "label": label,
            "pane_id": str(field_value(lane, "H-3") or lane.get("key") or ""),
            "cwd": str((field_value(lane, "H-6") or {}).get("cwd") or "") if isinstance(field_value(lane, "H-6"), dict) else "",
            "status": status,
            "goal": goal,
            "goal_elapsed": int(goal_state["elapsed_s"]) if isinstance(goal_state, dict) and isinstance(goal_state.get("elapsed_s"), (int, float)) else None,
            "ctx": field_value(lane, "T-3"),
            "session_bytes": session_bytes,
            "session_age": session_age,
            **rig,
            "why": [w for w in (field_why(lane, code) for code in
                                ("H-5", "G-1", "T-1", "T-2", "T-3", "M-1", "M-3", "M-5", "P-5")) if w],
            "field_states": {code: field_of(lane, code).get("state") for code in
                             ("H-5", "G-1", "T-1", "T-2", "T-3", "M-1", "M-3", "M-5", "P-5", "P-2", "P-3")},
        })
    rows.extend(held_rows(doc))
    rows.sort(key=lambda r: (r["workspace"], r["label"]))
    return rows


def annotate_staleness(rows: list[dict], previous: dict) -> None:
    now = int(time.time())
    prior = {row["pane_id"]: row for row in previous.get("lanes", []) if row.get("pane_id")}
    for row in rows:
        old = prior.get(row["pane_id"])
        if not old:
            row["since"] = None
            row["secs"] = None
            row["changed"] = True
            continue
        if old.get("status") == row["status"] and old.get("goal") == row["goal"]:
            # Carry the original timestamp forward so elapsed time accumulates
            # across runs instead of resetting every poll.
            row["since"] = old.get("since") or previous.get("written_at")
            row["changed"] = False
        else:
            row["since"] = now
            row["changed"] = True
        row["secs"] = (now - row["since"]) if row["since"] else None
        # The goal's own reported duration is real evidence from before this tool
        # first ran, so treat it as a lower bound on how long the lane has been
        # going. Without this, a lane already 24h into a run reads as "10m" simply
        # because that is when observation started.
        #
        # BUT: a goal's duration accumulates while it is *paused*, so a goal resumed
        # after a long pause reports hours that were not spent working. Believing it
        # makes every recovered lane alarm the instant it is resumed. On a transition
        # back to active, the goal clock is therefore only trusted when the observer
        # never saw the goal paused -- otherwise observation time is the answer.
        goal_was_paused = (old or {}).get("goal") == "paused"
        # Any record of a resumption -- this poll or a persisted earlier one -- means
        # the goal's accumulated duration spans a pause and cannot be read as
        # continuous work. Check the timestamp directly: a derived boolean is written
        # after this test and would be cleared on every subsequent poll.
        resumed_at = (old or {}).get("resumed_at")
        resuming_now = goal_was_paused and row.get("goal") == "active"
        if resuming_now:
            resumed_at = now
        row["resumed_at"] = resumed_at
        has_resume = resumed_at is not None
        if has_resume:
            row["resumed"] = True
        ge = row.get("goal_elapsed")
        # While a goal has been resumed, its accumulated duration is not a lower
        # bound on continuous work: most of that time was spent paused.
        if ge and ge > (row["secs"] or 0) and not has_resume:
            row["secs"] = ge
            row["secs_source"] = "goal"
        else:
            row["secs_source"] = "observed"


def human(secs: int | None) -> str:
    if secs is None:
        return "-"
    if secs < 90:
        return f"{secs}s"
    if secs < 5400:
        return f"{secs // 60}m"
    if secs < 172800:
        return f"{secs // 3600}h"
    return f"{secs // 86400}d"


def size_label(n: int | None) -> str:
    """Session JSONL size. "-" for a lane with no session, which is not "0 bytes"."""
    if n is None:
        return "-"
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f}M"
    if n >= 1024:
        return f"{n // 1024}K"
    return f"{n}B"


def ctx_label(ctx: float | None) -> str:
    """Render a context reading, keeping "no reading" visually distinct from 0%.

    A no-agent lane must not read like a lane with an empty context: the first
    needs an agent, the second needs nothing.
    """
    return "-" if ctx is None else f"{ctx:.1f}%"


def ctx_threshold(label: str, default: float = CTX_RESET) -> float:
    """The reset threshold for ONE lane: a per-lane override, else the global line.

    Read through this rather than comparing against CTX_RESET directly. A lane under a
    tighter policy must flag at its own line, or the board reports it as fine while the
    operator's rule says act.
    """
    return CTX_THRESHOLD_OVERRIDES.get(label, default)


def ctx_note(ctx: float | None, reset: float = CTX_RESET, label: str = "") -> str | None:
    """Flag a lane's context reading against the reset and warn bands.

    The reset line is per-lane; the warn band is global but must never sit BELOW that lane's
    reset line, or a lane with a tighter policy would be marked "ctx-near" only after it had
    already crossed the point its operator wanted action at.
    """
    if ctx is None:
        return None
    reset = ctx_threshold(label, reset)
    warn = min(CTX_WARN, reset)
    if ctx >= reset:
        return "CTX-RESET"
    if ctx >= warn:
        return "ctx-near"
    return None


def herdr_binary_health() -> dict:
    """Ask the herdr binary guard whether the fleet runs the build we deployed.

    A deploy whose only artifact is a running process has no witness, and on
    2026-11-07 that cost a day and a half of pre-fix herdr: the machine rebooted,
    the server came back from a launcher file nobody had rewritten, and the status
    icons looked healthy the whole time. The guard watches the serving exe *and*
    the launcher file against a pinned sha; this puts its verdict on the surface
    the overlord already reads every round, instead of leaving it in a state file
    someone would have to remember to open.

    The guard is the single source of truth on purpose: duplicating its comparison
    here would let the two drift apart. Read-only; it reports and never repairs.
    """
    guard = os.environ.get("HERDR_BINARY_GUARD", str(Path.home() / ".overlord" / "tools" / "herdr-binary-guard.sh"))
    try:
        proc = subprocess.run([guard], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"state": "unknown", "detail": f"guard could not be run: {exc}"[:200]}
    detail = (proc.stderr or proc.stdout or "").strip().splitlines()
    detail = detail[0][:200] if detail else ""
    state = {0: "ok", 1: "drift"}.get(proc.returncode, "unknown")
    return {"state": state, "detail": "" if state == "ok" else detail}


def render(rows: list[dict], freshness_secs: int, ctx_reset: float = CTX_RESET) -> None:
    width = max((len(r["label"]) for r in rows), default=10)
    binary = herdr_binary_health()
    if binary["state"] != "ok":
        print(
            f"!! herdr binary {binary['state'].upper()}: the fleet is not running the deployed build, "
            f"or will not reboot into it. {binary['detail']}"
        )
        print(
            "!! A deploy that does not also rewrite ~/.local/bin/herdr evaporates at the next reboot; "
            "see CURRENT-STATE-herdr-pin-drift.md §4a."
        )
        print()
    print(
        f"{'workspace':9} {'leader':{width}} {'pane':8} {'status':9} {'goal':13} "
        f"{'occ%':7} {'size':7} {'held':6} {'rig':22} note"
    )
    print("-" * (9 + width + 8 + 9 + 13 + 7 + 7 + 6 + 22 + 40))
    for row in rows:
        notes = []
        if row["status"] in NEEDS_ATTENTION:
            notes.append(row["status"].upper())
        note = ctx_note(row.get("ctx"), ctx_reset, row["label"])
        if note:
            notes.append(note)
        # The wedge signal: held in `working` past the threshold. Any other
        # status sitting still is correct behaviour and must not be flagged.
        #
        # Time-in-status cannot separate a wedge from a long turn: both stay in
        # `working` for as long as they last, so the threshold is a PROXY and on its
        # own it manufactures a false positive on every legitimately long turn. It
        # therefore only RAISES the question; the session's mtime answers it. A
        # wedged lane stops writing, a working lane does not. When the session is
        # advancing the row says `long-run` and names how long ago it wrote, so the
        # reader is handed a measurement rather than a verdict -- and STALE keeps the
        # meaning it was built for. An unreadable session falls back to the old
        # (stricter) reading, because "I could not check" must never look healthy.
        if row["status"] == "working" and (row.get("secs") or 0) >= freshness_secs:
            age = row.get("session_age")
            if age is None or age >= freshness_secs:
                why = "" if age is None else f" (no session write {human(age)})"
                notes.append(f"STALE>{human(freshness_secs)}{why}")
            else:
                notes.append(f"long-run {human(row['secs'])} (wrote {human(age)} ago)")
        if row.get("resumed"):
            notes.append("resumed")
        if row.get("changed") and not row.get("resumed"):
            notes.append("changed")
        rig = "/".join(str(part) for part in (row.get("mode"), row.get("profile"), row.get("rooms"), row.get("model"), row.get("thinking")) if part) or "-"
        print(
            f"{row['workspace']:9} {row['label'][:width]:{width}} "
            f"{row['pane_id']:8} {row['status']:9} {(row['goal'] or '-'):13} "
            f"{ctx_label(row.get('ctx')):7} "
            f"{size_label(row.get('session_bytes')):7} "
            f"{human(row['secs']) + ('' if row.get('secs_source') != 'goal' else '*'):6} "
            f"{rig[:22]:22} "
            f"{' '.join(notes)}"
        )
    # State AND reason, without repeating a benign absence twelve times: a lane whose field is
    # `unknown`/`held` prints each distinct reason once; `absent` is summarised as a count.
    absent_counts: dict[str, int] = {}
    why_rows = []
    for row in rows:
        grouped: dict[str, list[str]] = {}
        for entry in row.get("why") or []:
            if "=" not in entry:
                # A policy note, not a field code: print it as written.
                grouped.setdefault(entry, []).append("")
                continue
            code, _, rest = entry.partition("=")
            state, _, reason = rest.partition(":")
            if state == "absent":
                absent_counts[f"{code} {reason}"] = absent_counts.get(f"{code} {reason}", 0) + 1
                continue
            grouped.setdefault(f"{state}: {reason}", []).append(code)
        if grouped:
            why_rows.append((row["label"], grouped))
    if why_rows:
        print("\nwhy (state and reason, per lane — never a bare unknown):")
        for label, grouped in why_rows:
            parts = []
            for reason, codes in grouped.items():
                text = " ".join(reason.split())
                parts.append(f"{','.join(codes)} = {text}" if any(codes) else text)
            print(f"  {label}: " + "; ".join(parts))
    if absent_counts:
        print("\nabsent (a real answer, not a gap):")
        for text, count in sorted(absent_counts.items()):
            print(f"  {count} lane(s): {text}")
    no_agent = [r for r in rows if r["status"] == "no-agent"]
    if any(r.get("secs_source") == "goal" for r in rows):
        print("\n* duration is the goal's own reported active time (a lower bound on how long the lane has run),")
        print("  not elapsed-since-first-observation.")
    hot = [r for r in rows if isinstance(r.get("ctx"), (int, float)) and r["ctx"] >= ctx_threshold(r["label"], ctx_reset)]
    if hot:
        print(
            f"\n{len(hot)} lane(s) whose OCCUPANCY is at or above the line: "
            + ", ".join(
                f"{r['workspace']} ({r['label']}, {ctx_label(r.get('ctx'))}, {r['status']}"
                + (
                    f", threshold {ctx_threshold(r['label'], ctx_reset):.0f}%"
                    if ctx_threshold(r["label"], ctx_reset) != ctx_reset
                    else ""
                )
                + ")"
                for r in sorted(hot, key=lambda r: -(r.get("ctx") or 0))
            )
        )
        print(
            "  occ% is occupancy: T-1 (the branch's last assistant usage) over T-2 (the physical\n"
            "  model's context window), from the session file, with no pane read. It is a measured\n"
            "  position, not a projection, so it does not move by 20 points on an idle turn. Compare\n"
            "  the size column and the turn count before deciding to compact; crossing the line is a\n"
            "  prompt to check, not an instruction to /compact."
        )
    if no_agent:
        print(
            f"\n{len(no_agent)} leader tab(s) have no live agent: "
            + ", ".join(f"{r['workspace']} ({r['label']}, {r['cwd']})" for r in no_agent)
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="Leader board for the herdr swarm.")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--changed", action="store_true", help="only lanes changed since last run")
    ap.add_argument("--arm", action="store_true", help="pane ids of lanes worth watching, one per line")
    ap.add_argument(
        "--stale-after",
        type=int,
        default=45 * 60,
        help="seconds a lane may hold `working` before it is flagged (default 2700)",
    )
    ap.add_argument(
        "--ctx-reset",
        type=float,
        default=CTX_RESET,
        help=f"context percentage at or above which a lane is marked for reset (default {CTX_RESET:.0f})",
    )
    args = ap.parse_args()

    # Threaded through as a parameter rather than assigned to a module global: the
    # board is also imported by tests and by the watcher, and a `global` here is a
    # process-wide side effect that outlives the call. (First attempt used `global`
    # and was a hard SyntaxError -- `ast.parse` accepted it, the interpreter did not.)

    rows = collect()
    annotate_staleness(rows, load_snapshot())
    save_snapshot(rows, args.ctx_reset)

    if args.arm:
        for row in rows:
            if row["status"] not in ("no-agent", "held") and row["pane_id"]:
                print(row["pane_id"])
        return 0

    if args.changed:
        rows = [r for r in rows if r.get("changed")]

    if args.json:
        # The thresholds travel with the data so a consumer (the watcher) does not
        # keep a second copy of a policy number that then drifts out of agreement.
        print(
            json.dumps(
                {
                    "written_at": int(time.time()),
                    "ctx_reset": args.ctx_reset,
                    "ctx_warn": CTX_WARN,
                    "herdr_binary": herdr_binary_health(),
                    "lanes": rows,
                },
                indent=1,
            )
        )
    else:
        render(rows, args.stale_after, args.ctx_reset)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
