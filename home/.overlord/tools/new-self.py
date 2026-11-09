#!/usr/bin/env python3
"""new-self — start a fresh session in this lane, deferred until the turn returns.

Why this exists: the hourly self-wake prompt accumulates in a long-lived session.
After a night of "nothing outstanding" wakes, the session carries every wake
prompt plus every check, and each new wake pays for all of it. `/new` starts a
clean session in place (`runtimeHost.newSession()`), keeping the process, the
mode/profile composition, and the lane identity — so the cost of an idle hour
stops compounding.

Why deferred: this agent cannot send `/new` to its own pane inline. During the
turn the pane reports `working`, and typing into a working lane disturbs it —
the 2026-11-06 incident lost the operator's composer draft exactly that way.
So the helper detaches (own session, own process group) and waits for idle.

Why keystrokes and not `herdr agent prompt`: `agent prompt` cannot deliver a
slash command — the leading `/` opens the TUI palette and the text is submitted
again as a user message. `send_slash` in broadcast-to-fleet.py drives the real
palette and is reused here rather than reimplemented.

Why the composer guard: `/new` sends `ctrl+u` to clear the input line first, so
firing it while the operator is typing would discard their draft. A non-blank
input box means "not now": refuse, log, exit 0. A refused reset is a healthy
reset, not a failure — the next wake tries again.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
STATE = pathlib.Path(
    os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state")
) / "overlord"
LOG = STATE / "new-self.log"
CONFIRM = "New session started"  # pi's handleClearCommand success line
DEFAULT_IDLE_TIMEOUT = 3600.0
POLL = 1.0
# Confirming a reset cannot use the screen: `/new` CLEARS the chat container, so the
# marker count does not grow (measured: it stays 1) and the start-of-session banner
# replaces the old one. What does change, and change durably, is the session identity:
# session-tracker.ts writes ~/.local/state/pil/sessions/<lane>.json on every session
# switch. Measured lag on a live lane: 11s, so confirm by polling identity, not pixels.
SESSIONS_DIR = pathlib.Path(
    os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state")
) / "pil" / "sessions"
VERIFY_DEADLINE = 45.0
VERIFY_INTERVAL = 1.0

# The proven primitives (palette driving, status reads) live in the fleet
# broadcast tool; import it by path so the hyphenated filename works and the
# logic is shared rather than copied.
_spec = importlib.util.spec_from_file_location(
    "broadcast_to_fleet", HERE / "broadcast-to-fleet.py"
)
btf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(btf)  # type: ignore[union-attr]


def say(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}"
    print(line, flush=True)
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def write_result(path: str | None, state: str, pane: str, **extra: str) -> None:
    if not path:
        return
    target = pathlib.Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {"state": state, "pane": pane, "updatedAt": time.time(), **extra}
    temporary = target.with_name(f".{target.name}.tmp.{os.getpid()}")
    temporary.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(target)


# A line inside the input box border that holds any non-blank character.
DRAFT_LINE = re.compile(r"^│[^│]*[^ │][^│]*│$")


def composer_holds_draft(pane: str) -> bool:
    """True when someone is typing in the pane's composer (operator or agent)."""
    rc, out = btf.run(
        [btf.HERDR, "pane", "read", pane, "--source", "visible", "--lines", "14"],
        10.0,
    )
    if not rc:
        # Unreadable pane: fail closed. A missed reset costs one wake; a wiped
        # draft costs the operator their message.
        return True
    inside = False
    for line in out.splitlines():
        if "╭" in line:
            inside = True
            continue
        if "╰" in line:
            inside = False
            continue
        if inside and DRAFT_LINE.match(line):
            return True
    return False


def marker_count(pane: str) -> int:
    """How many confirmation lines the pane's scrollback holds; -1 if unreadable."""
    rc, out = btf.run(
        [btf.HERDR, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "200"],
        10.0,
    )
    return out.count(CONFIRM) if rc else -1


def session_identity(pane: str) -> str:
    """The pane's current session id, from the durable record session-tracker writes.

    The record is keyed by lane name, which this tool cannot know for an arbitrary
    pane, so the newest record whose `paneId` matches wins. Falls back to herdr's own
    view (which lags further, ~60s) and finally to "unknown".
    """
    best: tuple[float, str] | None = None
    try:
        for path in SESSIONS_DIR.glob("*.json"):
            try:
                rec = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(rec, dict) or rec.get("paneId") != pane:
                continue
            ident = rec.get("sessionId") or rec.get("session")
            if not isinstance(ident, str) or not ident:
                continue
            try:
                stamp = path.stat().st_mtime
            except OSError:
                stamp = 0.0
            if best is None or stamp > best[0]:
                best = (stamp, ident)
    except OSError:
        pass
    if best:
        return best[1]
    rc, out = btf.run([btf.HERDR, "agent", "get", pane], 10.0)
    if rc:
        try:
            value = json.loads(out)["result"]["agent"]["agent_session"]["value"]
            if isinstance(value, str) and value:
                return value
        except (json.JSONDecodeError, KeyError, TypeError):
            pass
    return "unknown"


