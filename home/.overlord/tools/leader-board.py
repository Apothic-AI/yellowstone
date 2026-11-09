#!/usr/bin/env python3
"""Render the leader board: one row per leader lane, with goal state and staleness.

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
* Context usage comes from the same footer read that supplies goal state. herdr
  does not expose it -- `agent get`/`agent list` return 15 fields and none is a
  token count -- so the footer's `21.5%/1.0M (auto)` is the only cheap source.
  The footer's *other* percentage, `CH99.8%`, is the cache-hit rate; reading it
  as context supports an entirely wrong diagnosis.
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
# and the hourly wake cannot disagree about where the line is.
CTX_THRESHOLD_OVERRIDES: dict[str, float] = {}

# Statuses that mean the lane is not going to make progress on its own.
NEEDS_ATTENTION = {"blocked", "no-agent"}


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
    """
    try:
        out = subprocess.run(
            ["herdr", "agent", "read", pane_id],
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


def collect() -> list[dict]:
    tabs = herdr("tab", "list").get("tabs", [])
    agents = herdr("agent", "list").get("agents", [])

    # A leader tab can exist with no agent in it (`agent_not_found`). Those are
    # real findings -- an empty leader tab is a space nobody is driving -- so
    # they belong in the board rather than being filtered out.
    by_tab: dict[str, dict] = {}
    for agent in agents:
        by_tab.setdefault(agent.get("tab_id", ""), agent)

    panes_by_tab: dict[str, str] = {}
    for pane in herdr("pane", "list").get("panes", []):
        panes_by_tab.setdefault(pane.get("tab_id", ""), pane.get("pane_id", ""))

    rows: list[dict] = []
    for tab in tabs:
        label = tab.get("label") or ""
        if not LEADER_LABEL.search(label.strip()):
            continue
        tab_id = tab["tab_id"]
        agent = by_tab.get(tab_id)
        pane_id = (agent or {}).get("pane_id") or panes_by_tab.get(tab_id, "")
        status = (agent or {}).get("agent_status") or "no-agent"
        goal, footer, goal_elapsed, ctx = (
            pane_footer(pane_id) if agent else (None, "", None, None)
        )
        rows.append(
            {
                "workspace": tab["workspace_id"],
                "tab_id": tab_id,
                "label": label,
                "pane_id": pane_id,
                "cwd": (agent or {}).get("cwd", ""),
                "status": status,
                "goal": goal,
                "goal_elapsed": goal_elapsed,
                "footer": footer,
                "ctx": ctx,
            }
        )
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
        f"{'ctx':7} {'held':6} note"
    )
    print("-" * (9 + width + 8 + 9 + 13 + 7 + 6 + 40))
    for row in rows:
        notes = []
        if row["status"] in NEEDS_ATTENTION:
            notes.append(row["status"].upper())
        note = ctx_note(row.get("ctx"), ctx_reset, row["label"])
        if note:
            notes.append(note)
        # The wedge signal: held in `working` past the threshold. Any other
        # status sitting still is correct behaviour and must not be flagged.
        if row["status"] == "working" and (row["secs"] or 0) >= freshness_secs:
            notes.append(f"STALE>{human(freshness_secs)}")
        if row.get("resumed"):
            notes.append("resumed")
        if row.get("changed") and not row.get("resumed"):
            notes.append("changed")
        print(
            f"{row['workspace']:9} {row['label'][:width]:{width}} "
            f"{row['pane_id']:8} {row['status']:9} {(row['goal'] or '-'):13} "
            f"{ctx_label(row.get('ctx')):7} "
            f"{human(row['secs']) + ('' if row.get('secs_source') != 'goal' else '*'):6} "
            f"{' '.join(notes)}"
        )
    no_agent = [r for r in rows if r["status"] == "no-agent"]
    if any(r.get("secs_source") == "goal" for r in rows):
        print("\n* duration is the goal's own reported active time (a lower bound on how long the lane has run),")
        print("  not elapsed-since-first-observation.")
    hot = [r for r in rows if (r.get("ctx") or 0) >= ctx_threshold(r["label"], ctx_reset)]
    if hot:
        print(
            f"\n{len(hot)} lane(s) at or above their context reset threshold: "
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
            "  Act at a stop boundary: have the lane write a continuation prompt, then /compact or /new."
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
            if row["status"] != "no-agent" and row["pane_id"]:
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
