#!/usr/bin/env python3
"""restart-fleet — restart pi lanes so a new pi bundle or a changed launch env takes effect.

Why this exists
---------------
`/reload` re-reads keybindings, extensions, skills, prompts, themes and context files,
but it *does not* load new pi code: the installed bundle is resolved at exec. So after
`npm install -g @earendil-works/pi-coding-agent@X`, every live lane keeps running the old
bundle until its process is replaced. The same is true for a change to `PI_MODE`,
`PI_PROFILE`, the package set, or the environment: reload is not enough, this is
restart-or-nothing.

Contract (each rule learned from a real incident)
------------------------------------------------
* `pil` derives the lane name from the TAB LABEL of the pane it runs in. So the relaunch
  must run pil *inside the target pane* (`herdr pane run <pane> pil`) and must NEVER run
  `pil` from the caller's own pane: a child claiming the caller's name deregisters the
  live lane through leave-and-join.
* Double `ctrl+c` is the exit. `/exit` is not a pi command here: sent as a prompt it
  burns a turn and the agent replies "Exiting." while staying alive (2026-11-01).
* `pil` restores the lane's role contract (`PI_MODE`/`PI_PROFILE`/`PI_MODE_CONFIRM_PROJECT`)
  from `~/.local/state/pil/roles/<lane>.env` and its session from
  `~/.local/state/pil/sessions/<lane>.path`. So a bare `pil` in the pane is the whole
  relaunch — pass no `--session`, and `pi-profile` materializes a fresh instance dir.
* The lane must be idle/done first. Quitting a `working` lane kills an in-flight turn.
* Verify from artifacts, never from an exit code: the pane footer (`profile:`) proves the
  launch shape, and process start time vs bundle mtime proves the code.

Self-restart
------------
The coordinator cannot restart itself mid-turn (that kills the turn that would report the
result). `--deferred-self` spawns a detached `start_new_session=True` helper that waits for
this lane to go idle, restarts it, and writes a durable result under
`~/.local/state/pil/restart-results/`. This lane is always excluded from the inline pass.

Usage
-----
  restart-fleet.py [--dry-run] [--only PANE]... [--interrupt-working] [--working-only]
                   [--idle-timeout SECS] [--include-self] [--verify-version]
                   [--bundle PATH] [--no-self-defer] [--json]

Exit codes: 0 every targeted lane restarted and verified; 1 at least one lane failed;
2 refused before doing anything (bad bundle path, no lanes matched).
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

HERDR = os.environ.get("HERDR_BIN_PATH") or "herdr"
STATE_ROOT = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
RESULT_DIR = STATE_ROOT / "pil" / "restart-results"
ROLES_DIR = STATE_ROOT / "pil" / "roles"
LOCK_FILE = STATE_ROOT / "pil" / "restart-fleet.lock"

DEFAULT_PI_ROOT = Path("/home/bitnom/.local/share/mise/installs/node/22.23.3/lib/node_modules/@earendil-works/pi-coding-agent")
# The chunk that carries `var VERSION="x.y.z"`. A lane whose process started after this
# file's mtime necessarily loaded that bundle; one started before necessarily did not.
VERSION_CHUNK = "dist/bundle/chunks/chunk-V6KH5QG4.js"

QUIT_KEYS = ("ctrl+c", "ctrl+c")
WAIT_GONE_SECS = 20.0
WAIT_IDLE_SECS = 90.0
# The overlord watchdog resumes its pane the moment pi disappears there. Restarting that
# pane without taking the watchdog's own lock makes it race us: it relaunches while we do,
# and the pane ends up with two pi processes. Hold the same flock it uses, so its pass
# reports "another pass holds the lock" and skips. (It only overrides after 300s stale,
# far longer than one lane's restart, so this is sufficient for a single lane.)
WATCHDOG_STATE = Path(os.environ.get("OVERLORD_STATE", Path.home() / ".local/state/overlord"))
WATCHDOG_PANE = os.environ.get("OVERLORD_PANE", "wE:p1")


# --------------------------------------------------------------------------- helpers

def herdr(*args: str, timeout: float = 30.0) -> dict | None:
    """Run a herdr verb and return parsed `result`, or None on any failure."""
    try:
        out = subprocess.run([HERDR, *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout).get("result")
    except (json.JSONDecodeError, AttributeError):
        return None


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def list_lanes() -> list[dict]:
    result = herdr("agent", "list")
    if not result:
        return []
    agents = result.get("agents", [])
    return [a for a in agents if a.get("agent") == "pi"]


def pane_shell_pid(pane: str) -> int | None:
    info = herdr("pane", "process-info", "--pane", pane)
    if not info:
        return None
    pid = (info.get("process_info") or {}).get("shell_pid")
    return pid if isinstance(pid, int) else None


def fore_pid(pane: str) -> int | None:
    info = herdr("pane", "process-info", "--pane", pane)
    if not info:
        return None
    procs = (info.get("process_info") or {}).get("foreground_processes") or []
    for proc in procs:
        if proc.get("name") == "pi" or proc.get("argv", [""])[0] == "pi":
            return proc.get("pid")
    return procs[0].get("pid") if procs else None


def proc_start_epoch(pid: int) -> float | None:
    """Process start time. stat().st_ctime is what the fleet already uses for this;
    it is set at exec and is not perturbed by /proc reads."""
    try:
        return os.stat(f"/proc/{pid}").st_ctime
    except OSError:
        return None


def proc_env(pid: int) -> dict[str, str]:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes().decode("utf-8", "replace")
    except OSError:
        return {}
    return dict(part.split("=", 1) for part in raw.split("\0") if "=" in part)


def foreground_pi(pane: str) -> int | None:
    """The pi process herdr reports as the pane's foreground — i.e. the lane itself.

    Distinct from `pi_pids_for_pane`, which matches on the HERDR_PANE_ID environment and
    therefore also catches a foreign pi that merely inherited the pane's env (a detached
    `tmux -L ...` dev rig does exactly this). Only the foreground process is this lane, so
    only its start time and environment may be used as evidence.
    """
    info = herdr("pane", "process-info", "--pane", pane)
    if not info:
        return None
    for proc in ((info.get("process_info") or {}).get("foreground_processes") or []):
        if proc.get("name") == "pi" or (proc.get("argv") or [None])[0] == "pi":
            return proc.get("pid")
    return None


def pi_pids_for_pane(pane: str) -> list[tuple[int, float | None]]:
    """Every live `pi` process whose HERDR_PANE_ID is this pane (dup detection)."""
    found: list[tuple[int, float | None]] = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            if Path(f"/proc/{entry}/comm").read_text().strip() != "pi":
                continue
        except OSError:
            continue
        if proc_env(int(entry)).get("HERDR_PANE_ID") != pane:
            continue
        found.append((int(entry), proc_start_epoch(int(entry))))
    return found


def bundle_info(bundle: Path) -> tuple[float, str] | None:
    chunk = bundle / VERSION_CHUNK
    try:
        mtime = chunk.stat().st_mtime
        text = chunk.read_text(errors="replace")
    except OSError:
        return None
    match = re.search(r'VERSION="([^"]+)"', text)
    return mtime, match.group(1) if match else "?"


def read_footer(pane: str, lines: int = 40) -> str:
    try:
        out = subprocess.run([HERDR, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", str(lines)],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout


@contextmanager
def watchdog_guard(pane: str):
    """Hold the overlord watchdog's lock while restarting the pane it watches."""
    if pane != WATCHDOG_PANE:
        yield False
        return
    lock_path = WATCHDOG_STATE / "watchdog.lock"
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(lock_path, "w")
    except OSError as error:
        print(f"  WARN  could not open {lock_path} ({error}); watchdog may race this lane")
        yield False
        return
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(f"  GUARD {pane} holding the overlord watchdog lock")
        yield True
    except OSError:
        print(f"  WARN  overlord watchdog holds its lock right now; waiting for its pass to finish")
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield True
    finally:
        try:
            fcntl.flock(handle, fcntl.LOCK_UN)
        finally:
            handle.close()


