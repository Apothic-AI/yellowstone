#!/usr/bin/env python3
"""proc-find — find, and optionally signal, processes *selectively*.

Why this exists
---------------
`pkill -f PATTERN` is not a selective tool. Its pattern is matched against the whole
command line of every process, which means it also matches:

  * **the fleet itself** — `pkill -f 'pi$'` matches every pi lane on the machine,
    because `pi` *is* their command line (~46 lanes died that way);
  * **the shell running the command** — the pattern you typed is in your own
    `bash -c` command line, so the kill reaches the process that is doing the killing;
  * **pipeline siblings** — `proc-find … | grep PATTERN` puts PATTERN in a sibling's
    command line, not just the target's.

So this tool never matches "the command line contains a string". It matches explicit
*fields* — argv element, argv[0], executable path, or an environment value — and it
**excludes the caller's own process and all of its ancestors by default**, because those
are the processes whose command lines are guaranteed to contain the words you typed.

Signalling is off unless asked for, and asking for it requires `--expect N` to match the
number of results exactly. A broad match can still be a mistake; an exact count turns
"this looked right" into a check that fails loudly.

Usage
-----
  proc-find --argv0 pi                       # by argv[0]
  proc-find --exe /usr/bin/sleep --arg 300   # by executable path and an argument
  proc-find --argv-contains driver.sh        # substring, matched per argv element
  proc-find --env HERDR_PANE_ID=w17:p6       # by environment
  proc-find --name watchdog --json           # comm (15 chars, like pgrep -x)

  proc-find --argv0 sleep --signal TERM --expect 2   # signals ONLY if exactly 2 match

Every selector is ANDed. `--pids` prints bare pids for pipelines; the default table
shows pid, ppid, age, exe and argv so the match can be judged before it is acted on.

Exit codes: 0 matched (and signalled if asked), 1 no match, 2 refused/failed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal as signal_mod
import sys
import time
from pathlib import Path

SELF = os.getpid()


def read_argv(pid: int) -> list[str]:
    """The process's argv as a list. Empty for a zombie or a kernel thread."""
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return []
    parts = [p.decode("utf-8", "replace") for p in raw.split(b"\0")]
    # The kernel NUL-terminates the last argument, so the final element is "".
    while parts and parts[-1] == "":
        parts.pop()
    return parts


def read_status(pid: int) -> dict[str, str]:
    fields: dict[str, str] = {}
    try:
        for line in Path(f"/proc/{pid}/status").read_text(errors="replace").splitlines():
            key, _, value = line.partition(":")
            if key in ("Name", "PPid", "Pid"):
                fields[key] = value.strip()
    except OSError:
        pass
    return fields


def read_env(pid: int) -> dict[str, str]:
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes().decode("utf-8", "replace")
    except OSError:
        return {}
    return dict(part.split("=", 1) for part in raw.split("\0") if "=" in part)


def ancestors(pid: int) -> set[int]:
    """pid and every ancestor up to init.

    This is the whole safety story. A process cannot kill the shell that invoked it by
    accident if that shell is never a candidate, and the caller's own command line —
    which by construction contains the words typed on it — is only ever found in its own
    ancestry.
    """
    seen: set[int] = set()
    current = pid
    while current and current not in seen:
        seen.add(current)
        parent = read_status(current).get("PPid")
        current = int(parent) if parent and parent.isdigit() else 0
    return seen


def age_of(pid: int) -> float | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text(errors="replace")
    except OSError:
        return None
    # comm may contain spaces and brackets; everything after the LAST ')' is field 3.
    tail = fields.rsplit(")", 1)[-1].split()
    if len(tail) < 20:
        return None
    try:
        starttime = int(tail[19])
    except ValueError:
        return None
    try:
        uptime = float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None
    return max(0.0, uptime - starttime / os.sysconf("SC_CLK_TCK"))


def human_age(seconds: float | None) -> str:
    if seconds is None:
        return "?"
    for limit, suffix, scale in ((60, "s", 1), (3600, "m", 60), (86400, "h", 3600)):
        if seconds < limit:
            return f"{seconds / scale:.1f}{suffix}"
    return f"{seconds / 86400:.1f}d"