def wait_idle(pane: str, timeout: float) -> str | None:
    """Return the status once idle, or None on absent/timeout."""
    deadline = time.time() + timeout
    while True:
        status = btf.status_of(pane, btf.DEFAULT_TIMEOUT)
        if status == "idle":
            return status
        if status in ("", "absent", "unknown"):
            # Unknown is not idle: a failed read must never be read as ready.
            return None
        if time.time() >= deadline:
            return None
        time.sleep(POLL)


def reset(pane: str, timeout: float, result_path: str | None = None) -> int:
    write_result(result_path, "waiting", pane)
    if wait_idle(pane, timeout) is None:
        say(f"skip {pane}: not idle within {timeout:g}s")
        write_result(result_path, "failed", pane, error="not idle before timeout")
        return 1

    # Checked twice on purpose: once now to avoid a pointless wait, and again
    # after the last status read, because a draft can appear in the interval.
    if composer_holds_draft(pane):
        say(f"skip {pane}: composer holds a draft")
        write_result(result_path, "refused", pane, error="composer holds a draft")
        return 0

    before = session_identity(pane)
    write_result(result_path, "sending", pane, before=before)
    # confirm=None: send_slash's tail-only palette confirmation does not apply here —
    # `/new` clears the chat, so the marker never accumulates. Identity is verified below.
    sent, err, _ = btf.send_slash(pane, "/new", btf.DEFAULT_TIMEOUT, None)
    if not sent:
        say(f"failed {pane}: {err}")
        write_result(result_path, "failed", pane, error=err)
        return 1

    deadline = time.time() + VERIFY_DEADLINE
    while True:
        now = session_identity(pane)
        if now not in ("unknown", before):
            say(f"reset {pane}: session {before} -> {now}")
            write_result(result_path, "confirmed", pane, before=before, after=now)
            return 0
        if time.time() >= deadline:
            break
        time.sleep(VERIFY_INTERVAL)

    # A miss does not prove the reset did not happen. The screen still carries the
    # command's own line, so say which evidence was missing rather than guessing.
    marks = marker_count(pane)
    say(f"sent /new to {pane}: session id unchanged after {VERIFY_DEADLINE:g}s "
        f"(pane shows {marks} session-start marker(s))")
    write_result(result_path, "unconfirmed", pane, before=before, markers=str(marks))
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="new-self",
        description="Start a fresh session in a lane once its turn has finished.",
    )
    parser.add_argument(
        "--pane",
        default=os.environ.get("HERDR_PANE_ID"),
        help="target pane (default: this lane's HERDR_PANE_ID)",
    )
    parser.add_argument(
        "--idle-timeout",
        type=float,
        default=DEFAULT_IDLE_TIMEOUT,
        help=f"seconds to wait for the pane to go idle (default {DEFAULT_IDLE_TIMEOUT:g})",
    )
    parser.add_argument(
        "--foreground",
        action="store_true",
        help="run in this process instead of detaching (tests and debugging)",
    )
    parser.add_argument("--result", help="write run outcome JSON here")
    args = parser.parse_args()

    if not args.pane:
        print("new-self: no pane given and HERDR_PANE_ID is unset", file=sys.stderr)
        return 2

    if args.foreground:
        return reset(args.pane, args.idle_timeout, args.result)

    # Defense in depth: the child exists to run `reset()`, so it MUST be started
    # with --foreground. Omitting that makes the child re-enter this same branch
    # and re-arm itself — the defect that produced the 2026-11-07 self-spawning
    # chain (~250 processes/s, 5.1k log lines before it was cut at the source by
    # renaming this file). The env marker below fails closed if a future edit
    # ever drops --foreground from the command.
    if os.environ.get("NEW_SELF_DETACHED"):
        print(
            "new-self: recursion guard: NEW_SELF_DETACHED is already set and"
            " --foreground was not given — refusing to re-detach",
            file=sys.stderr,
        )
        return 2

    # Detach: this process is a child of the agent, so it dies with the turn
    # unless it owns its own session.
    command = [
        sys.executable,
        str(pathlib.Path(__file__).resolve()),
        "--pane",
        args.pane,
        "--idle-timeout",
        str(args.idle_timeout),
        "--foreground",
    ]
    if args.result:
        command += ["--result", args.result]
    subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
        env={**os.environ, "NEW_SELF_DETACHED": "1"},
    )
    say(f"armed: /new for {args.pane} when its turn ends")
    return 0


if __name__ == "__main__":
    sys.exit(main())
