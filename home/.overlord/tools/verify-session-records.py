#!/usr/bin/env python3
"""Verify every live pi lane has its session identity recorded on disk.

Why this exists
---------------
`pil` resumes a lane from `~/.local/state/pil/sessions/<lane>.path`, and an operator or
script reaches a lane's terminal through the recorded pane id. Both are written by the
`session-tracker` pi extension. A lane that never loaded that extension — or that was
relaunched by an older code path — has NO record, and the failure is silent: `pil` then
starts a fresh session and the lane looks fine while having lost its history.

This tool is the check that makes that silence visible.

What it compares
----------------
  live lane (from /proc: PI_ROOMS_NAME + HERDR_PANE_ID)
    vs  <lane>.json / <lane>.path on disk
    vs  herdr's own `agent_session` pin

Classes
-------
  OK         record present, session matches herdr, pane matches the live process
  MISSING    a pi lane is running with no record at all            (needs /reload)
  NO-PANE    record exists but carries no pane id                  (old record format)
  PANE-DRIFT record's pane id differs from the live process        (pane re-keyed)
  SESSION-DRIFT record's session differs from herdr's pin          (herdr pin stale/behind)
  ORPHAN     record whose lane has no live pi process              (informational)

Exit code: 0 when every live lane is OK, 1 otherwise.

Repair
------
  --repair  backfill records from live truth instead of waiting for each lane to take a
            turn (the extension only records on session_start/agent_start, so an idle
            lane keeps an old path-only record indefinitely).

            Session source, in order of trust:
              1. an existing <lane>.path   — written by the extension, authoritative
              2. herdr's agent_session pin — only when no record exists, and only if the
                 file it names really exists. Such records are stamped
                 "source": "backfill:herdr-pin" so a derived record is never mistaken
                 for an observed one.
            Pane id always comes from /proc (the live process), never from herdr.
            A second run of the tool therefore goes green without guessing.

Usage
-----
  tools/verify-session-records.py [--json] [--quiet] [--repair]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

STATE_DIR = Path(
    os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))
) / "pil" / "sessions"


def _read_env(pid: int) -> dict[str, str]:
    """Read a process environment. Returns {} when unreadable (other user, races)."""
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return {}
    out: dict[str, str] = {}
    for chunk in raw.split(b"\0"):
        if not chunk or b"=" not in chunk:
            continue
        k, v = chunk.split(b"=", 1)
        out[k.decode("utf-8", "replace")] = v.decode("utf-8", "replace")
    return out


def live_lanes() -> dict[str, dict[str, str]]:
    """Map lane name -> {paneId, workspaceId, tabId, pid} for running pi processes."""
    lanes: dict[str, dict[str, str]] = {}
    try:
        pids = [int(p.name) for p in Path("/proc").iterdir() if p.name.isdigit()]
    except OSError:
        return lanes
    for pid in pids:
        try:
            comm = Path(f"/proc/{pid}/comm").read_text().strip()
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if comm != "pi":
            continue
        env = _read_env(pid)
        name = env.get("PI_ROOMS_NAME") or ""
        if not name:
            continue
        lanes[name] = {
            "paneId": env.get("HERDR_PANE_ID", ""),
            "workspaceId": env.get("HERDR_WORKSPACE_ID", ""),
            "tabId": env.get("HERDR_TAB_ID", ""),
            "pid": str(pid),
            "mode": env.get("PI_MODE", ""),
        }
    return lanes


def herdr_pin(lane: str) -> str:
    """herdr's own idea of the lane's session file (may be stale; used for comparison)."""
    try:
        r = subprocess.run(
            ["herdr", "agent", "get", lane], capture_output=True, text=True, timeout=15
        )
        agent = json.loads(r.stdout)["result"]["agent"]
        return ((agent.get("agent_session") or {}).get("value") or "")
    except Exception:
        return ""


def load_record(lane: str) -> dict | None:
    f = STATE_DIR / f"{lane}.json"
    if f.exists():
        try:
            return json.loads(f.read_text())
        except Exception:
            return {"_corrupt": True}
    # Older records are path-only; treat as a partial record so the lane is not MISSING.
    p = STATE_DIR / f"{lane}.path"
    if p.exists():
        return {"session": p.read_text().strip(), "paneId": None, "_pathOnly": True}
    return None


def classify() -> list[dict]:
    live = live_lanes()
    rows: list[dict] = []

    for lane, info in sorted(live.items()):
        rec = load_record(lane)
        pin = herdr_pin(lane)
        row = {"lane": lane, "livePane": info["paneId"], "pid": info["pid"]}

        if rec is None:
            row.update(cls="MISSING", detail="no record; lane has not loaded session-tracker")
        elif rec.get("_corrupt"):
            row.update(cls="MISSING", detail="record file is unreadable JSON")
        else:
            rp = rec.get("paneId")
            rs = rec.get("session") or ""
            row.update(recSession=rs, recPane=rp)
            if not rp:
                row.update(cls="NO-PANE", detail="record has no pane id (old format)")
            elif info["paneId"] and rp != info["paneId"]:
                row.update(cls="PANE-DRIFT", detail=f"record {rp} != live {info['paneId']}")
            elif not rs or not Path(rs).exists():
                row.update(cls="SESSION-DRIFT", detail="recorded session file does not exist")
            elif pin and rs and rs != pin:
                row.update(cls="SESSION-DRIFT", detail="record differs from herdr pin")
            else:
                row.update(cls="OK", detail="")
        rows.append(row)

    # Records with no live process: not a failure, but worth listing so a stale name
    # does not masquerade as a working lane.
    for f in sorted(STATE_DIR.glob("*.json")) + sorted(STATE_DIR.glob("*.path")):
        lane = f.stem
        if lane in live:
            continue
        if any(r["lane"] == lane for r in rows):
            continue
        rec = load_record(lane) or {}
        rows.append(
            {
                "lane": lane,
                "cls": "ORPHAN",
                "detail": "record present, no live pi process",
                "recSession": rec.get("session", ""),
            }
        )
        # collapse the .json/.path pair
        if f.suffix == ".json":
            rows = [r for r in rows if not (r["lane"] == lane and r["cls"] == "ORPHAN")]
            rows.append(
                {
                    "lane": lane,
                    "cls": "ORPHAN",
                    "detail": "record present, no live pi process",
                    "recSession": rec.get("session", ""),
                }
            )
    return rows


def repair() -> list[str]:
    """Backfill missing/partial records from live truth. Returns a list of lane names written."""
    live = live_lanes()
    written: list[str] = []
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    for lane, info in sorted(live.items()):
        rec = load_record(lane)
        source = None
        session = ""

        if rec and not rec.get("_corrupt"):
            session = rec.get("session") or ""
            if rec.get("paneId") and session and Path(session).exists():
                continue  # already complete and sound; leave the extension's record alone
            source = rec.get("source") or "extension"

        # A recorded session that no longer exists is worse than none: it sends `pil` to a
        # path pi treats as "new session, keep this path" — a silent fresh start. So a
        # dangling record falls through to the herdr pin below.
        if not session or not Path(session).exists():
            pin = herdr_pin(lane)
            if pin and Path(pin).exists():
                session = pin
                source = "backfill:herdr-pin"
            else:
                continue

        if not session:
            continue

        base = Path(session).name
        sid = base.split("_", 1)[1].removesuffix(".jsonl") if "_" in base else None
        out = {
            "lane": lane,
            "session": session,
            "sessionId": sid,
            "paneId": info["paneId"] or None,
            "workspaceId": info["workspaceId"] or None,
            "tabId": info["tabId"] or None,
            "hostname": os.uname().nodename,
            "pid": int(info["pid"]),
            "updatedAt": __import__("datetime").datetime.now().astimezone().isoformat(),
            "source": source,
        }
        (STATE_DIR / f"{lane}.json").write_text(json.dumps(out, indent=2) + "\n")
        (STATE_DIR / f"{lane}.path").write_text(session + "\n")
        written.append(lane)
    return written


def main() -> int:
    as_json = "--json" in sys.argv
    quiet = "--quiet" in sys.argv

    if "--repair" in sys.argv:
        for lane in repair():
            print(f"repaired {lane}")
        print()
    if not STATE_DIR.exists():
        print(f"state dir missing: {STATE_DIR}", file=sys.stderr)
        if not as_json:
            print("no lane records exist at all")
        return 1

    rows = classify()
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["cls"]] = counts.get(r["cls"], 0) + 1

    if as_json:
        print(json.dumps({"stateDir": str(STATE_DIR), "counts": counts, "rows": rows}, indent=2))
    else:
        order = ["MISSING", "NO-PANE", "PANE-DRIFT", "SESSION-DRIFT", "OK", "ORPHAN"]
        rows.sort(key=lambda r: (order.index(r["cls"]) if r["cls"] in order else 99, r["lane"]))
        if not quiet:
            print(f"state dir: {STATE_DIR}")
            print()
        for r in rows:
            if quiet and r["cls"] in ("OK", "ORPHAN"):
                continue
            line = f"{r['cls']:<13} {r['lane']:<24}"
            if r.get("livePane"):
                line += f" pane={r['livePane']:<9}"
            if r.get("detail"):
                line += f" {r['detail']}"
            print(line)
        print()
        summary = "  ".join(f"{k}={counts.get(k, 0)}" for k in ["OK", "MISSING", "NO-PANE", "PANE-DRIFT", "SESSION-DRIFT", "ORPHAN"])
        print(f"--- {summary} ---")

    failing = sum(counts.get(k, 0) for k in ("MISSING", "NO-PANE", "PANE-DRIFT", "SESSION-DRIFT"))
    return 0 if failing == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