def identity_problems(name: str, env: dict[str, str], role: dict[str, str],
                     plan: str | None) -> list[str]:
    """Everything wrong with a restarted lane's identity. Empty list = coherent.

    Kept pure so the guard can be exercised against the real failure values without
    restarting a lane (see the 2026-11-06 stale-HERDR_BIN_PATH case in the tests below).
    """
    problems: list[str] = []
    if name and env.get("PI_ROOMS_NAME") != name:
        problems.append(f"PI_ROOMS_NAME={env.get('PI_ROOMS_NAME')!r}, expected {name!r}"
                        " (pil's name derivation was skipped — check its stderr)")
    for key in ("PI_MODE", "PI_PROFILE"):
        if role.get(key) and env.get(key) != role[key]:
            problems.append(f"{key}={env.get(key)!r}, role file says {role[key]!r}")
    if role.get("PI_PROFILE") and plan is not None and plan != role["PI_PROFILE"]:
        problems.append(f"instance plan profile={plan!r}, role file says {role['PI_PROFILE']!r}")
    return problems


def expected_role(name: str) -> dict[str, str]:
    """The lane's recorded role, as `pil` will restore it on the next launch."""
    try:
        text = (ROLES_DIR / f"{name}.env").read_text()
    except OSError:
        return {}
    role: dict[str, str] = {}
    for token in text.split():
        if "=" in token:
            key, value = token.split("=", 1)
            if key in ("PI_MODE", "PI_PROFILE", "PI_MODE_CONFIRM_PROJECT"):
                role[key] = value
    return role


