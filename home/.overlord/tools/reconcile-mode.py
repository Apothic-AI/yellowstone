#!/usr/bin/env python3
"""reconcile-mode — inspect mode state; propagation is disabled fail-closed.

Observed 2026-11-13: /profile reload reached lanes as a user prompt, aborting a
turn; base CLI digests were refused for composed project-overlay selections.
Base changes need no lane prompt; instance copies refresh at the next launch.
This tool refuses propagation, including project reapproval until it can prove
both a changed project file and the exact composed selection digest. --inspect
is read-only; neither /reload nor /profile reload reapproves a project mode.


Use --inspect for read-only mode-state evidence. Default and --dry-run refuse
propagation, including base edits; no slash commands are sent.

"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERDR = os.environ.get("HERDR_BIN_PATH") or "herdr"


def _pi_modes_package() -> Path:
    """Resolve the pi-modes package: env override, then the installed package list,
    then the monorepo default.

    The installed list wins because it is the copy pi itself loads. A ~/Code
    checkout is deliberately not a candidate: the fleet installs from the
    monorepo, so a checkout path goes stale the moment that lane migrates.
    """
    override = os.environ.get("PI_MODES_PKG")
    if override:
        return Path(override)
    try:
        settings = json.loads((Path.home() / ".pi" / "agent" / "settings.json").read_text())
        for entry in settings.get("packages", []):
            source = entry if isinstance(entry, str) else (entry or {}).get("source")
            if isinstance(source, str) and source.startswith("/") and source.rstrip("/").endswith("/pi-modes"):
                return Path(source)
    except (OSError, ValueError):
        pass
    return (
        Path.home() / "Code" / "yellowstone" / "src" / "pi-extensions"
        / "pi-modes"
    )


PKG = _pi_modes_package()
CLI = PKG / "scripts" / "mode-cli.ts"
# This lane's authorized copy of the pi-modes CLI secret (mode 600). Kept in this lane's workspace,
# not on a machine-wide default path, so the gate's friction is not zeroed by a discoverable copy.
SECRET_FILE = Path.home() / "Documents" / "Fleet" / ".pi" / "pi-modes-cli.secret"
IDLE_STATES = {"idle", "done"}
LABELS = {"leader"}


def run(args: list[str], timeout: float = 30.0) -> tuple[bool, str]:
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
    return out.returncode == 0, out.stdout


def herdr(*args: str, timeout: float = 25.0) -> str:
    ok, out = run([HERDR, *args], timeout)
    return out if ok else ""


def cli(*args: str, timeout: float = 60.0) -> tuple[int, str]:
    ok = CLI.exists()
    if not ok:
        return 1, f"missing CLI: {CLI}"
    # This lane is an authorized caller, so it holds the pi-modes CLI secret in its own workspace.
    # Supply it here rather than relying on the ambient environment: the gate is armed fleet-wide,
    # and the secret is deliberately NOT on a machine-wide default path (a copy there would let any
    # lane find it and defeat the friction the gate exists to create). Set PI_MODES_CLI_SECRET_FILE
    # to override.
    env = dict(os.environ)
    secret_file = Path(
        env.get("PI_MODES_CLI_SECRET_FILE", str(SECRET_FILE))
    )
    if secret_file.exists():
        try:
            env.setdefault("PI_MODES_CLI_SECRET", secret_file.read_text().strip())
            env.setdefault("PI_MODES_CLI_SECRET_FILE", str(secret_file))
        except OSError:
            pass
    try:
        out = subprocess.run(
            ["node", "--experimental-strip-types", str(CLI), *args],
            capture_output=True, text=True, timeout=timeout, cwd=str(PKG), env=env,
        )
    except Exception as exc:  # noqa: BLE001
        return 1, str(exc)
    return out.returncode, out.stdout.strip()


def agents() -> list[dict]:
    ok, out = run([HERDR, "agent", "list"])
    if not ok:
        raise SystemExit("reconcile-mode: cannot read the agent list")
    return (json.loads(out).get("result") or {}).get("agents") or []


def status_of(pane: str) -> str:
    body = herdr("agent", "get", pane)
    try:
        return (json.loads(body)["result"]["agent"]["agent_status"] or "").lower()
    except Exception:  # noqa: BLE001
        return "unknown"


def session_of(pane: str, allow_fallback: bool = False) -> str:
    """The lane's live session path, exactly as herdr reports it.

    DO NOT SUBSTITUTE ANOTHER FILE. An earlier version fell back to the newest *.jsonl in the
    reported directory when herdr's path did not exist. That produced a correct-looking digest
    read from the WRONG session: pi-rooms-leader's live session had only ever received slash
    commands, so pi had not materialised its file yet, and the fallback silently read a day-old
    session instead and reported the lane as drifted. A stale path must never masquerade as a
    reading.

    A missing file is therefore returned as-is, and callers treat it as UNVERIFIED. This is not
    automatically a fault: a session driven only by commands has no file on disk until it takes a
    real turn (pi appends extension state in memory and materialises the file on the first
    persisted turn). Pass allow_fallback=True only for a deliberate, named exception.
    """
    body = herdr("agent", "get", pane)
    try:
        reported = ((json.loads(body)["result"]["agent"].get("agent_session") or {}).get("value")) or ""
    except Exception:  # noqa: BLE001
        return ""
    if reported and Path(reported).exists():
        return reported
    if reported and allow_fallback:
        directory = Path(reported).parent
        if directory.is_dir():
            newest = sorted(directory.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
            if newest:
                return str(newest[0])
    return reported


def read_pane(pane: str) -> str:
    return herdr("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "60")


def type_keys(text: str) -> list[str]:
    """One key per argument. A literal " " is silently dropped by send-keys, so use `space`."""
    return ["space" if ch == " " else ch for ch in text]


def slash(pane: str, message: str, confirm: str | None = None, settle: float = 30.0) -> bool:
    raise RuntimeError("slash delivery disabled: command may be submitted as a prompt")


def state(session: str) -> dict | None:
    code, out = cli("state", session, "--json")
    if code in (1, 3, 4) and not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def recorded_digests(payload: dict | None) -> dict[str, str]:
    """The digest each selected key RECORDED, keyed by mode key.

    The field is `recordedDigest` (not `recorded`): reading the wrong name yields an empty dict,
    which silently reads as "nothing recorded" and makes every lane look like it needs work. A
    payload that has keys but yields no digests is therefore an error, not an absence.
    """
    if not payload:
        return {}
    keys = payload.get("keys") or []
    digests = {k["key"]: k.get("recordedDigest") for k in keys if k.get("recordedDigest")}
    if keys and not digests:
        raise RuntimeError(
            "reconcile-mode: state reported keys but no recordedDigest fields; "
            f"the pi-modes state schema changed (keys: {[k.get('key') for k in keys]})"
        )
    return digests


def expected_digests(session: str) -> dict[str, str]:
    code, out = cli("expected", session, "--json")
    if code != 0:
        return {}
    try:
        payload = json.loads(out)
    except json.JSONDecodeError:
        return {}
    return {item["key"]: item["digest"] for item in (payload.get("expected") or []) if item.get("digest")}


def reconcile(pane: str, name: str, dry: bool, reapprove: bool) -> dict:
    # This function is also imported/called outside main: fail closed at the mutation boundary.
    if not dry:
        raise RuntimeError("mode propagation disabled; project reapproval requires a verified composed digest")
    row: dict = {"pane": pane, "name": name, "before": None, "after": None,
                 "expected": None, "reloaded": False, "reapproved": False,
                 "verified": False, "note": ""}

    session = session_of(pane)
    if not session or not Path(session).exists():
        # Not necessarily a fault: a session driven only by slash commands has no file until it
        # takes a real turn, because pi materialises the file on the first persisted turn. Report
        # it as unread rather than substituting another session — substituting is what made this
        # tool report a stale digest about the wrong session for pi-rooms-leader.
        row["note"] = "UNVERIFIED: no session file at the reported path (cannot read a digest)"
        return row

    before = state(session)
    row["before"] = (before or {}).get("verdict")
    row["before_digests"] = recorded_digests(before)

    want = expected_digests(session)
    row["expected"] = want
    if not want:
        row["note"] = "UNVERIFIED: no expected digest; inspection only"
        return row
    row["needs"] = any(row["before_digests"].get(k) != v for k, v in want.items())
    row["verified"] = not row["needs"]
    row["note"] = ("drift detected; inspection only, propagation refused" if row["needs"]
                   else "already recorded the expected digest")
    return row


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--only", action="append", default=None, metavar="PANE")
    p.add_argument("--no-reapprove", dest="reapprove", action="store_false", default=True,
                   help="reload the copy only; never send /mode-reapprove")
    p.add_argument("--key", default="leader")
    p.add_argument("--json", action="store_true")
    p.add_argument("--inspect", action="store_true", help="read-only mode state inspection; never propagates")
    args = p.parse_args()

    if not args.inspect:
        print("reconcile-mode: REFUSED base-mode propagation: no lane prompts; instance copies refresh on next launch. Project reapproval unavailable until a changed project file and composed selection digest are verified; /reload is not a substitute.", file=sys.stderr)
        return 2
    args.dry_run = True
    wanted = set(args.only or [])
    rows: list[dict] = []
    for agent in agents():
        pane = agent.get("pane_id") or ""
        name = agent.get("name") or "-"
        if not pane or (wanted and pane not in wanted):
            continue
        if (agent.get("agent") or "").lower() != "pi":
            continue
        if not wanted and not any(name.endswith(f"-{label}") for label in LABELS):
            continue
        rows.append(reconcile(pane, name, args.dry_run, args.reapprove))

    if args.json:
        print(json.dumps(rows, indent=1))
        return 0

    head = f"{'pane':9} {'lane':24} {'before':8} -> {'after':8} result"
    print(head)
    for r in rows:
        if r.get("note") == "already recorded the expected digest":
            result = "OK (already current)"
        elif r.get("note", "").startswith("would"):
            result = r["note"]
        elif r.get("verified"):
            result = "VERIFIED (recorded digest == expected)"
        elif r.get("note"):
            result = r["note"]
        else:
            result = "NOT VERIFIED"
        print(f"{r['pane']:9} {r['name'][:24]:24} {str(r.get('before') or '-'):8} -> "
              f"{str(r.get('after') or '-'):8} {result}")

    touched = [r for r in rows if r.get("needs") and not r.get("note", "").startswith("would")]
    verified = [r for r in touched if r.get("verified")]
    failed = [r for r in touched if not r.get("verified")]
    if touched and not args.dry_run:
        print(f"\n{len(verified)}/{len(touched)} verified.")
    if failed:
        print("NOT VERIFIED: " + ", ".join(r["name"] for r in failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
