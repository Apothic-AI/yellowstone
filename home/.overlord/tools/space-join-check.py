#!/usr/bin/env python3
"""space-join-check — is each space attached to the shared beads database, and how?

Why this exists
---------------
The fleet had no automated check for the space↔database join. Every candidate cited for it was
wrong: `join-audit.py` compares `bd list --has-metadata-key agent_pane` against live herdr agents —
that is bead↔**pane** — and `bd where` prints the local `.beads` path with no `Mode:` line, so it
cannot tell a documented join from a walk-up. Two lanes have now cited the wrong tool for this,
which is why a real one exists.

What it measures, per space
---------------------------
`bd` attaches at runtime by walking up from the cwd to the nearest `.beads/metadata.json`, so that
walk is what this tool reproduces — no `bd` subprocess in the default path, and `--verify` adds a
`bd where` cross-check for the cwds it reports:

  own-join         <cwd>/.beads/metadata.json exists — the documented join
  ancestor:<dir>   attaches to another directory's .beads (for a non-repo space that is the master,
                   `~/.beads`; it works, but the space is not joined the documented way)
  none             no .beads/metadata.json on the walk up — a repo-shaped space stops discovery at
                   its root and sees no tracker at all

It also reads each `metadata.json` and compares it against the majority hash across all spaces:
a deviation means a divergent database or a different `project_id`, i.e. a space whose beads are
invisible to everyone else. And it flags a populated `.beads/embeddeddolt`, which the fleet skill
names as divergent and invisible.

Usage
  space-join-check.py             # table for every herdr workspace
  space-join-check.py --json
  space-join-check.py --verify    # also run `bd where` in each cwd (slow: one bd per space)
Exit: 0 always (this reports; it does not gate). Non-zero only on a live-state read failure.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
from collections import Counter

HERDR = pathlib.Path.home() / ".local" / "bin" / "herdr"
HOME = pathlib.Path.home()


def herdr(*args: str, timeout: float = 30.0) -> dict:
    try:
        out = subprocess.run([str(HERDR), *args], capture_output=True, text=True, timeout=timeout)
        return json.loads(out.stdout)["result"]
    except Exception as error:  # noqa: BLE001
        print(f"cannot read live state ({' '.join(args)}): {error}", file=sys.stderr)
        raise SystemExit(2)


def walk_beads(cwd: pathlib.Path) -> tuple[pathlib.Path | None, pathlib.Path | None]:
    """The .beads bd attaches to, and whether a repository root stopped the walk first.

    Measured 2026-11-08 on this machine: `bd where` in a git repo with no `.beads/` of its own
    returns `Error: No active beads workspace found`, while a non-repo directory resolves to the
    nearest ancestor `.beads`. So discovery stops at a repository root — the walk must model that,
    and the first version of this tool did not: it reported `~/Code/pi-rooms` as attaching to the
    master when `bd where` there errors, a false pass its own `--verify` caught.
    """
    current = cwd
    while True:
        candidate = current / ".beads" / "metadata.json"
        if candidate.is_file():
            return current / ".beads", None
        if (current / ".git").exists():
            return None, current
        if current == current.parent:
            return None, None
        current = current.parent


def read_metadata(beads_dir: pathlib.Path) -> tuple[dict, str]:
    raw = (beads_dir / "metadata.json").read_bytes()
    try:
        return json.loads(raw), hashlib.sha256(raw).hexdigest()
    except json.JSONDecodeError:
        return {}, hashlib.sha256(raw).hexdigest()


def embedded_rows(beads_dir: pathlib.Path) -> int:
    """Files under .beads/embeddeddolt — a populated one is a divergent, invisible database."""
    target = beads_dir / "embeddeddolt"
    if not target.is_dir():
        return 0
    return sum(1 for p in target.rglob("*") if p.is_file())


def bd_where(cwd: pathlib.Path) -> str:
    try:
        out = subprocess.run(["bd", "where"], cwd=str(cwd), capture_output=True, text=True,
                             timeout=60)
        return (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else ""
    except Exception as error:  # noqa: BLE001
        return f"bd where failed: {error}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--verify", action="store_true", help="cross-check with `bd where`")
    args = parser.parse_args()

    workspaces = herdr("workspace", "list").get("workspaces") or []
    agents = herdr("agent", "list").get("agents") or []
    panes = herdr("pane", "list").get("panes") or []

    name_by_pane = {a.get("pane_id"): a.get("name") for a in agents}
    panes_by_ws: dict[str, list[dict]] = {}
    for pane in panes:
        panes_by_ws.setdefault(pane.get("workspace_id") or "", []).append(pane)

    rows: list[dict] = []
    for ws in workspaces:
        wid = ws.get("workspace_id") or ""
        candidates = panes_by_ws.get(wid) or []
        if not candidates:
            continue
        leaders = [p for p in candidates
                   if (name_by_pane.get(p.get("pane_id")) or "").endswith("-leader")]
        pane = (leaders or candidates)[0]
        cwd = pathlib.Path(pane.get("cwd") or pane.get("foreground_cwd") or "")
        if not cwd.is_dir():
            continue
        beads, stopped = walk_beads(cwd)
        row: dict = {
            "workspace": wid,
            "label": ws.get("label") or "",
            "lane": name_by_pane.get(pane.get("pane_id")) or "(no lane)",
            "cwd": str(cwd),
            "attach": "none",
            "beads_dir": "",
            "database": "",
            "project_id": "",
            "sha": "",
            "embedded_files": 0,
            "stopped_at": str(stopped) if stopped else "",
        }
        if beads is not None:
            row["beads_dir"] = str(beads)
            row["attach"] = "own-join" if beads == cwd / ".beads" else f"ancestor:{beads.parent}"
            meta, sha = read_metadata(beads)
            row["sha"] = sha
            row["database"] = meta.get("dolt_database") or ""
            row["project_id"] = meta.get("project_id") or ""
            row["embedded_files"] = embedded_rows(beads)
        elif stopped is not None:
            row["attach"] = f"none (repo root at {stopped})"
        rows.append(row)

    reference = ""
    hashes = Counter(r["sha"] for r in rows if r["sha"])
    if hashes:
        reference = hashes.most_common(1)[0][0]

    if args.verify:
        for row in rows:
            row["bd_where"] = bd_where(pathlib.Path(row["cwd"]))

    if args.json:
        print(json.dumps({"reference_sha": reference, "spaces": rows}, indent=1))
        return 0

    print(f"spaces: {len(rows)}   reference metadata sha: {reference[:16]}… ({hashes.get(reference, 0)} spaces)")
    print()
    header = f"{'workspace':10} {'label':22} {'lane':22} {'attach':26} {'db':8} notes"
    print(header)
    print("-" * len(header))
    for row in rows:
        notes = []
        if row["sha"] and reference and row["sha"] != reference:
            notes.append("metadata DIFFERS from the majority")
        if not row["sha"]:
            notes.append("no metadata.json")
        if row["embedded_files"]:
            notes.append(f"embeddeddolt has {row['embedded_files']} files — divergent, invisible")
        if row["attach"].startswith("none"):
            notes.append("sees NO tracker")
            if row["stopped_at"]:
                notes.append(f"walk stopped at repo root {row['stopped_at']}")
        if args.verify:
            got = row.get("bd_where", "")
            expected = row["beads_dir"] or "Error: No active beads workspace found"
            notes.append("bd-where OK" if expected in got else f"bd-where DIFFERS: {got[:60]}")
        print(f"{row['workspace']:10} {row['label'][:22]:22} {row['lane'][:22]:22} "
              f"{row['attach'][:26]:26} {row['database'][:8]:8} {'; '.join(notes)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
