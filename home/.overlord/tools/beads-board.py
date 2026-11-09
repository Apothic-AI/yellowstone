#!/usr/bin/env python3
"""Portfolio view over the one master beads database.

Beads is the durable cross-space record, owned per space by that space's leader. This tool
READS it and groups by the `project:<space>` label — it never writes. That is the whole point
of one shared database: the portfolio question is a single query, not nineteen.

Usage:
  ./tools/beads-board.py            # per-space summary + findings
  ./tools/beads-board.py --json     # same data, structured
  ./tools/beads-board.py --ready    # append the global ready queue
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys

MASTER = os.path.expanduser("~/.beads")

def bd_json(args: list[str]):
    p = subprocess.run(["bd", "-C", MASTER, *args, "--json"], capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(f"bd {' '.join(args)} failed rc={p.returncode}: {p.stderr.strip()[:400]}\n")
        return None
    try:
        return json.loads(p.stdout or "[]")
    except json.JSONDecodeError:
        sys.stderr.write(f"bd {' '.join(args)} returned unparseable output\n")
        return None

def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only portfolio view over the swarm beads database.")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--ready", action="store_true", help="also print the global ready queue")
    a = ap.parse_args()

    beads = bd_json(["list", "--all"])
    if beads is None:
        return 1

    spaces: dict[str, dict] = {}
    unlabelled: list[dict] = []
    for b in beads:
        labels = b.get("labels") or []
        proj = next((l.split(":", 1)[1] for l in labels if l.startswith("project:")), None)
        if not proj:
            unlabelled.append(b)
            continue
        s = spaces.setdefault(proj, {"space": proj, "epics": [], "counts": {}, "total": 0})
        s["total"] += 1
        s["counts"][b["status"]] = s["counts"].get(b["status"], 0) + 1
        if b["issue_type"] == "epic":
            s["epics"].append({"id": b["id"], "title": b["title"], "status": b["status"]})

    order = ["open", "in_progress", "blocked", "closed", "deferred"]
    if a.json:
        print(json.dumps({"spaces": sorted(spaces.values(), key=lambda x: x["space"]),
                          "unlabelled": [{"id": b["id"], "title": b["title"], "status": b["status"]}
                                          for b in unlabelled]}, indent=1))
        return 0

    print(f"{'space':<10}{'beads':>6}{'open':>6}{'wip':>5}{'blk':>5}{'closed':>8}  epic")
    print("-" * 92)
    for s in sorted(spaces.values(), key=lambda x: x["space"]):
        c = s["counts"]
        epic = s["epics"][0] if s["epics"] else None
        epic_txt = f"{epic['id']} ({epic['status']})" if epic else "— NO EPIC"
        extra = f"  +{len(s['epics'])-1} more epics" if len(s["epics"]) > 1 else ""
        print(f"{s['space']:<10}{s['total']:>6}{c.get('open',0):>6}{c.get('in_progress',0):>5}"
              f"{c.get('blocked',0):>5}{c.get('closed',0):>8}  {epic_txt}{extra}")
    print(f"\n{len(spaces)} space(s) labelled, {len(beads)} beads total")

    findings = []
    if unlabelled:
        findings.append(f"{len(unlabelled)} bead(s) with no project:<space> label: "
                        + ", ".join(f"{b['id']} ({b['status']})" for b in unlabelled[:6]))
    for s in spaces.values():
        if not s["epics"]:
            findings.append(f"{s['space']}: beads but no epic")
        if len(s["epics"]) > 1:
            findings.append(f"{s['space']}: {len(s['epics'])} epics (expected 1)")
    if findings:
        print("\nFINDINGS")
        for f in findings:
            print(f"  ! {f}")

    if a.ready:
        p = subprocess.run(["bd", "-C", MASTER, "ready"], capture_output=True, text=True)
        print("\nREADY (global)")
        print(p.stdout.rstrip()[:4000] or "(nothing ready)")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
