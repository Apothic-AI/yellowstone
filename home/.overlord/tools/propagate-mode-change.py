#!/usr/bin/env python3
"""propagate-mode-change — inspect mode state; propagation is disabled fail-closed.

Observed 2026-11-13: /profile reload arrived as a user prompt and aborted a turn;
base digests were refused for project-overlay selections. Base edits must never
be propagated by prompting: overlays reread the base; instance copies refresh
on next launch. Project reapproval is disabled until a changed project file and
its composed selection digest can be proven. --inspect is strictly read-only.


Use --inspect for read-only inventory. Default and --dry-run refuse propagation;
no slash commands are sent. /reload does not reapprove a mode.

"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERDR = os.environ.get("HERDR_BIN_PATH") or "herdr"
STATE_ROOT = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
# The REAL agent dir, deliberately not this process's PI_CODING_AGENT_DIR: a launcher lane
# runs with it set to its own instance dir, and inheriting it would make "the source file"
# resolve to the caller's frozen copy — so every comparison would be against the wrong file.
# The source of truth for a mode edit is always ~/.pi/agent/modes.
AGENT_DIR = Path.home() / ".pi" / "agent"
INSTANCES = Path.home() / ".pi-profile-switch" / "instances"
# The package's own fingerprint function, invoked for the composed-definition digest.
PKG_MODE_DIGEST = Path.home() / ".overlord" / "tools" / "mode-composed-digest.mjs"

# A lane's status must be idle/done before a slash command is delivered.
IDLE_STATES = {"idle", "done"}


def run(args: list[str], timeout: float = 20.0) -> tuple[bool, str]:
    try:
        out = subprocess.run([HERDR, *args], capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)
    return out.returncode == 0, out.stdout


def list_agents() -> list[dict]:
    ok, out = run(["agent", "list"])
    if not ok:
        raise SystemExit("propagate-mode-change: could not read the agent list")
    try:
        return json.loads(out)["result"]["agents"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise SystemExit(f"propagate-mode-change: unexpected agent list shape ({exc})")


def status_of(pane: str) -> str:
    ok, out = run(["agent", "get", pane])
    if not ok:
        return "unknown"
    try:
        return (json.loads(out)["result"]["agent"]["agent_status"] or "").lower()
    except (json.JSONDecodeError, KeyError, TypeError):
        return "unknown"


# The sibling tool that owns the mutation. This tool keeps the fleet inventory and the digest it
# computes for reporting; driving a lane (dialog handling, keystroke encoding, attestation) is
# reconcile-mode.py's, so there is ONE implementation of the parts that can silently fail.
RECONCILE = Path(__file__).resolve().with_name("reconcile-mode.py")


def reconcile(pane: str, reapprove: bool = True) -> tuple[int, dict | None, str]:
    """Reconcile one lane through reconcile-mode.py and return (exit code, its row, raw output)."""
    if not RECONCILE.exists():
        return 1, None, f"missing {RECONCILE}"
    argv = [sys.executable, str(RECONCILE), "--only", pane, "--json"]
    if not reapprove:
        argv.append("--no-reapprove")
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=600)
    except Exception as exc:  # noqa: BLE001
        return 1, None, f"reconcile-mode could not run: {exc}"
    raw = (out.stdout or "").strip()
    try:
        rows = json.loads(raw) or []
    except json.JSONDecodeError:
        return out.returncode, None, raw or (out.stderr or "").strip()
    row = next((r for r in rows if r.get("pane") == pane), rows[0] if rows else None)
    return out.returncode, row, raw


def type_keys(message: str) -> list[str]:
    """Turn text into send-keys arguments.

    Kept for the record and for any future caller, though this tool no longer drives a lane: a
    multi-character argument is rejected ('unsupported key abc def', so the text is sent one
    character per argument) and a literal " " argument is silently DROPPED, which glued
    `/profile reload` into `/profilereload` and made the palette miss the command (observed
    2026-11-07). The token `space` types a real space. `reconcile-mode.py` is where this now runs.
    """
    return ["space" if ch == " " else ch for ch in message]


def send_slash(pane: str, message: str, confirm: str | None, timeout: float = 25.0) -> bool:
    """Drive the palette with keystrokes and submit with one Enter.

    `herdr agent prompt` cannot deliver a slash command: the leading `/` opens the
    palette and the text is re-submitted as a user message. Keystrokes instead.
    """
    raise RuntimeError("slash delivery disabled: command may be submitted as a prompt")


def cwd_of(pane: str) -> str:
    """The lane's working directory — the root its mode composition resolves from."""
    ok, out = run(["agent", "get", pane])
    if not ok:
        return ""
    try:
        return json.loads(out)["result"]["agent"].get("cwd") or ""
    except (json.JSONDecodeError, KeyError, TypeError):
        return ""


