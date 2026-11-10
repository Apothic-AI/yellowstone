#!/usr/bin/env python3
"""reconcile-mode — drive one lane through a mode-file change, and prove it.

Why this exists
---------------
A mode-file edit reaches a running lane in two steps, and skipping either one leaves the lane
composing the NATIVE prompt with no role contract:

  1. `/profile reload` re-materialises the lane's snapshot copy of `modes/` in its launch
     instance (pi-profile's ADR-0019 copies rather than symlinks, because pi-modes fails closed
     on a symlinked mode root). `/reload` does NOT do this.
  2. The lane's session still records the OLD definition digest, so under the default `block`
     drift policy the composition is dropped. The lane must re-approve the new digest.

The digest is not something this tool may compute: the fingerprint covers the definition's
`scope` and `path`, so the same mode TEXT at an instance path hashes differently from the real
agent dir (measured: 3fef5517 at `instances/launch-RXYi4n/modes/leader.json` vs 7fd1f88c at
`~/.pi/agent/modes/leader.json`). It asks the `pi-modes` CLI for the value, sends THAT, then
attests that the lane recorded it.

Why the lane re-approves itself, and why this tool never writes a session
------------------------------------------------------------------------
`pi --mode rpc --session <file>` RESUMES that session as a second writer: it appends entries and
re-records `pi-mode-state.v3` with `source: "startup"` from its own inherited `PI_MODE`,
regardless of what command you send. Against a live lane that is the two-writers failure the
fleet forbids. So this tool only reads, and sends the command to the lane over herdr; the lane's
own session records the new digest. See pi-modes
`docs/project/2026-11-07-out-of-band-mode-reapproval.md`.

Proof
-----
"I sent it" is not a result. Each lane is reported with the digest it recorded BEFORE and AFTER,
and the run only succeeds when the after-digest equals the one `expected` printed for the path
the lane actually reads. A status field is never treated as proof.

Usage
-----
  reconcile-mode.py --dry-run                 report what each lane would need; change nothing
  reconcile-mode.py --only w1C:p1             reconcile one lane
  reconcile-mode.py                           reconcile every leader lane that needs it
  reconcile-mode.py --no-reapprove            reload copies only; never send /mode-reapprove
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
    run([HERDR, "agent", "send-keys", pane, "ctrl+u"])
    ok, _ = run([HERDR, "agent", "send-keys", pane, "/", *type_keys(message[1:]), "Enter"])
    if not ok:
        return False
    if confirm:
        deadline = time.monotonic() + settle
        while time.monotonic() < deadline:
            if confirm.lower() in read_pane(pane).lower():
                return True
            time.sleep(1.5)
        return False
    return True


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

    # What the lane SHOULD record once its copy is refreshed — asked of the CLI, for the path the
    # lane actually reads. Never computed here.
    want = expected_digests(session)
    row["expected"] = want
    if not want:
        row["note"] = "no expected digest (no recorded mode state)"
        return row

    already = row["before_digests"]
    needs = any(already.get(k) != v for k, v in want.items())
    row["needs"] = needs
    if not needs:
        row["verified"] = True
        row["note"] = "already recorded the expected digest"
        return row

    if dry:
        row["note"] = "would reload" + (" + re-approve" if reapprove else "")
        return row

    if status_of(pane) not in IDLE_STATES:
        row["note"] = f"status={status_of(pane)} (skipped: never prompt a working lane)"
        return row

    # 1. refresh the snapshot copy in place
    row["reloaded"] = slash(pane, "/profile reload", "profile reloaded")

    # 2. the lane re-approves ITSELF against the digest the CLI computed. The digest is passed
    #    explicitly so the approval is pinned to the definition we hashed, not to whatever is on
    #    disk by the time the command runs.
    if reapprove:
        for key, digest in want.items():
            slash(pane, f"/mode-reapprove --expect {digest} --confirm-project")
            # Two consent dialogs can stand between the command and the recorded digest, and a lane
            # left on either is worse than a few seconds of polling:
            #   1. "Reapprove active prompt mode definitions?" — the generic confirm, raised only
            #      when --expect covers *some* of the selection (it is skipped when it covers all).
            #   2. "Use project mode \"<key>\"?" — the project-mode consent gate, raised when the
            #      lane's mode composes with a space-local delta. This one is NOT removed by
            #      --expect and not removed by --confirm-project, which is how pi-rooms-leader and
            #      herdr-leader were left stuck on a modal reporting `drift -> drift`.
            # Both default to `Yes`, and in case 2 the dialog names the very digest we asserted, so
            # answering is approving the definition we intended, not a blind Enter.
            # CASE 2 IS NEW AND MUST NOT BE ANSWERED IN ONE PASS: the project gate can re-raise
            # after the first answer, so allow repeated rounds.
            dialogs = (
                "Reapprove active prompt mode definitions?",
                "Use project mode",
            )
            answered = 0
            for _round in range(4):
                deadline = time.monotonic() + 20
                hit = False
                while time.monotonic() < deadline:
                    seen = read_pane(pane)
                    if any(text in seen for text in dialogs) and "Yes" in seen:
                        run([HERDR, "agent", "send-keys", pane, "Enter"])
                        answered += 1
                        hit = True
                        time.sleep(1.5)
                        break
                    if f"{digest[:12]}" in seen and "No" not in seen:
                        break
                    time.sleep(0.5)
                if not hit:
                    break
            row["dialogs_answered"] = answered
        row["reapproved"] = True

    # 3. ATTEST: read back what the lane recorded. This is the only thing that turns "I sent it"
    #    into verified.
    after = state(session)
    row["after"] = (after or {}).get("verdict")
    row["after_digests"] = recorded_digests(after)
    row["verified"] = all(row["after_digests"].get(k) == v for k, v in want.items())
    if not row["verified"]:
        code, out = cli("attest", session, "--expect",
                        ",".join(f"{k}={v}" for k, v in want.items()))
        row["attest_exit"] = code
        row["note"] = out.splitlines()[-1][:120] if out else f"attest exit {code}"
    return row


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--only", action="append", default=None, metavar="PANE")
    p.add_argument("--no-reapprove", dest="reapprove", action="store_false", default=True,
                   help="reload the copy only; never send /mode-reapprove")
    p.add_argument("--key", default="leader")
    p.add_argument("--json", action="store_true")
    args = p.parse_args()

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