def plan_profile(agent_dir: str) -> str | None:
    """The profile pi-profile actually activated, from the instance's own plan."""
    if not agent_dir:
        return None
    try:
        return json.loads((Path(agent_dir) / "pi-profile.json").read_text()).get("profile")
    except (OSError, json.JSONDecodeError):
        return None


def wait_for(predicate, timeout: float, interval: float = 0.5) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


SHELLS = {"zsh", "bash", "sh", "fish"}


def pane_is_at_shell(pane: str) -> bool:
    """True when the pane's foreground is an interactive shell, i.e. pi has exited.

    `pi` vanishing from a pane is not the same as the pane being ready: herdr reports a
    lane whose pi exited as still present, and a leftover pi elsewhere (a detached tmux
    rig sharing the name) can keep the count non-zero. The shell is the real signal.
    """
    info = herdr("pane", "process-info", "--pane", pane)
    if not info:
        return False
    procs = (info.get("process_info") or {}).get("foreground_processes") or []
    return bool(procs) and all(p.get("name") in SHELLS for p in procs)


def relaunch(pane: str) -> bool:
    """Run `pil` inside the target pane and wait for the LANE's pi to appear.

    Waits on the pane's foreground process, not on `pi_pids_for_pane`: a foreign pi that
    tags the pane (a detached dev rig) satisfies the latter instantly, so the wait would
    return before the real lane had even started — which is how a healthy relaunch got
    reported as "no foreground pi" (2026-11-06).
    """
    herdr("pane", "run", pane, "pil", timeout=60)
    return wait_for(lambda: foreground_pi(pane) is not None, timeout=WAIT_IDLE_SECS, interval=1.0)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_result(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=1) + "\n")
    tmp.replace(path)


# ---------------------------------------------------------------------------- probe

