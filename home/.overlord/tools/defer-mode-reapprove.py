#!/usr/bin/env python3
"""defer-mode-reapprove — re-approve a lane's mode definitions once it goes idle.

Why this exists
---------------
A lane that edits a mode file it composes changes that definition's digest. Its own session still
records the OLD fingerprint, and `pi-modes` defaults to `driftPolicy: block`, so on the next read
the composition is dropped until the lane re-approves. The re-approval is `/mode-reapprove`, a
slash command that must run *inside* the lane.

Two constraints make that a deferred job:

* The coordinating lane is `working` for the whole turn that would report the result, and
  prompting a working lane aborts that turn. So the command waits for idle.
* A slash command CANNOT go through `herdr agent prompt`: the leading `/` opens the TUI command
  palette, the text lands in the palette filter, and it is then submitted as a user message. It
  must be delivered with `herdr agent send-keys`.

What this tool does NOT do any more: re-approve on its own
----------------------------------------------------------
This tool used to type `/mode-reapprove --confirm-project` itself — a digest-less command built
from a literal string, sent with keystrokes it assembled by hand. That is the FT-40 gap (the
approval is then not pinned to any definition, so a file that moves between the read and the
command is blessed by timing) and it duplicated machinery `reconcile-mode.py` already has.

So the wait is this tool's, and the reconciliation is `reconcile-mode.py`'s:

  * the digest is asked of the `pi-modes` CLI (`expected`), never computed here — the fingerprint
    covers `scope` and `path`, so the same mode TEXT at an instance copy hashes differently from
    the real agent dir;
  * the command sent is `/mode-reapprove --expect <digest> --confirm-project`, so pi-modes' own
    gate refuses a definition that moved mid-flight;
  * keystrokes come from `reconcile-mode.py`'s `type_keys`, which maps " " to the `space` token
    that `send-keys` actually honors (a literal " " argument is silently dropped);
  * success is the lane's RECORDED digest equalling the expected one, not a keystroke or a pane
    line.

Proof is therefore the delegated run's own row, which this tool quotes into its result file.

Usage
  defer-mode-reapprove.py --pane w1K:p1 [--timeout 86400] [--result PATH]
  defer-mode-reapprove.py --pane w1K:p1 --status        # read the durable result
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys
import time
from pathlib import Path

RESULT_DIR = Path(os.path.expanduser("~/.local/state/pil/mode-reapprove-results"))
HERDR = os.environ.get("HERDR_BIN_PATH") or "herdr"
RECONCILE = Path(__file__).resolve().with_name("reconcile-mode.py")
IDLE_STATES = {"idle", "done"}
WAITING_TEXT = "waiting for idle"


def herdr(*args: str, timeout: float = 20.0) -> str:
    try:
        out = subprocess.run([HERDR, *args], capture_output=True, text=True, timeout=timeout)
        return out.stdout
    except Exception:
        return ""


def agent_status(pane: str) -> str:
    raw = herdr("agent", "get", pane)
    try:
        return ((json.loads(raw).get("result") or {}).get("agent") or {}).get("agent_status", "")
    except Exception:
        return ""


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_result(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=1) + "\n")
    tmp.replace(path)


def reconcile(pane: str) -> tuple[int, dict | None, str]:
    """Run the sibling tool for one pane and return (exit code, its row, raw output)."""
    if not RECONCILE.exists():
        return 1, None, f"missing {RECONCILE}"
    try:
        out = subprocess.run(
            [sys.executable, str(RECONCILE), "--only", pane, "--json"],
            capture_output=True, text=True, timeout=600,
        )
    except Exception as exc:  # noqa: BLE001
        return 1, None, f"reconcile-mode could not run: {exc}"
    raw = (out.stdout or "").strip()
    rows: list[dict] = []
    try:
        rows = json.loads(raw) or []
    except json.JSONDecodeError:
        return out.returncode, None, raw or (out.stderr or "").strip()
    row = next((r for r in rows if r.get("pane") == pane), rows[0] if rows else None)
    return out.returncode, row, raw


def run(pane: str, timeout: float, result_path: Path) -> int:
    started = time.monotonic()
    write_result(result_path, {"pane": pane, "phase": WAITING_TEXT, "at": now(), "result": None})
    deadline = started + timeout
    while True:
        if agent_status(pane) in IDLE_STATES:
            break
        if time.monotonic() >= deadline:
            write_result(result_path, {"pane": pane, "phase": "timeout", "at": now(),
                                       "result": None, "note": f"still not idle after {timeout:.0f}s"})
            print(f"deferred mode-reapprove timed out waiting for idle: {pane}", file=sys.stderr)
            return 1
        time.sleep(2)

    code, row, raw = reconcile(pane)
    # The idle check races the lane: it can be observed idle and start a turn before the
    # reconcile lands, in which case reconcile -- correctly -- refuses to prompt a working lane
    # and this tool used to record `unverified` and exit. Measured 2026-11-08 on w1K:p1, whose
    # own re-approval fired, raced this lane's turn, and left the lane drifted while reporting a
    # result. So a working-skip is a retry, not an outcome: go back to waiting, bounded by the
    # same timeout.
    while row and "never prompt a working lane" in str(row.get("note") or ""):
        if time.monotonic() >= deadline:
            write_result(result_path, {"pane": pane, "phase": "timeout", "at": now(),
                                       "result": None,
                                       "note": "still working when re-approval was attempted"})
            print(f"deferred mode-reapprove timed out: {pane} kept working", file=sys.stderr)
            return 1
        time.sleep(2)
        while agent_status(pane) not in IDLE_STATES:
            if time.monotonic() >= deadline:
                break
            time.sleep(2)
        code, row, raw = reconcile(pane)
    verified = bool(row and row.get("verified"))
    # A lane that already recorded the expected digest needs nothing; that is success too.
    already = bool(row and row.get("note") == "already recorded the expected digest")
    payload = {
        "pane": pane,
        "phase": "verified" if (verified or already) else "unverified",
        "at": now(),
        "waited_seconds": round(time.monotonic() - started, 1),
        "result": (row or {}).get("note") or (row or {}).get("before"),
        "verified": verified,
        "already_current": already,
        "reconcile": row,
        "reconcile_exit": code,
        "raw": raw,
    }
    write_result(result_path, payload)
    if verified or already:
        print(f"mode-reapprove VERIFIED for {pane}: "
              f"{'already current' if already else row.get('after') or row.get('note')}")
        return 0
    print(f"mode-reapprove NOT verified for {pane}: "
          f"{(row or {}).get('note') or raw or 'no row'}", file=sys.stderr)
    return 1


def show_status(pane: str, result_path: Path) -> int:
    if not result_path.exists():
        print(f"no result recorded for {pane} at {result_path}")
        return 1
    print(result_path.read_text().strip())
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--pane", required=True)
    p.add_argument("--timeout", type=float, default=24 * 3600.0)
    p.add_argument("--result")
    p.add_argument("--status", action="store_true", help="print the durable result and exit")
    p.add_argument("--detach", action="store_true", help="internal: run detached")
    args = p.parse_args()

    result_path = (Path(args.result) if args.result
                   else RESULT_DIR / f"{args.pane.replace(':', '-')}.json")

    if args.status:
        return show_status(args.pane, result_path)

    if args.detach:
        return run(args.pane, args.timeout, result_path)

    # Spawn detached so the caller's turn can end.
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--pane", args.pane,
         "--timeout", str(args.timeout), "--result", str(result_path), "--detach"],
        start_new_session=True, close_fds=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    print(f"deferred mode-reapprove armed for {args.pane} -> {result_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
