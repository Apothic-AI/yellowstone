#!/usr/bin/env python3
"""Retire a space's w*/ context directory — only after its beads are verified.

Refuses unless the space has, in the master database, an epic and at least one bead carrying
`project:<space>`. Prints what it would remove; `--apply` actually removes. Never touches a
directory whose space id is in SKIP (leaderless, by operator rule).
"""
from __future__ import annotations
import argparse, json, os, shutil, subprocess, sys

MASTER = os.path.expanduser("~/.beads")
ROOT = os.path.expanduser("~/.overlord")
SKIP = {"wG", "w14", "wC", "wV", "w13", "w15", "w1D", "w1F", "w1G"}  # no leader lane: report only

def beads() -> list[dict]:
    p = subprocess.run(["bd", "-C", MASTER, "list", "--all", "--json"], capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"bd list failed: {p.stderr.strip()[:300]}")
    return json.loads(p.stdout or "[]")

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("space", nargs="*", help="space ids to retire (default: all verified)")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    all_beads = beads()
    by_space: dict[str, list[dict]] = {}
    for b in all_beads:
        for l in (b.get("labels") or []):
            if l.startswith("project:"):
                by_space.setdefault(l.split(":", 1)[1], []).append(b)

    dirs = sorted(d for d in os.listdir(ROOT) if d.startswith("w") and os.path.isdir(os.path.join(ROOT, d)))
    targets = a.space or [d.split("-", 1)[0] for d in dirs]
    rc = 0
    for d in dirs:
        ws = d.split("-", 1)[0]
        if ws not in targets:
            continue
        path = os.path.join(ROOT, d)
        if ws in SKIP:
            print(f"{d:<34} SKIP  no leader lane — reported, not converted")
            continue
        bs = by_space.get(ws, [])
        epics = [b for b in bs if b["issue_type"] == "epic"]
        open_ = [b for b in bs if b["status"] != "closed"]
        if not bs or not epics:
            print(f"{d:<34} REFUSE no epic/no beads in swarm (beads={len(bs)}, epics={len(epics)})")
            rc = 1
            continue
        size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(path) for f in fs)
        print(f"{d:<34} OK    epic={epics[0]['id']:<14} beads={len(bs):<3} open={len(open_):<3} {size//1024}KB", end="")
        if a.apply:
            shutil.rmtree(path)
            print("  REMOVED")
        else:
            print()
    if not a.apply:
        print("\n(dry run — pass --apply to remove the OK lines)")
    return rc

if __name__ == "__main__":
    raise SystemExit(main())
