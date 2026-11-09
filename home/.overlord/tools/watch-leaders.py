#!/usr/bin/env python3
"""Watch every leader lane and print an event when one needs the overlord.

Why this is not a status poll
-----------------------------
A poll loop that prints on every transition is noise, and noise trains the
operator to ignore the signal. The wake conditions here are deliberately narrow,
because each one means "a lane stopped making progress and nobody is talking to
it" -- which is exactly the case the operator should not have to notice.

Triggers, per lane:

  * transition into `blocked`, or a goal that becomes `blocked`      -> BLOCKED
  * `working` held longer than --stale-after                          -> STALE
  * pane/agent vanished                                               -> GONE
  * goal became `paused` while the lane is not working                -> PAUSED
  * context at or above the reset threshold                           -> CTX-HIGH
  * any other lifecycle transition (informational, one line)          -> state

CTX-HIGH is the one trigger not gated on status. Context pressure is not a
lifecycle state: a lane sitting in `done` at 61% is one tranche from losing the
identifiers that made its work reproducible, and it looks perfectly healthy to
every other signal here. So it fires on the reading alone, and it fires **once
per crossing**, because a metric that re-fires every poll is exactly the noise
that teaches the operator to ignore this stream. The crossing is tracked in a
persisted file (like `resumed_at` on the board) rather than in memory, so
re-arming the watcher does not replay every lane that is already high.

Deliberately NOT a trigger: sitting in `idle`/`done` with an achieved goal, or a
lane that is `working` but under the threshold. An agent at a prompt is waiting
correctly; flagging it manufactures false alarms.

Only stdout is the event stream. Every notable condition, including failures, is
written there so a crash cannot look like silence -- a filter that only matches
success signatures is how a dead watcher reads as a quiet swarm.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BOARD = HERE / "leader-board.py"

# Context-crossing memory lives beside the board's snapshot. Written atomically and
# read defensively: a corrupt file must cost one re-fire, never a dead watcher.
STATE = Path.home() / ".local" / "state" / "overlord" / "watch-leaders.json"

# Fallbacks only. The board publishes its own thresholds in `--json` and those win,
# because two copies of a policy number drift apart and then disagree about which
# lanes need a reset. These keep the watcher working against an older board.
CTX_RESET_DEFAULT = 50.0
CTX_WARN_DEFAULT = 40.0

# A crossing is only a crossing if the lane leaves the band, not merely the
# threshold. Without this, a lane parked at 50.0% that reports 49.9% on the next
# poll fires on every reading -- technically "once per crossing" and useless in
# practice. Five points is narrow enough to still wake on a real climb.
CTX_HYSTERESIS = 5.0


def run_board(*args: str) -> dict | None:
    """Run the board once and return its whole JSON document (not just the lanes).

    The document carries the thresholds as well as the rows, so the watcher and
    the board cannot disagree about where the reset line sits.
    """
    try:
        out = subprocess.run(
            [sys.executable, str(BOARD), "--json", *args],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"WATCHER-ERROR board invocation failed: {exc}", flush=True)
        return None
    if out.returncode != 0:
        print(
            f"WATCHER-ERROR board exited {out.returncode}: {out.stderr.strip()[:300]}",
            flush=True,
        )
        return None
    try:
        doc = json.loads(out.stdout)
    except json.JSONDecodeError as exc:
        print(f"WATCHER-ERROR board output unparsable: {exc}", flush=True)
        return None
    if not isinstance(doc, dict):
        print("WATCHER-ERROR board output was not an object", flush=True)
        return None
    return doc


def load_ctx_state() -> dict:
    """Persisted per-pane context state. Absent or unreadable means "start fresh"."""
    try:
        data = json.loads(STATE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    panes = data.get("panes") if isinstance(data, dict) else None
    return panes if isinstance(panes, dict) else {}


def save_ctx_state(panes: dict) -> None:
    """Write the crossing memory atomically; never let this be why the watcher dies."""
    try:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"written_at": int(time.time()), "panes": panes}, indent=1))
        tmp.replace(STATE)
    except OSError as exc:
        print(f"WATCHER-ERROR could not persist context state: {exc}", flush=True)


def next_ctx_state(value: float, previous: str | None, threshold: float) -> str:
    """Hysteresis wrapper around the threshold: `high` only leaves the band."""
    if value >= threshold:
        return "high"
    if previous == "high" and value >= threshold - CTX_HYSTERESIS:
        return "high"
    return "normal"


def stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main() -> int:
    ap = argparse.ArgumentParser(description="Emit one line per leader-lane event worth waking the overlord.")
    ap.add_argument("--interval", type=int, default=90, help="seconds between polls (default 90)")
    ap.add_argument("--stale-after", type=int, default=45 * 60, help="seconds of held `working` before STALE")
    ap.add_argument(
        "--max-polls",
        type=int,
        default=0,
        help="stop after N polls; 0 means forever (the monitor tool supplies the deadline)",
    )
    args = ap.parse_args()

    prev: dict[str, dict] = {}
    stale_fired: dict[str, int] = {}
    # pane_id -> {"ctx", "state", "at"}; persisted so a re-arm does not replay
    # every lane that was already over the line when this watcher started.
    ctx_state: dict[str, dict] = load_ctx_state()
    polls = 0

    while True:
        doc = run_board()
        polls += 1
        if doc is None:
            # Already reported; keep going so a transient herdr hiccup does not
            # silently end coverage.
            time.sleep(args.interval)
            if args.max_polls and polls >= args.max_polls:
                return 0
            continue

        lanes = doc.get("lanes", [])
        ctx_reset = float(doc.get("ctx_reset", CTX_RESET_DEFAULT) or CTX_RESET_DEFAULT)
        ctx_warn = float(doc.get("ctx_warn", CTX_WARN_DEFAULT) or CTX_WARN_DEFAULT)

        alive = {lane["pane_id"] for lane in lanes if lane.get("pane_id")}

        # Remove vanished panes from the baseline as they are reported. Without this
        # it re-fires every poll, because `prev` still holds the dead pane id and a
        # watcher that repeats one event forever trains you to ignore all of them.
        for pane in [p for p in prev if p and p not in alive]:
            print(f"{stamp()} GONE {pane} {prev[pane]['label']} vanished from the agent list", flush=True)
            del prev[pane]
        # Same reasoning for crossing memory: a recycled pane id must start clean,
        # or its predecessor's `high` suppresses the new lane's first real crossing.
        for pane in [p for p in ctx_state if p not in alive]:
            del ctx_state[pane]

        for lane in lanes:
            pane = lane.get("pane_id") or ""
            key = pane or lane["label"]
            old = prev.get(key)
            status, goal = lane["status"], lane.get("goal")
            label = f"{lane['workspace']}/{lane['label']} ({pane})"

            # Context is checked before, and independently of, the lifecycle diff:
            # it is the one condition that matters at any status, including the
            # `done` lane nobody is going to look at again.
            ctx = lane.get("ctx")
            if isinstance(ctx, (int, float)):
                entry = ctx_state.get(key) or {}
                was = entry.get("state")
                now_state = next_ctx_state(float(ctx), was, ctx_reset)
                if now_state == "high" and was != "high":
                    band = (
                        f"pre-existing, at or above {ctx_reset:.0f}%"
                        if old is None
                        else f"crossed {ctx_reset:.0f}%"
                        + (f" from {entry.get('ctx')}%" if entry.get("ctx") is not None else "")
                    )
                    print(
                        f"{stamp()} CTX-HIGH {label} context {float(ctx):.1f}%"
                        f" ({band}) status={status} goal={goal or 'none'}"
                        " — at a stop boundary have it write a continuation prompt, then"
                        " /compact or /new; this fires once per crossing",
                        flush=True,
                    )
                if now_state != was or entry.get("ctx") != ctx:
                    ctx_state[key] = {"ctx": float(ctx), "state": now_state, "at": int(time.time())}
                    save_ctx_state(ctx_state)
                if now_state == "normal" and float(ctx) >= ctx_warn:
                    # Approaching, not yet actionable. Silent: the board's
                    # `ctx-near` note is the right place for a lane on its way up.
                    pass

            if old is None:
                # First observation: report only that which already needs a human,
                # so a restart does not replay 23 transitions.
                if status == "blocked" or status == "no-agent":
                    print(f"{stamp()} {status.upper()} {label} pre-existing", flush=True)
                elif goal in ("blocked", "paused", "attention"):
                    print(f"{stamp()} GOAL-{goal.upper()} {label} goal={goal}", flush=True)
                prev[key] = lane
                continue

            if status != old["status"]:
                if status == "blocked":
                    print(f"{stamp()} BLOCKED {label} was {old['status']}", flush=True)
                else:
                    print(
                        f"{stamp()} state {label} {old['status']} -> {status}"
                        + (f" goal={goal}" if goal else ""),
                        flush=True,
                    )
            elif goal != old.get("goal") and goal in ("blocked", "paused", "attention"):
                # A goal can stop while the pane itself looks unchanged; the
                # footer is the only place that shows it.
                print(f"{stamp()} GOAL-{goal.upper()} {label} was {old.get('goal') or 'none'}", flush=True)

            # The board already decided which clock is trustworthy and put it in
            # `secs` -- including suppressing a goal clock that spans a pause. Do not
            # re-derive the max here: a second implementation of the same rule drifted
            # from the first and re-alarmed a lane the board had correctly cleared.
            held = lane.get("secs") or 0
            if status == "working" and held >= args.stale_after:
                # Fire once per contiguous working stretch, not every poll.
                if stale_fired.get(key) != lane.get("since"):
                    stale_fired[key] = lane.get("since")
                    print(
                        f"{stamp()} STALE {label} working {(held // 60)}m"
                        f" goal={goal or 'none'}"
                        + (
                            " (from the goal clock, which may include time before"
                            " this watcher started)"
                            if lane.get("secs_source") == "goal"
                            else ""
                        )
                        + " — read the pane, do not assume a wedge",
                        flush=True,
                    )
            elif status != "working":
                stale_fired.pop(key, None)

            # `high` is deliberately not re-armed when the lane drops into the
            # band: leaving it high is what stops the 50.0/49.9 oscillation from
            # re-firing. A real reset drops it below the band and re-arms it.
            prev[key] = lane

        if args.max_polls and polls >= args.max_polls:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
