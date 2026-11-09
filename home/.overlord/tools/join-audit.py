#!/usr/bin/env python3
"""Audit the bead<->pane join: every bead with join metadata vs live herdr agents."""
import json, subprocess, sys

def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, timeout=60, **kw).stdout

agents = json.loads(sh(["herdr", "agent", "list"]))["result"]["agents"]
by_pane = {}
by_name = {}
for a in agents:
    sess = (a.get("agent_session") or {}).get("value") or ""
    by_pane[a.get("pane_id")] = {"name": a.get("name"), "status": a.get("agent_status"), "session": sess}
    by_name[a.get("name")] = a.get("pane_id")

ids = [i["id"] for i in json.loads(sh(["bd", "list", "--all", "--json", "--has-metadata-key", "agent_pane"]))]
print(f"live agents: {len(agents)}   beads with agent_pane: {len(ids)}\n")
rows = []
for bid in ids:
    raw = sh(["bd", "show", bid, "--json"])
    try:
        d = json.loads(raw)
    except Exception:
        print("UNPARSED", bid); continue
    it = d[0] if isinstance(d, list) and d else d
    md = it.get("metadata") or {}
    pane = md.get("agent_pane")
    sess = md.get("agent_session") or ""
    holder = by_pane.get(pane)
    assignee = it.get("assignee") or ""
    status = it.get("status")
    verdicts = []
    if status == "closed":
        verdicts.append("CLOSED-STALE")
    if holder is None:
        verdicts.append("PANE-NOT-LIVE")
    else:
        if holder["name"] != assignee:
            verdicts.append(f"PANE-HELD-BY-{holder['name']}")
        if sess and holder["session"] and sess != holder["session"]:
            verdicts.append("SESSION-STALE")
    rows.append((bid, status, assignee, pane, (holder or {}).get("name", "-"), ",".join(verdicts) or "ok"))

w = max(len(r[0]) for r in rows) if rows else 8
for r in sorted(rows, key=lambda x: (x[5] == "ok", x[0])):
    print(f"{r[0]:<{w}}  {str(r[1]):<8} {str(r[2])[:26]:<26} pane={str(r[3]):<9} holds={str(r[4]):<26} {r[5]}")
print()
bad = [r for r in rows if r[5] != "ok"]
print(f"beads needing a repair: {len(bad)}")