def probe(lane: dict, bundle_mtime: float, bundle_version: str) -> dict:
    """Collect everything a restart decision needs for one lane, without acting."""
    pane = lane.get("pane_id") or ""
    name = lane.get("name") or ""
    status = lane.get("agent_status") or "unknown"
    tab = lane.get("tab_id") or ""
    session = ((lane.get("agent_session") or {}).get("value")) or ""

    info: dict = {
        "pane": pane, "name": name, "status": status, "tab": tab,
        "session": session, "blockers": [], "warnings": [],
    }

    # Rename hazard: pil derives the name from the tab label.
    tab_result = herdr("tab", "get", tab) if tab else None
    label = ((tab_result or {}).get("tab") or {}).get("label") or ""
    info["label"] = label
    # The name is derived by pil from the tab label; an empty name means the lane is
    # mid-restart or herdr dropped it (herdr re-detects the agent on `/new` and can leave
    # `name: null`). That is not a rename hazard and not a reason to skip: pil will derive
    # the same slug, so derive it here too and verify against it. The role file and the
    # room name are both keyed by this slug.
    if not name and label:
        name = slug(label)
        info["name"] = name
        info["warnings"].append("herdr reported no name; derived it from the tab label")
    if not name:
        info["blockers"].append("no lane name and no tab label to derive one from")
    elif label and slug(label) != name:
        info["blockers"].append(f"tab label {label!r} slugifies to {slug(label)!r}, not {name!r}")

    pids = pi_pids_for_pane(pane) if pane else []
    info["pids"] = [{"pid": pid, "started": started} for pid, started in pids]
    if not pids:
        info["blockers"].append("no pi process found for this pane")

    # Evidence comes from the pane's foreground pi only: a foreign process that merely
    # tags this pane is reported, never measured (see foreground_pi).
    lane_pid = foreground_pi(pane) if pane else None
    if lane_pid is None:
        info["blockers"].append("herdr reports no foreground pi process in this pane")
    if len(pids) > 1:
        info["warnings"].append(f"{len(pids)} pi processes tag this pane; only the foreground one is the lane")

    started = proc_start_epoch(lane_pid) if lane_pid else None
    info["started"] = started
    info["stale"] = bool(started and started < bundle_mtime)
    info["on_bundle"] = bundle_version if (started and started >= bundle_mtime) else None

    if not session:
        info["warnings"].append("no live session reported by herdr; pil falls back to its recorded path")
    elif not Path(session).exists():
        info["warnings"].append(f"reported session path is missing: {session}")

    shell = pane_shell_pid(pane) if pane else None
    if shell:
        env = proc_env(shell)
        info["pane_cwd_ok"] = Path(f"/proc/{shell}/cwd").exists() if Path(f"/proc/{shell}").exists() else None
        info["pane_has_pi_env"] = any(k.startswith("PI_") for k in env)
    return info


# -------------------------------------------------------------------------- restart

def restart_lane(info: dict, *, dry_run: bool, interrupt_working: bool,
                 idle_timeout: float, bundle_mtime: float, bundle_version: str) -> str:
    """Restart one lane. Returns 'ok' | 'skipped' | 'failed'."""
    pane, name, status = info["pane"], info["name"], info["status"]
    tag = f"{pane:9} {name:28} {status:8}"

    if info["blockers"]:
        print(f"  SKIP  {tag} {'; '.join(info['blockers'])}")
        return "skipped"

    if status == "working":
        if not interrupt_working:
            print(f"  SKIP  {tag} working (pass --interrupt-working to end its turn first)")
            return "skipped"
        print(f"  INTERRUPT {tag} sending esc, waiting up to {idle_timeout:g}s for idle")
        herdr("agent", "send-keys", pane, "esc")
        if not wait_for(lambda: ((herdr("agent", "get", name) or {}).get("agent") or {}).get("agent_status") in ("idle", "done"),
                        timeout=idle_timeout, interval=0.5):
            print(f"  SKIP  {tag} still working after esc — not killed mid-turn")
            return "skipped"

    if dry_run:
        print(f"  PLAN  {tag} quit(ctrl+c twice) -> pil  [{info.get('label','?')}]"
              + ("  [watchdog-guarded]" if pane == WATCHDOG_PANE else ""))
        return "skipped"

    with watchdog_guard(pane):
        return _restart_now(info, tag, pane, bundle_mtime, bundle_version)


