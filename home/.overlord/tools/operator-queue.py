#!/usr/bin/env python3
"""Report the operator's TRUE backlog: the union of both delivery channels.

WHY THIS EXISTS
---------------
Two independent channels carry work that only the operator can resolve, and each one is
individually incomplete:

  * beads — a bead carrying a `human` gate is out of `bd ready` (correct) but is only
    discoverable by asking bd.
  * unblock asks — and this is the one that misleads. `unblock list` filters out any ask
    with `weekly_at` set (`bin/unblock.js:148`), and the daemon sets `weekly_at` on every
    open ask older than 72h (`src/daemon.js:385,1441`). Nothing clears it — `keep` sets
    `kept_at`, a column no reader filters on. So `unblock list` returning "Nothing is
    waiting on you" CANNOT DISTINGUISH an empty queue from a hidden one, for anything older
    than three days.

Measured 2026-11-04: 19 open asks, 18 hidden by `weekly_at`, 1 visible. Among the hidden
were three leaked-credential rotations, the oldest 18 days old. Every lane that reported
"my space is clean" had read that broken signal — and one of them was right only by luck.

So: never read either source alone, and never read `unblock list` as a verdict. This tool
reads the database directly for the asks and shells out to bd for the gates.

Usage:
    tools/operator-queue.py            # both channels, union
    tools/operator-queue.py --json
    tools/operator-queue.py --asks     # asks only, including hidden
Exit: 0 always (this reports; it does not gate). Non-zero only on a read failure.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

ASK_DB = os.path.expanduser("~/.local/state/unblock/queue.db")


def _age(ms: int | None) -> str:
    if not ms:
        return "-"
    secs = max(0, time.time() - ms / 1000)
    d, rem = divmod(int(secs), 86400)
    h = rem // 3600
    return f"{d}d" if d else f"{h}h"


def _when(ms: int | None) -> str:
    if not ms:
        return "-"
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%m-%d %H:%M")


def read_asks() -> list[dict]:
    """Every open ask, with its visibility and the reason it is hidden.

    Read-only and direct: the CLI is the thing being worked around, so asking it would
    reproduce the bug this tool exists to expose.
    """
    if not os.path.exists(ASK_DB):
        raise RuntimeError(f"asks database is missing: {ASK_DB}")
    con = sqlite3.connect(f"file:{ASK_DB}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        cur.execute(
            """SELECT ticket, project, title, kind, status, created_at,
                      weekly_at, set_aside_at, set_aside_reason, kept_at
                 FROM asks WHERE status = 'open' ORDER BY created_at"""
        )
        out = []
        for (tk, proj, title, kind, status, created,
             weekly, aside, aside_reason, kept) in cur.fetchall():
            hidden_by = "weekly_at" if weekly else ("set_aside_at" if aside else None)
            out.append({
                "ticket": tk, "project": proj or "-", "title": title or "",
                "kind": kind or "-", "age": _age(created), "created": _when(created),
                "visible": hidden_by is None, "hidden_by": hidden_by,
                "weekly_at": _when(weekly), "aside_reason": aside_reason,
                "kept_at": _when(kept),
            })
        return out
    finally:
        con.close()


def read_gates() -> list[dict]:
    """Open gates, paired with the bead each one blocks.

    `bd gate list` prints the gate ids; `bd show` on each gives the blocked bead. Parsed
    from text because bd's JSON shape for gates is not stable enough to rely on here.
    """
    try:
        result = subprocess.run(["bd", "gate", "list"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"bd gate list failed: {exc}") from exc
    if result.returncode != 0:
        raise RuntimeError(f"bd gate list failed ({result.returncode}): {result.stderr.strip()}")
    listed = result.stdout
    ids = []
    for line in listed.splitlines():
        line = line.strip()
        if line.startswith("○ ") or line.startswith("◐ "):
            ids.append(line[2:].split()[0])
    out = []
    for gid in ids:
        blocked, reason = [], ""
        try:
            result = subprocess.run(["bd", "show", gid], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f"bd show {gid} failed: {exc}") from exc
        if result.returncode != 0:
            raise RuntimeError(f"bd show {gid} failed ({result.returncode}): {result.stderr.strip()}")
        shown = result.stdout
        for line in shown.splitlines():
            s = line.strip()
            # `bd show <gate>` renders a BLOCKS section whose entries look like
            #   ← ○ swarm-l7o.6: Operator decision: ...
            # There is no "Blocks:" key, which is what an earlier version of this parser
            # looked for, so it reported "blocks ?" for every gate while appearing to work.
            if s.startswith("←"):
                rest = s.lstrip("← ").lstrip("○◐●✓❄ ").strip()
                bid = rest.split("[")[0].split(" ")[0].rstrip(":")
                if bid and bid not in blocked:
                    blocked.append(bid)
            elif s.lower().startswith("reason:"):
                reason = s.split(":", 1)[-1].strip()[:110]
        out.append({"gate": gid, "blocks": blocked, "reason": reason})
    return out


def main() -> int:
    as_json = "--json" in sys.argv
    asks_only = "--asks" in sys.argv

    try:
        asks = read_asks()
        gates = [] if asks_only else read_gates()
    except (OSError, sqlite3.Error, RuntimeError) as exc:
        print(f"operator-queue: READ FAILED: {exc}", file=sys.stderr)
        return 2
    visible = [a for a in asks if a["visible"]]
    hidden = [a for a in asks if not a["visible"]]

    if as_json:
        print(json.dumps({
            "asks": {"open": len(asks), "visible": len(visible), "hidden": len(hidden)},
            "gates": len(gates),
            "ask_rows": asks, "gate_rows": gates,
            "note": "union of two channels; neither alone is complete",
        }, indent=2))
        return 0

    print("OPERATOR QUEUE — union of both channels\n")
    print(f"asks   open={len(asks):<3} visible={len(visible):<3} hidden={len(hidden)}")
    print(f"gates  open={len(gates)}\n")

    if hidden:
        print(f"HIDDEN ASKS ({len(hidden)}) — invisible to `unblock list`, all still open:")
        print(f"  {'ticket':12}{'project':22}{'age':5}{'hidden_by':13}{'since':12}title")
        for a in sorted(hidden, key=lambda x: x["created"]):
            print(f"  {a['ticket']:12}{a['project'][:20]:22}{a['age']:5}"
                  f"{str(a['hidden_by']):13}{a['weekly_at']:12}{a['title'][:56]}")
        print()

    if visible:
        print(f"VISIBLE ASKS ({len(visible)}):")
        for a in visible:
            print(f"  {a['ticket']:12}{a['project'][:20]:22}{a['age']:5}{a['title'][:56]}")
        print()

    if gates:
        print(f"OPEN HUMAN GATES ({len(gates)}) — beads held out of bd ready:")
        for g in gates:
            print(f"  {g['gate']:14}blocks {', '.join(g['blocks']) or '?':34}{g['reason'][:70]}")

    if not hidden and not visible and not gates:
        print("Nothing waiting on the operator in either channel. This is now a real empty queue:")
        print("the asks were read from the database, not from `unblock list`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
