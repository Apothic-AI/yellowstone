#!/usr/bin/env python3
"""bdi-reconcile — keep bead↔lane join metadata true (metadata only).

A bead carries `agent_pane` + `agent_session` so bdi can draw it beside the lane
working it. That join goes stale three ways: `/new` and relaunches change
`agent_session`, a pane gets reused by another lane or dies, and a claim can be
made without writing any join at all. bdi then reports the fault as
`orphan-claim` or `pane-in-another-project` — a lie about who is working what.

This tool rewrites only `agent_pane` and `agent_session`. It never writes status,
assignee or priority: the lane remains the single writer of its own bead.

Rule. A join asserts "this bead belongs to the lane on that pane", so it is kept
only while
  * the bead is not closed,
  * `agent_pane` is a live herdr pane,
  * the agent on that pane is not `no-agent`, and
  * the claimant matches that agent, where the claimant is
      - the bead's `assignee` when it has one (a claimed bead), or
      - the bead's `project:<workspace>` label when it does not (a space epic:
        the epic belongs to a workspace, and the pane must hold an agent whose
        workspace is that one).
Everything else is cleared, including a claim whose assignee is no longer live
and an epic whose pane has been inherited by another workspace. That is the
stale-join sweep: a pane reused by another project must not keep an epic's join.

Usage: bdi-reconcile [--dry-run] [--verbose]
Exit: 0 clean or repaired, 1 a write failed, 2 herdr/bd unavailable.
"""
import json
import os
import subprocess
import sys
import time

BD = os.environ.get("BDI_RECONCILE_BD", "/home/bitnom/.local/bin/bd")
HDRD = os.environ.get("BDI_RECONCILE_HERDR", "herdr")
LOG = os.environ.get("BDI_RECONCILE_LOG", os.path.expanduser("~/.local/state/overlord/bdi-reconcile.log"))
LOCK = os.path.join(os.path.dirname(LOG), "bdi-reconcile.lock")
MAX_LOG = 1 << 20

DRY = "--dry-run" in sys.argv
VERBOSE = "--verbose" in sys.argv or DRY

# The fleet is one Dolt server, one database, one project_id, many spaces. Nothing enforces
# that. A `bd init` in any space writes a NEW metadata.json with a new prefix and a new
# project_id, and because `bd` attaches by walking up to the nearest `.beads`, that space
# silently detaches from the fleet graph: `bd where` still answers, and it vanishes from
# `bd list --all` and from the board. These checks make that visible instead of silent.
SHARED_DATABASE = os.environ.get("BDI_SHARED_DATABASE", "swarm")
SHARED_PROJECT_ID = os.environ.get("BDI_SHARED_PROJECT_ID", "07b8230e-d7cf-4f22-a338-ef727894a4c1")
SPACE_ROOTS = ["~", "~/.overlord", "~/.sysops", "~/Documents", "~/Code"]



def run(args, timeout=60):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return None, f"{args[0]} not found"
    except subprocess.TimeoutExpired:
        return None, f"{args[0]} timed out"
    if p.returncode != 0:
        return None, (p.stderr or p.stdout).strip()[:300]
    return p.stdout, None


def live_panes():
    """pane_id -> {name, session} for every live herdr agent."""
    out, err = run([HDRD, "agent", "list"])
    if out is None:
        return None, err
    try:
        agents = json.loads(out)["result"]["agents"]
    except Exception as e:
        return None, f"herdr output unparsed: {e}"
    panes = {}
    for a in agents:
        pane = a.get("pane_id")
        if not pane:
            continue
        panes[pane] = {
            "name": a.get("name"),
            "status": a.get("agent_status"),
            "workspace": a.get("workspace_id"),
            "session": ((a.get("agent_session") or {}).get("value") or ""),
        }
    return panes, None


def beads_with_join():
    out, err = run([BD, "list", "--all", "--json", "--has-metadata-key", "agent_pane"])
    if out is None:
        # `agent_session` alone is a join too (a claim written before agent_pane existed).
        out, err2 = run([BD, "list", "--all", "--json", "--has-metadata-key", "agent_session"])
        if out is None:
            return None, err
    try:
        data = json.loads(out)
    except Exception as e:
        return None, f"bd output unparsed: {e}"
    items = data if isinstance(data, list) else data.get("issues", [])
    ids = [i["id"] for i in items]
    labels_by_id = {i["id"]: (i.get("labels") or []) for i in items}
    if not ids:
        return [], None
    # The list view omits metadata; the join values need a second read.
    joined = []
    for bid in ids:
        raw, _ = run([BD, "show", bid, "--json"], timeout=30)
        if raw is None:
            continue
        try:
            d = json.loads(raw)
        except Exception:
            continue
        it = d[0] if isinstance(d, list) and d else d
        md = it.get("metadata") or {}
        joined.append({
            "id": it.get("id", bid),
            "status": it.get("status"),
            "assignee": it.get("assignee") or "",
            "labels": labels_by_id.get(it.get("id", bid)) or (it.get("labels") or []),
            "pane": md.get("agent_pane") or "",
            "session": md.get("agent_session") or "",
        })
    return joined, None