def _restart_now(info: dict, tag: str, pane: str,
                 bundle_mtime: float, bundle_version: str) -> str:
    # 1. Quit. Quitting is verified by the pane falling back to its shell, not by the
    #    pi count: a detached pi belonging to another rig (a `tmux -L ...` dev session
    #    that inherited this pane's env) can hold the count above zero forever and is
    #    not this lane. If the pane is already at a shell, pi is already gone.
    if not pane_is_at_shell(pane):
        print(f"  QUIT  {tag} ctrl+c twice")
        herdr("agent", "send-keys", pane, *QUIT_KEYS)
        at_shell = wait_for(lambda: pane_is_at_shell(pane), timeout=WAIT_GONE_SECS, interval=0.5)
        if not at_shell:
            # Second attempt: the first ctrl+c may have only cleared a composer line.
            herdr("agent", "send-keys", pane, *QUIT_KEYS)
            at_shell = wait_for(lambda: pane_is_at_shell(pane), timeout=WAIT_GONE_SECS, interval=0.5)
        if not at_shell:
            print(f"  FAIL  {tag} pane never returned to a shell after ctrl+c twice")
            return "failed"
        if pi_pids_for_pane(pane):
            print(f"  NOTE  {tag} pane is at a shell; a foreign pi still tags this pane"
                  f" (not touched — it belongs to another process tree)")
    else:
        print(f"  QUIT  {tag} already at a shell; relaunching only")

    # 2. Relaunch inside the target pane. Bare `pil`: it restores role env and session.
    print(f"  LAUNCH{tag} pil (in pane)")
    if not relaunch(pane):
        print(f"  FAIL  {tag} no pi process came back")
        return "failed"

    # 3. Verify from /proc and the instance plan — NEVER from the pane's scrollback.
    #    A pane keeps the previous process's footer in its scroll history, so a footer
    #    read can "verify" the lane that just died. That is not hypothetical: a stale
    #    HERDR_BIN_PATH made `pil` skip the whole name/role restore, the lane came back
    #    unnamed on the global profile, and the scrollback footer still showed the old
    #    identity — so two fleet passes reported OK for a lane that had silently lost
    #    its role (2026-11-06). The new process's own environment is authoritative.
    new_pid = foreground_pi(pane)
    new_started = proc_start_epoch(new_pid) if new_pid else 0.0
    if not new_pid:
        print(f"  FAIL  {tag} herdr reports no foreground pi in the pane after relaunch")
        return "failed"
    if new_started < bundle_mtime:
        print(f"  FAIL  {tag} came back on the OLD bundle (started before {bundle_version} install)")
        return "failed"

    env = proc_env(new_pid) if new_pid else {}
    lane_name = info.get("name") or ""
    role = expected_role(lane_name)
    plan = plan_profile(env.get("PI_CODING_AGENT_DIR", ""))
    problems = identity_problems(lane_name, env, role, plan)

    if problems:
        for problem in problems:
            print(f"  FAIL  {tag} {problem}")
        return "failed"

    mode = env.get("PI_MODE") or "-"
    profile = plan or env.get("PI_PROFILE") or "-"
    print(f"  OK    {tag} {bundle_version}  mode={mode} profile={profile} rooms={env.get('PI_ROOMS_NAME')}")
    return "ok"


# ------------------------------------------------------------------------- deferred

def defer_self(pane: str, timeout: float, bundle_mtime: float, bundle_version: str) -> str:
    """Restart this lane after its own turn ends, from a detached helper."""
    safe = slug(pane) or "self"
    result_path = RESULT_DIR / f"self-{safe}-{int(time.time() * 1000)}.json"
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()),
         "--deferred-self", pane, "--deferred-timeout", str(timeout),
         "--deferred-result", str(result_path)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True,
    )
    return str(result_path)