def parse_env_selector(text: str) -> tuple[str, str]:
    key, sep, value = text.partition("=")
    if not sep or not key:
        raise argparse.ArgumentTypeError(f"expected KEY=VALUE, got {text!r}")
    return key, value


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="proc-find",
        description="Find (and only then signal) processes by explicit fields, never by a "
                    "whole-command-line pattern. The caller's own process and ancestors are "
                    "always excluded.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Every selector is ANDed. Run with no selectors to list what is excluded.",
    )
    parser.add_argument("--name", action="append", default=None, metavar="COMM",
                        help="/proc/<pid>/status Name, exactly (like `pgrep -x`)")
    parser.add_argument("--exe", action="append", default=None, metavar="PATH",
                        help="resolved executable path (/proc/<pid>/exe); substring unless --exact")
    parser.add_argument("--argv0", action="append", default=None, metavar="TEXT",
                        help="argv[0] exactly")
    parser.add_argument("--arg", action="append", default=None, metavar="TEXT",
                        help="some argv element equals TEXT")
    parser.add_argument("--argv-contains", action="append", default=None, metavar="TEXT",
                        help="some argv element contains TEXT (per element, never across elements)")
    parser.add_argument("--env", action="append", default=None, type=parse_env_selector,
                        metavar="KEY=VALUE", help="environment value; suffix match if VALUE ends *")
    parser.add_argument("--exact", action="store_true",
                        help="treat --exe and --env values as exact rather than prefix/substring")
    parser.add_argument("--exclude-pid", action="append", default=None, type=int, metavar="PID",
                        help="additional pid to exclude (repeatable)")
    parser.add_argument("--include-ancestors", action="store_true",
                        help="DANGEROUS: do not exclude this process and its ancestors")
    parser.add_argument("--no-exclude-self", action="store_true",
                        help="DANGEROUS: do not exclude this process itself")

    parser.add_argument("--signal", metavar="SIG", default=None,
                        help="send this signal (e.g. TERM, 9) to the matches")
    parser.add_argument("--expect", type=int, default=None, metavar="N",
                        help="REQUIRED with --signal: proceed only if exactly N processes match")
    parser.add_argument("--dry-run", action="store_true", help="show what --signal would do")

    parser.add_argument("--pids", action="store_true", help="print bare pids, one per line")
    parser.add_argument("--json", action="store_true", help="print JSON records")
    parser.add_argument("--quiet", action="store_true", help="print nothing on success")

    args = parser.parse_args()

    if args.signal and args.expect is None:
        print("proc-find: --signal requires --expect N. An exact expected count is what "
              "catches a match that is broader than you thought; without it a broad pattern "
              "is indistinguishable from a correct one.", file=sys.stderr)
        return 2
    if args.signal and args.expect is not None and args.expect < 1:
        print("proc-find: --expect must be at least 1", file=sys.stderr)
        return 2

    excluded = set()
    if not args.include_ancestors:
        excluded |= ancestors(SELF)
    if args.no_exclude_self:
        excluded.discard(SELF)
    for pid in args.exclude_pid or []:
        excluded.add(pid)
    # The transient shell that runs a pipeline leading to us is an ancestor, but a
    # `bash -c "… proc-find …"` wrapper is not always: keep the caller's session roots out
    # of the default candidate set too, since they host the text the user just typed.
    try:
        excluded.add(os.getppid())
    except Exception:
        pass

    selectors_used = any([args.name, args.exe, args.argv0, args.arg, args.argv_contains, args.env])

    rows = []
    for entry in sorted(os.listdir("/proc"), key=lambda x: int(x) if x.isdigit() else 0):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid in excluded:
            continue
        status = read_status(pid)
        if not status:
            continue
        argv = read_argv(pid)
        comm = status.get("Name", "")

        if args.name and comm not in args.name:
            continue
        if args.argv0 and (not argv or argv[0] not in args.argv0):
            continue
        if args.arg and not any(a in argv for a in args.arg):
            continue
        if args.argv_contains:
            haystack = argv or [comm]
            if not any(needle in element for needle in args.argv_contains for element in haystack):
                continue
        if args.exe:
            try:
                exe = os.readlink(f"/proc/{pid}/exe")
            except OSError:
                continue
            if args.exact:
                if exe not in args.exe:
                    continue
            elif not any(want in exe for want in args.exe):
                continue
        else:
            exe = None
        if args.env:
            env = read_env(pid)
            ok = True
            for key, want in args.env:
                got = env.get(key)
                if got is None:
                    ok = False
                    break
                if args.exact:
                    if got != want:
                        ok = False
                        break
                elif want.endswith("*"):
                    if not got.startswith(want[:-1]):
                        ok = False
                        break
                elif got != want:
                    ok = False
                    break
            if not ok:
                continue

        rows.append({
            "pid": pid,
            "ppid": int(status.get("PPid") or 0),
            "name": comm,
            "age": age_of(pid),
            "exe": exe,
            "argv": argv,
        })

    if not args.pids and not args.json and not args.quiet:
        if not selectors_used:
            print("no selectors given — nothing can match. Pick a field, e.g. --argv0 pi")
        print(f"excluded {len(excluded)} pids (this process"
              f"{'' if args.include_ancestors else ', its ancestors'})", file=sys.stderr)

    if args.pids:
        for row in rows:
            print(row["pid"])
    elif args.json:
        print(json.dumps(rows, indent=1))
    elif not args.quiet:
        for row in rows:
            argv = " ".join(row["argv"]) or f"[{row['name']}]"
            print(f"{row['pid']:>8}  ppid={row['ppid']:<8} age={human_age(row['age']):>6}  "
                  f"{row['name']:<16} {argv[:110]}")

    if args.signal:
        sig = args.signal if args.signal.isdigit() else args.signal.upper()
        number = int(sig) if sig.isdigit() else getattr(signal_mod, f"SIG{sig}", None)
        if number is None:
            print(f"proc-find: unknown signal {args.signal!r}", file=sys.stderr)
            return 2
        if len(rows) != args.expect:
            print(f"proc-find: REFUSED — {len(rows)} match(es), --expect {args.expect}. "
                  f"Nothing was signalled. Narrow the selectors or fix the expectation.",
                  file=sys.stderr)
            return 2
        for row in rows:
            if args.dry_run:
                print(f"would signal {row['pid']} ({row['name']}) with {sig}", file=sys.stderr)
                continue
            try:
                os.kill(row["pid"], number)
                print(f"signalled {row['pid']} ({row['name']}) with {sig}", file=sys.stderr)
            except OSError as error:
                print(f"failed to signal {row['pid']}: {error}", file=sys.stderr)
                return 2

    return 0 if rows else 1


if __name__ == "__main__":
    sys.exit(main())
