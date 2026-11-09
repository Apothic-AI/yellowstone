#!/usr/bin/env python3
"""undo-self — remove this lane's wake turn from its session, deferred until the turn returns.

Replaces the `/new` reset for the common case (operator ruling, 2026-11-09). `/new` paid for
a brand-new session every idle hour to stop wake prompts accumulating. `npm:@henryqw/pi-undo`
gives the same outcome in the SAME session: `/undo` rewinds the context to the latest user
prompt (`navigateTree(target, {summarize:false})`), discarding the wake turn and everything
after it, and keeps the process, the mode/profile composition and the lane identity. Ctrl+C
then clears the composer, where pi restores the rewound prompt for editing (that is the whole
reason the operator asked for the keystroke pair rather than `/undo` alone).

The gate is unchanged and lives in the wake prompt, not here: undo ONLY a session whose only
content is wakes. A session holding any operator prompt, lane message, delegated job or thread
you started is NOT disposable. This tool is the mechanism; the prompt is the decision.

Why deferred: an agent cannot type into its own pane during its turn — the pane reports
`working`, and the keystrokes disturb the live composer (the 2026-11-06 incident lost the
operator's draft exactly that way). So this detaches into its own session and waits for idle.

Why keystrokes and not `herdr agent prompt`: `agent prompt` cannot deliver a slash command —
the leading `/` opens the TUI palette and the text is submitted again as a user message.
`send_slash` in broadcast-to-fleet.py drives the real palette and is reused rather than
reimplemented.

Why the composer guard: Ctrl+C and send_slash's ctrl+u discard whatever is in the input box,
so firing while the operator is typing would eat their draft. A non-blank input box means
"not now": refuse, log, exit 0. A refused undo is a healthy undo — the next wake tries again.

On verification: `/undo` deliberately KEEPS the session id, and the session store is
append-only (a navigation moves the in-memory leaf and appends no record), so there is no
session-id change and no new file entry to key on — the signal new-self.py used does not
exist here. Success is therefore confirmed as "the command ran through the session's own
command path and the composer came back empty", and a run that ends any other way is reported
`sent`, never `confirmed`. Reporting a rewind as verified on weaker evidence is exactly the
failure the fleet keeps re-learning.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import pathlib
import subprocess
import sys
import time


HERE = pathlib.Path(__file__).resolve().parent
STATE = pathlib.Path(
    os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state")
) / "overlord"
LOG = STATE / "undo-self.log"
DEFAULT_IDLE_TIMEOUT = 3600.0
# How long to give /undo's own abort+waitForIdle to settle before Ctrl+C. The command aborts
# the live context and waits for idle internally, so clearing the composer too early can race
# the rewind; this is a bound on a real internal wait, not an arbitrary sleep.
UNDO_SETTLE_TIMEOUT = 120.0


def _load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


# The proven primitives live beside this file. new-self.py owns the composer guard, the idle
# wait and the result writer; reuse them so the two reset paths cannot drift apart. Importing
# it does not run it (it is guarded by __main__), and it in turn imports broadcast-to-fleet.
new_self = _load("overlord_new_self", HERE / "new-self.py")
btf = new_self.btf


def say(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}"
    print(line, flush=True)
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def undo(pane: str, timeout: float, result_path: str | None = None) -> int:
    new_self.write_result(result_path, "waiting", pane)
    if new_self.wait_idle(pane, timeout) is None:
        say(f"skip {pane}: not idle within {timeout:g}s")
        new_self.write_result(result_path, "failed", pane, error="not idle before timeout")
        return 1

    # Checked twice on purpose, as in new-self.py: once now to avoid a pointless wait, and
    # again after the last status read, because a draft can appear in the interval.
    if new_self.composer_holds_draft(pane):
        say(f"skip {pane}: composer holds a draft")
        new_self.write_result(result_path, "refused", pane, error="composer holds a draft")
        return 0

    new_self.write_result(result_path, "sending", pane)
    # confirm=None: /undo prints no completion line, so there is nothing to count. The
    # command's own effect is checked below instead.
    sent, err, _ = btf.send_slash(pane, "/undo", btf.DEFAULT_TIMEOUT, None)
    if not sent:
        say(f"failed {pane}: {err}")
        new_self.write_result(result_path, "failed", pane, error=err)
        return 1

    if new_self.wait_idle(pane, UNDO_SETTLE_TIMEOUT) is None:
        say(f"sent /undo to {pane}: pane did not return to idle; composer left untouched")
        new_self.write_result(result_path, "sent", pane, error="not idle after /undo")
        return 1

    ok, err = btf.run([btf.HERDR, "agent", "send-keys", pane, "ctrl+c"], btf.DEFAULT_TIMEOUT)
    if not ok:
        say(f"sent /undo to {pane}: clearing the composer failed: {err}")
        new_self.write_result(result_path, "sent", pane, error=f"ctrl+c: {err}")
        return 1

    if new_self.composer_holds_draft(pane):
        say(f"sent /undo to {pane}: composer still holds a draft after ctrl+c")
        new_self.write_result(result_path, "sent", pane, error="composer not cleared")
        return 1

    say(f"undid {pane}: /undo ran and the composer is empty")
    new_self.write_result(result_path, "sent", pane)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="undo-self",
        description="Rewind a lane's context to its last user prompt once its turn has finished.",
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
        print("undo-self: no pane given and HERDR_PANE_ID is unset", file=sys.stderr)
        return 2

    if args.foreground:
        return undo(args.pane, args.idle_timeout, args.result)

    # Defense in depth: the child exists to run undo(), so it MUST be started with
    # --foreground. Omitting that makes the child re-enter this same branch and re-arm itself
    # — the defect that produced the 2026-11-07 self-spawning chain in new-self.py
    # (~250 processes/s before it was cut at the source). The env marker fails closed if a
    # future edit ever drops --foreground from the command.
    if os.environ.get("UNDO_SELF_DETACHED"):
        print(
            "undo-self: recursion guard: UNDO_SELF_DETACHED is already set and"
            " --foreground was not given — refusing to re-detach",
            file=sys.stderr,
        )
        return 2

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
        env={**os.environ, "UNDO_SELF_DETACHED": "1"},
    )
    say(f"armed: /undo for {args.pane} when its turn ends")
    return 0


if __name__ == "__main__":
    sys.exit(main())