def run_deferred_self(pane: str, timeout: float, result_path: Path) -> int:
    """Wait for our own lane to go idle, then restart it. Runs detached."""
    info = {"pane": pane, "phase": "waiting", "at": now_iso(), "result": None}
    write_result(result_path, info)

    def lane_status() -> str:
        result = herdr("agent", "list")
        for agent in ((result or {}).get("agents") or []):
            if agent.get("pane_id") == pane:
                return agent.get("agent_status") or "unknown"
        return "gone"

    if not wait_for(lambda: lane_status() in ("idle", "done"), timeout=timeout, interval=2.0):
        info.update(phase="failed", result="timed out waiting for idle", at=now_iso())
        write_result(result_path, info)
        return 1

    info.update(phase="restarting", at=now_iso())
    write_result(result_path, info)

    # Restart ourselves: quit, wait for the pane to fall back to its shell, then pil.
    if not pane_is_at_shell(pane):
        herdr("agent", "send-keys", pane, *QUIT_KEYS)
        if not wait_for(lambda: pane_is_at_shell(pane), timeout=WAIT_GONE_SECS, interval=0.5):
            herdr("agent", "send-keys", pane, *QUIT_KEYS)
            if not wait_for(lambda: pane_is_at_shell(pane), timeout=WAIT_GONE_SECS, interval=0.5):
                info.update(phase="failed", result="pane never returned to a shell", at=now_iso())
                write_result(result_path, info)
                return 1

    herdr("pane", "run", pane, "pil", timeout=60)
    if not wait_for(lambda: not pane_is_at_shell(pane), timeout=WAIT_IDLE_SECS, interval=1.0):
        info.update(phase="failed", result="pil did not start a pi process in the pane", at=now_iso())
        write_result(result_path, info)
        return 1

    info.update(phase="confirmed", result="restarted; verify the footer in the pane", at=now_iso())
    write_result(result_path, info)
    return 0