def read_pane(pane: str) -> str:
    ok, out = run(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "60"])
    return out if ok else ""


# ---------------------------------------------------------------- fingerprint reading

def session_of(pane: str) -> str:
    """The lane's live session jsonl.

    `herdr agent get` can report a session path that does not exist on disk: after a relaunch
    it may name the newly-created file before it is flushed, or hold a stale path, while the
    real newest file sits under the same `sessions/<slug>/` directory. Trusting the reported
    path made every digest read fail silently (pi-rooms-leader read `no leader fp` while its
    live session held one). Fall back to the newest existing file in the reported directory.
    """
    ok, out = run(["agent", "get", pane])
    reported = ""
    if ok:
        try:
            reported = ((json.loads(out)["result"]["agent"].get("agent_session") or {}).get("value")) or ""
        except (json.JSONDecodeError, KeyError, TypeError):
            reported = ""
    if reported and Path(reported).exists():
        return reported
    if reported:
        directory = Path(reported).parent
        if directory.is_dir():
            newest = sorted(directory.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
            if newest:
                return str(newest[0])
    return reported


def fingerprint_path(session: str, key: str) -> str | None:
    """The mode-file path this lane last recorded for `key` — what it actually read."""
    if not session or not Path(session).exists():
        return None
    path = None
    try:
        with open(session, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if '"pi-mode-state.v3"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("customType") != "pi-mode-state.v3":
                    continue
                found = (entry.get("data") or {}).get("fingerprints", {}).get(key)
                if found:
                    path = found.get("path")
    except OSError:
        return None
    return path


def composed_digest(cwd: str, key: str, override_path: str | None = None) -> dict | None:
    """The digest pi-modes itself would record for this lane's composition.

    Shells out to the package's own `modeDefinitionFingerprint` rather than reimplementing it:
    the fingerprint covers the COMPOSED definition (global base + project `append` delta) and
    INCLUDES `scope` and `path`, so a hand-rolled hash over one file's raw fields disagrees for
    the wrong reasons.

    `override_path` matters more than it looks. A launcher lane reads its own materialised copy
    at `<instances>/launch-XXXX/modes/<key>.json`, and because `path` is part of the fingerprint
    the SAME TEXT at the instance path hashes differently from the real agent dir:
    measured 2026-11-07 on soli-lynx — instance copy `3fef5517dd906405` (what the lane recorded)
    vs real file `7fd1f88c351a7e51`. Attesting against the real-agent-dir digest therefore can
    never match a launcher lane, which is why the check must ask for the digest OF THE LANE'S
    OWN COPY, after the reload has refreshed it.
    """
    if not PKG_MODE_DIGEST.exists():
        return None
    env = {**os.environ, "REAL_AGENT_DIR": str(AGENT_DIR)}
    argv = ["node", "--experimental-strip-types", str(PKG_MODE_DIGEST), cwd, key]
    if override_path:
        argv.append(override_path)
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=40, env=env)
    except Exception:
        return None
    text = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def recorded_digest(session: str, key: str) -> str | None:
    """The digest the lane's OWN session recorded at its last activation/reapproval."""
    if not session or not Path(session).exists():
        return None
    digest = None
    try:
        with open(session, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if '"pi-mode-state.v3"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("customType") != "pi-mode-state.v3":
                    continue
                found = (entry.get("data") or {}).get("fingerprints", {}).get(key)
                if found:
                    digest = found.get("digest")
    except OSError:
        return None
    return digest


def mode_verdict(pane: str) -> str | None:
    """The lane's own mode verdict, straight from its footer.

    pi-modes renders three distinct states, and conflating them is a false signal:
      `mode:<key>`    — the composition resolved, no diagnostics
      `mode:<key> !`  — the mode composed BUT diagnostics are present (a warning; contract intact)
      `mode:native !` — the selection was DROPPED and the lane is on the native prompt
    Only the last is a lost role contract. Read this rather than reimplementing
    `modeDefinitionFingerprint` over the composed definition, which is what a hand-rolled drift
    check gets wrong (it hashed the source file's raw fields and returned one constant per fleet).
    """
    for line in reversed(read_pane(pane).splitlines()):
        match = re.search(r"mode:([A-Za-z0-9_.-]+)(\s*!)?", line)
        if match:
            return f"{match.group(1)}{' !' if match.group(2) else ''}"
    return None


def definition_signature(path: str) -> str | None:
    """A hash of the mode definition at `path`, to prove the lane's source is current."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    prompt = raw.get("systemPrompt", "")
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]


def instance_dir_of(path: str | None) -> Path | None:
    if not path:
        return None
    match = re.search(r"/instances/(launch-[^/]+)/", path)
    return INSTANCES / match.group(1) if match else None


def copy_dir_of(path: str | None) -> Path | None:
    """The directory a launcher lane reads `modes/<key>.json` from, or None for a real-path lane.

    The lane's recorded fingerprint path is `<instances>/launch-XXXX/modes/<key>.json`, so the copy
    directory is that file's PARENT. Using `instance_dir_of` here (the launch ROOT) silently built
    `<launch>/leader.json`, which does not exist — so the override never applied and every
    instance-copy lane got the REAL agent dir's digest. Measured 2026-11-08: 22 of 30 lanes wrong,
    all reporting the identical `7fd1f88c…` constant, which the lane's own gate would then have
    refused. Cross-checked against `pi-modes expected` (the package's own function at the lane's
    recorded path), which is the authority for this value.
    """
    if not path or "/instances/" not in path:
        return None
    directory = Path(path).parent
    return directory if directory.is_dir() else None


def classify(path: str | None) -> str:
    """Which mechanism the lane needs.

    Either way the lane is a pi-profile launcher lane and `/profile reload` is correct: it
    re-resolves through the full launcher path and re-materialises `modes/`/`mode-presets/`
    in the runtime dir, so it fixes an instance-copy lane and is a harmless refresh for a
    lane whose recorded path is the real file. `/reload` alone is NOT sufficient for an
    instance-copy lane. The fingerprint path is reported for evidence, not to pick between
    them.
    """
    return "profile" if path else "unknown"


# ------------------------------------------------------------------------- delivery

def recorded_keys(session: str, key: str) -> list[str]:
    """The mode keys the lane's session recorded fingerprints for — i.e. its selection.

    Drift changes a digest, never the set of selected keys, so this is the selection to pin even
    when the digests themselves are stale. `key` is appended if the recorded set omits it, so a
    fresh session still yields a pinnable selection. 230 of 232 recorded sessions on this machine
    select exactly one key; the rest select two, which is why the keyed form exists.
    """
    if not session or not Path(session).exists():
        return [key]
    keys: list[str] = []
    try:
        with open(session, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if '"pi-mode-state.v3"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("customType") != "pi-mode-state.v3":
                    continue
                found = (entry.get("data") or {}).get("fingerprints")
                if found:
                    keys = list(found.keys())
    except OSError:
        return [key]
    if key not in keys:
        keys.append(key)
    return keys


def key_digest(cwd: str, key: str, copy_dir: Path | None) -> str | None:
    """The digest pi-modes will compare for `key`, over the path THIS lane reads it from."""
    override = None
    if copy_dir is not None:
        candidate = copy_dir / f"{key}.json"
        if candidate.exists():
            override = str(candidate)
    return (composed_digest(cwd, key, override) or {}).get("digest")


def expect_argument(cwd: str, session: str, key: str, copy_dir: Path | None) -> str | None:
    """The `--expect` value that pins pi-modes to the definitions we hashed (FT-40/FT-42).

    A lone sha256 is only valid for a single-mode selection; a lane composing more than one mode
    needs `key=sha256,...` with an entry for every selected key. Returning None means "could not
    pin it" — the caller then falls back to the digest-less form, which pi-modes still guards, and
    the read-back attestation below still decides whether anything was actually persisted.
    Half-pinning is never emitted: one missing key would make pi-modes refuse ("is missing a
    digest for <key>"), which is honest but indistinguishable from real drift in the report.
    """
    keys = [value for value in recorded_keys(session, key) if value]
    if not keys:
        return None
    if len(keys) == 1:
        return key_digest(cwd, keys[0], copy_dir)
    entries = []
    for one in keys:
        digest = key_digest(cwd, one, copy_dir)
        if not digest:
            return None
        entries.append(f"{one}={digest}")
    return ",".join(sorted(entries))


def deliver(pane: str, kind: str, key: str, dry: bool, reapprove: bool = True) -> dict:
    """Read-only lane inventory; direct mutation is forbidden."""
    if not dry:
        raise RuntimeError("mode propagation disabled; project reapproval requires a verified composed digest")
    cwd = cwd_of(pane)
    session = session_of(pane)
    before_path = fingerprint_path(session, key)
    if kind != "profile":
        return {"pane": pane, "kind": kind, "mechanism": "none", "delivered": False,
                "note": "no recorded fingerprint for this key"}
    expected = composed_digest(cwd, key) if cwd else None
    return {"pane": pane, "kind": kind, "mechanism": "inspection", "delivered": False,
            "dry_run": True, "reads": before_path,
            "expected_digest": (expected or {}).get("digest"),
            "expect": expect_argument(cwd, session, key, copy_dir_of(before_path)),
            "verdict": mode_verdict(pane)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only", action="append", default=None, metavar="PANE")
    parser.add_argument("--key", default="leader", help="mode key to check (default: leader)")
    parser.add_argument("--no-reapprove", dest="reapprove", action="store_false", default=True,
                        help="reload copies only; do not re-approve drifted digests (stops shy "
                             "of the gate — the lane then stays on native until re-approved "
                             "deliberately)")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--inspect", action="store_true", help="read-only mode state inspection; never propagates")
    args = parser.parse_args()

    if not args.inspect:
        print("propagate-mode-change: REFUSED base-mode propagation: no lane prompts; instance copies refresh on next launch. Project reapproval unavailable until a changed project file and composed selection digest are verified; /reload is not a substitute.", file=sys.stderr)
        return 2
    args.dry_run = True
    wanted = set(args.only or [])
    rows: list[dict] = []
    for agent in list_agents():
        pane = agent.get("pane_id") or ""
        name = agent.get("name") or "-"
        if not pane or (wanted and pane not in wanted):
            continue
        if (agent.get("agent") or "").lower() != "pi":
            continue
        path = fingerprint_path(session_of(pane), args.key)
        kind = classify(path)
        if kind == "unknown" and not wanted:
            continue  # a lane that does not select this key has nothing to propagate
        row_kind = "instance-copy" if (path and "/instances/" in path) else "real-path"
        rows.append({"pane": pane, "name": name, "reads_kind": row_kind,
                     **deliver(pane, kind, args.key, args.dry_run, args.reapprove)})

    if args.json:
        print(json.dumps(rows, indent=1))
        return 0

    if not rows:
        print(f"propagate-mode-change: no lane selects mode key {args.key!r}")
        return 0
    print(f"{'pane':9} {'lane':24} {'reads':13} {'mechanism':16} result")
    for row in rows:
        if row.get("dry_run"):
            result = "inspection only; propagation refused"
            if row.get("verdict"):
                result += f" (mode:{row['verdict']})"
        elif not row.get("delivered"):
            result = row.get("note") or "not delivered"
        else:
            result = "reloaded"
            if row.get("refused"):
                result += " + re-approve REFUSED by --expect"
            elif row.get("reapproved"):
                if row.get("attested"):
                    result += " + re-approved + ATTESTED"
                else:
                    result += " + re-approve ATTEMPTED, ATTESTATION FAILED"
            verdict = row.get("verdict_after") or row.get("verdict")
            if verdict:
                result += f" | mode:{verdict}"
        print(f"{row['pane']:9} {row['name'][:24]:24} {row.get('reads_kind','-'):13} "
              f"{row.get('mechanism','-'):16} {result}")
    refused = [r for r in rows if not r.get("dry_run") and r.get("refused")]
    failed = [r for r in rows if not r.get("dry_run") and r.get("reapproved")
              and r.get("attested") is False]
    still = [r for r in rows if not r.get("dry_run") and r.get("needs_reapprove")]
    if refused:
        print(f"\n{len(refused)} lane(s) were refused by `--expect`: the definition changed between "
              "this tool's hash and the command. Nothing was blessed. Re-run, or inspect those "
              "panes.")
    if failed:
        print(f"\n{len(failed)} lane(s) re-approve could not be attested (the definition moved, "
              "or the command did not persist). Re-run, or inspect those panes.")
    if still:
        # "not attested" is the honest label: a lane may compose `mode:<key> !` (contract intact,
        # diagnostics present) rather than `native`, and mislabelling that as native sent me looking
        # for a lost role contract that was never lost (measured 2026-11-08 on a scratch lane).
        native = [r["name"] for r in still if (r.get("verdict_after") or r.get("verdict") or "").startswith("native")]
        print(f"\n{len(still)} lane(s) not attested after reconcile: " + ", ".join(r["name"] for r in still))
        if native:
            print("  composing native (contract dropped): " + ", ".join(native))
    return 0


if __name__ == "__main__":
    sys.exit(main())