def write_metadata(bid, set_kv, unset_keys):
    args = [BD, "update", bid]
    for k, v in set_kv.items():
        args += ["--set-metadata", f"{k}={v}"]
    for k in unset_keys:
        args += ["--unset-metadata", k]
    if len(args) == 3:
        return None
    out, err = run(args, timeout=30)
    return err


def log(line):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        try:
            if os.path.getsize(LOG) > MAX_LOG:
                os.replace(LOG, LOG + ".1")
        except OSError:
            pass
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")
    except OSError:
        pass


def identity_check():
    """Report spaces whose .beads/metadata.json no longer belongs to the fleet tracker.

    Read-only. A space that fails here has detached from the shared graph and must be fixed
    by hand; this function only makes it visible. Returns (checked, findings).
    """
    findings = []
    checked = 0
    seen = set()
    for base in SPACE_ROOTS:
        root = os.path.expanduser(base)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, _files in os.walk(root):
            depth = dirpath[len(root):].count(os.sep)
            if depth > 4:
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames
                           if d not in ("node_modules", ".git", ".jj", "target", "dist",
                                        ".cache", ".local", ".npm", ".pi", ".pi-profile-switch",
                                        "venv", ".venv", "__pycache__")]
            if ".beads" not in dirnames:
                continue
            meta = os.path.join(dirpath, ".beads", "metadata.json")
            if not os.path.isfile(meta) or meta in seen:
                continue
            seen.add(meta)
            checked += 1
            try:
                with open(meta, encoding="utf-8") as fh:
                    d = json.load(fh)
            except (OSError, json.JSONDecodeError) as e:
                findings.append((meta, f"unreadable: {e}"))
                continue
            db = d.get("dolt_database")
            pid = d.get("project_id")
            if db != SHARED_DATABASE or pid != SHARED_PROJECT_ID:
                findings.append(
                    (meta, f"detached: database={db!r} project_id={pid!r} "
                            f"(want {SHARED_DATABASE!r} / {SHARED_PROJECT_ID!r})"))
    return checked, findings


def main():
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    # One run at a time; a stuck run must not stack behind the timer.
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_RDWR, 0o644)
        import fcntl
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("already running", file=sys.stderr)
            return 0
    except OSError:
        pass

    panes, err = live_panes()
    if panes is None:
        print(f"herdr unavailable: {err}", file=sys.stderr)
        log(f"ERROR herdr unavailable: {err}")
        return 2
    beads, err = beads_with_join()
    if beads is None:
        print(f"bd unavailable: {err}", file=sys.stderr)
        log(f"ERROR bd unavailable: {err}")
        return 2

    # Identity sweep: a space whose metadata no longer matches the shared tracker has detached
    # from the fleet graph. Read-only and independent of the join sweep, so a detached space
    # cannot hide behind a clean reconcile.
    spaces_checked, detached = identity_check()
    for meta, why in detached:
        print(f"IDENTITY {meta}: {why}", file=sys.stderr)
        log(f"IDENTITY {meta}: {why}")
    if VERBOSE and not detached:
        print(f"identity: {spaces_checked} space(s), all on {SHARED_DATABASE}")

    changed = 0
    failed = 0
    for b in beads:
        pane = panes.get(b["pane"]) if b["pane"] else None
        epic_ws = next((l.split("project:", 1)[1] for l in b["labels"] if l.startswith("project:")), "")
        if b["assignee"]:
            matched = bool(pane) and pane["name"] == b["assignee"]
        else:
            matched = bool(pane) and bool(epic_ws) and pane["workspace"] == epic_ws
        keep = bool(pane) and b["status"] != "closed" and matched and pane["name"] != "no-agent"
        if keep:
            if b["session"] != pane["session"]:
                if DRY:
                    print(f"would refresh session {b['id']} ({b['assignee']}@{b['pane']})")
                else:
                    e = write_metadata(b["id"], {"agent_session": pane["session"]}, [])
                    if e:
                        failed += 1
                        print(f"WRITE FAILED {b['id']} session: {e}", file=sys.stderr)
                        log(f"ERROR {b['id']} session write failed: {e}")
                    else:
                        changed += 1
                        log(f"refresh {b['id']} session for {b['assignee']}@{b['pane']}")
        else:
            why = ("closed" if b["status"] == "closed" else
                   "pane not live" if not b["pane"] else
                   "no agent on pane" if not pane else
                   "no claimant" if not (b["assignee"] or epic_ws) else
                   "pane held by another lane" if b["assignee"] else
                   "pane in another workspace")
            if DRY:
                print(f"would clear {b['id']} ({b['assignee'] or 'unassigned'}@{b['pane'] or '-'}): {why}")
            else:
                e = write_metadata(b["id"], {}, ["agent_pane", "agent_session"])
                if e:
                    failed += 1
                    print(f"WRITE FAILED {b['id']} clear: {e}", file=sys.stderr)
                    log(f"ERROR {b['id']} clear failed: {e}")
                else:
                    changed += 1
                    log(f"clear {b['id']} ({b['assignee'] or 'unassigned'}@{b['pane'] or '-'}): {why}")
        if VERBOSE and keep:
            print(f"ok {b['id']} ({b['assignee']}@{b['pane']})")

    if changed:
        print(f"reconciled {changed} bead(s) of {len(beads)} carrying a join")
    elif VERBOSE:
        print(f"{len(beads)} bead(s) carrying a join, all correct")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())