# ----------------------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser(
        prog="restart-fleet",
        description="Restart pi lanes so a new bundle or launch env takes effect.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--dry-run", action="store_true", help="report what would happen, restart nothing")
    parser.add_argument("--only", action="append", default=None, metavar="PANE",
                        help="target only this pane (repeatable)")
    parser.add_argument("--interrupt-working", dest="interrupt_working", action="store_true",
                        help="send esc to working lanes, wait for idle, then restart")
    parser.add_argument("--working-only", dest="working_only", action="store_true",
                        help="target only currently working lanes; implies --interrupt-working")
    parser.add_argument("--idle-timeout", type=float, default=30.0,
                        help="seconds to wait for an interrupted lane to go idle (default 30)")
    parser.add_argument("--include-self", dest="include_self", action="store_true",
                        help="restart this lane too, deferred until this turn ends")
    parser.add_argument("--no-self-defer", dest="self_defer", action="store_false", default=True,
                        help="never schedule this lane's own restart")
    parser.add_argument("--self-timeout", type=float, default=24 * 3600.0,
                        help="how long a deferred self restart waits for this lane to idle")
    parser.add_argument("--bundle", default=str(DEFAULT_PI_ROOT),
                        help="pi install dir to verify against")
    parser.add_argument("--json", dest="as_json", action="store_true", help="machine-readable summary")

    # Internal: the detached self-restart helper.
    parser.add_argument("--deferred-self", metavar="PANE", help=argparse.SUPPRESS)
    parser.add_argument("--deferred-timeout", type=float, default=24 * 3600.0, help=argparse.SUPPRESS)
    parser.add_argument("--deferred-result", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.deferred_result and args.deferred_self:
        return run_deferred_self(args.deferred_self, args.deferred_timeout, Path(args.deferred_result))

    info = bundle_info(Path(args.bundle))
    if not info:
        print(f"REFUSE: cannot read a version from {args.bundle}/{VERSION_CHUNK}", file=sys.stderr)
        return 2
    bundle_mtime, bundle_version = info
    installed_at = datetime.fromtimestamp(bundle_mtime).strftime("%Y-%m-%d %H:%M:%S")

    lanes = list_lanes()
    if not lanes:
        print("REFUSE: herdr reported no pi lanes", file=sys.stderr)
        return 2

    self_pane = os.environ.get("HERDR_PANE_ID", "")
    if args.only:
        wanted = set(args.only)
        lanes = [lane for lane in lanes if lane.get("pane_id") in wanted]
        # An explicit request that matches nothing must never be silent: a lane mid-restart
        # is absent from herdr's list, so it is dropped here without a trace and the pass
        # looks complete. (Observed 2026-11-06: `--only w25:p1` reported `restarted 30,
        # failed 0` while never touching that lane.)
        seen = {lane.get("pane_id") for lane in lanes}
        for pane in sorted(wanted - seen):
            print(f"  WARN  {pane} was requested but herdr does not list it right now"
                  " (mid-restart?) — re-run --only for it after it settles", file=sys.stderr)
    if args.working_only:
        args.interrupt_working = True
        lanes = [lane for lane in lanes if lane.get("agent_status") == "working"]
    # This lane is never restarted inline: that would kill the turn reporting the result.
    inline = [lane for lane in lanes if lane.get("pane_id") != self_pane]
    self_lane = next((lane for lane in lanes if lane.get("pane_id") == self_pane), None)

    print(f"pi bundle {bundle_version} installed {installed_at}")
    print(f"lanes: {len(lanes)} matched, {len(inline)} inline"
          + (f", self {self_pane} deferred" if self_lane else "")
          + ("  [dry-run]" if args.dry_run else ""))

    probes = []
    for lane in inline:
        # A lane that just restarted reports `name: null` until pil (or the lane-names
        # repair timer) restores it. Derive the name from the tab label rather than
        # treating a transient as a reason to skip — the label is authoritative.
        if not lane.get("name"):
            for _ in range(6):
                time.sleep(2)
                fresh = next((item for item in list_lanes() if item.get("pane_id") == lane.get("pane_id")), None)
                if fresh and fresh.get("name"):
                    lane = fresh
                    break
        probes.append(probe(lane, bundle_mtime, bundle_version))
    stale = [p for p in probes if p.get("stale")]
    print(f"on old bundle: {len(stale)}   already current: {len(probes) - len(stale)}")
    if not args.only and not stale and not args.include_self:
        print("nothing to restart")
        return 0

    results = {"ok": 0, "skipped": 0, "failed": 0}
    details = []
    for lane_info in probes:
        # Default is reap-only: a lane already running the current bundle is left alone,
        # because restarting it buys nothing and costs its session. `--only` overrides
        # that (an explicit target is an explicit request).
        if not lane_info.get("stale") and not args.only:
            results["skipped"] += 1
            details.append({k: lane_info.get(k) for k in ("pane", "name", "status", "stale", "blockers", "warnings")}
                           | {"outcome": "current"})
            continue
        outcome = restart_lane(lane_info, dry_run=args.dry_run,
                               interrupt_working=args.interrupt_working,
                               idle_timeout=args.idle_timeout,
                               bundle_mtime=bundle_mtime, bundle_version=bundle_version)
        results[outcome] += 1
        details.append({k: lane_info.get(k) for k in ("pane", "name", "status", "stale", "blockers", "warnings")}
                       | {"outcome": outcome})

    self_result = None
    if self_lane is not None and args.include_self and args.self_defer and not args.dry_run:
        self_result = defer_self(self_pane, args.self_timeout, bundle_mtime, bundle_version)
        print(f"  DEFER {self_pane:9} this lane restarts after this turn ends; result -> {self_result}")
    elif self_lane is not None and args.include_self:
        print(f"  PLAN  {self_pane:9} deferred self restart"
              + (" (dry-run)" if args.dry_run else " (disabled)"))

    summary = {"bundle_version": bundle_version, "installed_at": installed_at,
               "self_pane": self_pane, "self_result": self_result, **results, "lanes": details}
    if args.as_json:
        print(json.dumps(summary, indent=1))
    else:
        print(f"\nrestarted {results['ok']}, skipped {results['skipped']}, failed {results['failed']}")
        if results["failed"]:
            print("re-run the failed lanes with --only <pane> and read the pane for the reason")
    return 0 if results["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
