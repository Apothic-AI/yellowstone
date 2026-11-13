#!/usr/bin/env python3
"""broadcast-to-fleet — send one prompt or slash command to every herdr agent.

Enumerates the live agents from `herdr agent list` (every pane herdr reports as
running an agent harness) and submits the same text to each.

Two delivery paths, because they are not interchangeable:

  * A prompt (any text not starting with `/`) goes through `herdr agent prompt`,
    which types it and sends Enter. It starts a turn.
  * A slash command goes through `herdr agent send-keys`, one key at a time.
    `agent prompt` CANNOT deliver a slash command: the leading `/` opens the
    agent TUI's command palette, the typed text lands in the palette filter, and
    the prompt text is then submitted again as a user message — observed as
    `/reload /reload`, which is not a valid command and starts a turn instead of
    reloading. Keystrokes instead drive the palette to the real command and run
    it with one Enter, starting no turn.

Nothing here reports "delivered". For a prompt, the only proof is the lane's own
output. For a slash command the proof is the command's own confirmation line in
the pane (e.g. `Reloaded keybindings, extensions, skills, ...`) and a status that
never left idle; `--verify` reads both back and reports per lane.

Before the 2026-11-13 fix, --include-self /reload accidentally admitted every
working lane; a dry run showed SEND for working non-self leaders.

Prompting or typing into a `working` agent disturbs its in-flight turn. So by
default those lanes are skipped and reported; pass --end-agent-turns to accept
that, which sends `esc` to every target first.

Usage:
  broadcast-to-fleet --message '/reload'
  broadcast-to-fleet --message '/reload' --dry-run
  broadcast-to-fleet --message 'Status check: reply with your current goal state.' --end-agent-turns
  broadcast-to-fleet --message '/reload' --interrupt-working --verify
  broadcast-to-fleet --message '/reload' --working-only --verify
  broadcast-to-fleet --message '/reload' --include-self
  broadcast-to-fleet --message '/reload' --only wE:p1 --only w18:pA

Exit: 0 every targeted send accepted, 1 some failed, 2 usage or enumeration error.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time

HERDR = "herdr"
DEFAULT_TIMEOUT = 10.0
DEFAULT_SELF_RELOAD_TIMEOUT = 24 * 60 * 60
SETTLE_AFTER_ESC = 0.6  # let the agent redraw before the message lands
# How many trailing pane lines count as "fresh output" when confirming a
# command. Small on purpose: see the baseline comment in send_slash.
TAIL_LINES = 8
# How long to wait for the command palette to render the filtered row. A poll,
# not a fixed sleep: heavy lanes take seconds to paint it.
PALETTE_TIMEOUT = 6.0
PALETTE_SETTLE = 0.25  # let the palette filter before reading it back

# Completion line each slash command prints, for --verify. A command MISSING from this
# map has no reliable line (measured 2026-11-04: /compact only ever prints
# "Compaction cancelled" on failure, and otherwise just redraws the footer), so --verify
# reports it as NOT VERIFIABLE. Defaulting to one command's string makes every other
# command look like a failure — that is what reported `0/2` for two compactions that
# had in fact succeeded.
CONFIRMATIONS = {
    "/reload": "Reloaded",
}
# Commands that would destroy context or exit the agent if broadcast by mistake.
DESTRUCTIVE = {"/new", "/clear", "/quit", "/exit", "/compact"}
ARROW_MARKS = ("\u2192", "\u203a", ">")


def run(args: list[str], timeout: float) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except OSError as exc:
        return False, str(exc)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip().splitlines()
        return False, err[0][:120] if err else f"exit {proc.returncode}"
    return True, proc.stdout


def list_agents() -> list[dict]:
    rc, out = run([HERDR, "agent", "list"], 20.0)
    if not rc:
        raise SystemExit("broadcast-to-fleet: could not read the agent list")
    try:
        return json.loads(out)["result"]["agents"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise SystemExit(f"broadcast-to-fleet: unexpected agent list shape ({exc})")


def status_of(pane: str, timeout: float) -> str:
    rc, out = run([HERDR, "agent", "get", pane], timeout)
    if not rc:
        return "unknown"
    try:
        return (json.loads(out)["result"]["agent"]["agent_status"] or "").lower()
    except (json.JSONDecodeError, KeyError, TypeError):
        return "unknown"


def read_pane(pane: str, timeout: float) -> str:
    rc, out = run([HERDR, "agent", "read", pane], timeout)
    return out if rc else ""


def type_keys(text: str) -> list[str]:
    """Turn text into `send-keys` arguments, one keyboard key per element.

    `send-keys` rejects a multi-character argument (`unsupported key abc def`), so the text
    is sent character by character. A LITERAL " " argument is silently dropped, though: it
    does not error and does not type anything, so `list('/profile reload')` produced
    `/profilereload` — the palette matched no such command and the text was submitted as a
    user message instead (observed 2026-11-07). The bare word `space` is the key that types
    a real space.
    """
    return ["space" if ch == " " else ch for ch in text]


def composer_holds(message: str, pane: str, timeout: float) -> bool:
    """True when the composer line holds exactly `message` — the text Enter will submit.

    Added 2026-11-08. The palette highlight is a PROXY for "Enter will run what we typed",
    and it is absent for a slash command WITH AN ARGUMENT: the palette filters on the whole
    typed string, so `/profile reload` matches no row and `highlighted` stays empty — while
    the command runs correctly. Verified on a throwaway lane: `/profile reload` + Enter
    printed "profile reloaded: leader". Requiring a palette row made 21/21 `/profile reload`
    sends "fail" with the command itself fine, so the composer — the artifact Enter acts on —
    is now checked as well.
    """
    lines = [l for l in read_pane(pane, timeout).splitlines() if l.lstrip().startswith("\u2502")]
    if not lines:
        return False
    return lines[-1].strip().strip("\u2502").strip() == message


def send_slash(pane: str, message: str, timeout: float,
               confirm: str | None = None) -> tuple[bool, str, bool]:
    """Drive the agent's command palette with keystrokes and run the command.

    Clears the input line, types `/` plus the command so the palette filters to
    it, confirms the palette highlights a matching row, then submits with one
    Enter. Any mismatch aborts with `esc` rather than pressing Enter on whatever
    happens to be highlighted.

    Returns (sent, error, confirmed). `confirmed` is only meaningful when the
    command prints a completion line: it polls for one more `confirm` line than
    the pane held before the command ran, so a stale confirmation cannot pass.
    """
    if message.split()[:2] == ["/profile", "reload"]:
        return False, "refused: /profile reload can be submitted as a user prompt", False
    body = message[1:]
    token = body.split()[0] if body.split() else ""
    keys = ["/"] + type_keys(body)

    # Baseline from the LAST FEW LINES only. A whole-window count passes when a stale
    # confirmation scrolls *in* and fails when a real one scrolls *out*; the tail is what
    # the command itself is about to write to, so a new line there is the only honest signal.
    before_tail = read_pane(pane, timeout).rstrip().splitlines()[-TAIL_LINES:]
    baseline = sum(1 for line in before_tail if confirm in line) if confirm else 0

    ok, err = run([HERDR, "agent", "send-keys", pane, "ctrl+u"], timeout)
    if not ok:
        return False, f"clear input: {err}", False
    ok, err = run([HERDR, "agent", "send-keys", pane, *keys], timeout)
    if not ok:
        return False, f"type/command: {err}", False
    # POLL for the highlight — do not sleep once and read once. A single fixed sleep
    # (0.25 s) is a bet that the palette renders faster than it, and on heavy lanes it does
    # not: measured 2026-11-02 on w1Z:p1 (30M context, 13 s ttft), the `→ reload` row was
    # present and inside the read window, but only after a real delay — the single check
    # ran too early, the tool dismissed the palette, and it reported "did not highlight"
    # on a lane where the palette worked fine. Deadline instead of a guess.
    highlighted = []
    deadline = time.time() + PALETTE_TIMEOUT
    while True:
        tail = read_pane(pane, timeout).splitlines()[-30:]
        highlighted = [
            line for line in tail if line.strip().startswith(ARROW_MARKS)
        ]
        if token and any(token in line for line in highlighted):
            break
        if time.time() >= deadline:
            break
        time.sleep(0.2)

    if not token or not any(token in line for line in highlighted):
        if message.startswith("/") and composer_holds(message, pane, timeout):
            # No palette row, but the composer holds exactly the command we intended, so
            # Enter submits that and nothing else. Fall through rather than dismissing.
            highlighted = [f"composer:{message}"]
    if not token or not any(token in line for line in highlighted):
        # `esc` closes the palette but LEAVES THE TYPED TEXT in the composer, where the
        # next thing anyone types joins it. Clear the input after dismissing, so a
        # palette miss cannot leave a lane holding a command that was never submitted
        # (2026-11-02: two lanes sat with an unsent `/reload` for ~10 minutes, and the
        # aggregate "verified 24/26" read as if they had reloaded).
        run([HERDR, "agent", "send-keys", pane, "esc"], timeout)
        run([HERDR, "agent", "send-keys", pane, "ctrl+u"], timeout)
        return False, f"palette did not highlight {message!r} (input cleared)", False

    ok, err = run([HERDR, "agent", "send-keys", pane, "Enter"], timeout)
    if not ok:
        return False, f"submit: {err}", False

    if status_of(pane, timeout) == "working":
        return False, "started a turn instead of running the command", False

    confirmed = False
    if confirm:
        # The confirmation is TRANSIENT AND IT FLICKERS: measured on 2026-11-02 by sampling
        # every 150 ms after Enter, it was present at 150/300/450 ms, absent 600-1200 ms, then
        # present again from 1350 ms. Polling on a fixed offset can therefore miss a reload
        # that really happened, so sample fast and accept the FIRST hit — and equally, a miss
        # does NOT prove the command did not run.
        for _ in range(50):  # ~5s at 100 ms, fast enough to land in a flicker window
            now_tail = read_pane(pane, timeout).rstrip().splitlines()[-TAIL_LINES:]
            if sum(1 for line in now_tail if confirm in line) > baseline:
                confirmed = True
                break
            time.sleep(0.1)
    return True, "", confirmed


def plan(agents: list[dict], self_pane: str | None, include_self: bool,
         include_working: bool, only: list[str], working_only: bool = False,
         slash: bool = False, defer_working_self: bool = False) -> tuple[list[dict], list[dict], list[dict]]:
    """Return (targets, skipped_working, skipped_harness).

    `/reload` is a pi command; a droid or opencode lane has no such palette entry,
    so slash commands are confined to pi targets instead of failing per lane.
    """
    wanted = set(only)
    targets: list[dict] = []
    skipped: list[dict] = []
    other: list[dict] = []
    for agent in agents:
        pane = agent.get("pane_id") or ""
        if not pane:
            continue
        if wanted:
            if pane not in wanted:
                continue
        elif pane == self_pane and not include_self:
            continue
        status = (agent.get("agent_status") or "").lower()
        harness = (agent.get("agent") or "").lower()
        entry = {"pane": pane, "name": agent.get("name") or "-", "status": status}
        if slash and harness != "pi":
            other.append({**entry, "harness": harness or "unknown"})
        elif working_only and status != "working":
            continue
        elif status not in {"idle", "done", "working"} and not (defer_working_self and pane == self_pane):
            skipped.append(entry)
        elif status == "working" and not include_working and not (defer_working_self and pane == self_pane):
            skipped.append(entry)
        else:
            targets.append({**entry, "was_working": status == "working"})
    targets.sort(key=lambda a: a["pane"])
    skipped.sort(key=lambda a: a["pane"])
    other.sort(key=lambda a: a["pane"])
    return targets, skipped, other


def reload_result_dir() -> pathlib.Path:
    root = pathlib.Path(os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state"))
    result = root / "pil" / "reload-results"
    result.mkdir(parents=True, exist_ok=True)
    return result


def write_reload_result(path: str, state: str, pane: str, **extra: str) -> None:
    target = pathlib.Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {"state": state, "pane": pane, "updatedAt": time.time(), **extra}
    temporary = target.with_name(f".{target.name}.tmp.{os.getpid()}")
    temporary.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(target)


def reload_when_idle(
    pane: str,
    timeout: float,
    poll_interval: float = 0.5,
    result_path: str | None = None,
) -> int:
    """Wait for a Pi pane to become idle, reload it, and persist the outcome."""
    if result_path is not None:
        write_reload_result(result_path, "waiting", pane)
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = status_of(pane, DEFAULT_TIMEOUT)
        if status == "idle":
            if result_path is not None:
                write_reload_result(result_path, "reloading", pane)
            sent, err, confirmed = send_slash(
                pane, "/reload", DEFAULT_TIMEOUT, CONFIRMATIONS["/reload"]
            )
            if not sent:
                if result_path is not None:
                    write_reload_result(result_path, "failed", pane, error=err)
                print(f"deferred self reload failed for {pane}: {err}", file=sys.stderr)
                return 1
            if not confirmed:
                message = "reload command sent but confirmation was not observed"
                if result_path is not None:
                    write_reload_result(result_path, "failed", pane, error=message)
                print(f"deferred self reload was not confirmed for {pane}", file=sys.stderr)
                return 1
            if result_path is not None:
                write_reload_result(result_path, "confirmed", pane)
                write_reload_result(result_path, "waking", pane)
            wake_message = (
                "[self-scheduled wake after confirmed fleet reload; not an operator instruction] "
                "The deferred self-reload completed. Check the durable reload result and current "
                "lane state, then stop; do not repeat the fleet reload."
            )
            woken, wake_error = run([HERDR, "agent", "prompt", pane, wake_message], DEFAULT_TIMEOUT)
            if not woken:
                if result_path is not None:
                    write_reload_result(result_path, "wake_failed", pane, error=wake_error)
                print(f"deferred self reload confirmed but wake failed for {pane}: {wake_error}", file=sys.stderr)
                return 1
            if result_path is not None:
                write_reload_result(result_path, "woken", pane)
            print(f"deferred self reload confirmed and lane woken for {pane}")
            return 0
        time.sleep(poll_interval)
    message = f"idle timeout after {timeout:g}s"
    if result_path is not None:
        write_reload_result(result_path, "failed", pane, error=message)
    print(f"deferred self reload timed out waiting for idle: {pane}", file=sys.stderr)
    return 1


def defer_self_reload(pane: str, timeout: float) -> str:
    """Spawn a detached helper and return its durable result path."""
    safe_pane = "".join(char if char.isalnum() else "-" for char in pane).strip("-")
    result_path = str(reload_result_dir() / f"self-{safe_pane}-{int(time.time() * 1000)}.json")
    subprocess.Popen(
        [sys.executable, str(pathlib.Path(__file__).resolve()),
         "--deferred-self-reload", pane, "--deferred-timeout", str(timeout),
         "--deferred-result", result_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    return result_path


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="broadcast-to-fleet",
        description="Send one prompt or slash command to every herdr agent.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--deferred-self-reload", metavar="PANE", help=argparse.SUPPRESS)
    parser.add_argument("--deferred-timeout", type=float, default=DEFAULT_SELF_RELOAD_TIMEOUT, help=argparse.SUPPRESS)
    parser.add_argument("--deferred-result", help=argparse.SUPPRESS)
    parser.add_argument("-m", "--message", required=False,
                        help="text to send; leading / makes it a slash command")
    parser.add_argument("--end-agent-turns", "--end_agent_turns",
                        dest="end_turns", action="store_true",
                        help="legacy alias: interrupt working lanes, wait for idle, then deliver")
    parser.add_argument("--interrupt-working", "--interrupt",
                        dest="interrupt_working", action="store_true",
                        help="include lanes observed working, send esc, wait for idle, then deliver")
    parser.add_argument("--working-only", "--only-working",
                        dest="working_only", action="store_true",
                        help="target only lanes observed working; implies --interrupt-working")
    parser.add_argument("--idle-timeout", type=float, default=30.0,
                        help="seconds to wait for each interrupted lane to become idle (default 30)")
    parser.add_argument("--dry-run", "--list", dest="dry_run", action="store_true",
                        help="show targets and send nothing")
    parser.add_argument("--include-self", dest="include_self", action="store_true",
                        help="include this session's own pane")
    parser.add_argument("--only", action="append", default=None, metavar="PANE",
                        help="target only this pane (repeatable)")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                        help=f"per-command timeout in seconds (default {DEFAULT_TIMEOUT:g})")
    parser.add_argument("--verify", dest="verify", action="store_true",
                        help="read each pane back; for /reload require its confirmation line")
    parser.add_argument("--allow-destructive", dest="allow_destructive",
                        action="store_true",
                        help=f"permit {', '.join(sorted(DESTRUCTIVE))} fleet-wide")
    args = parser.parse_args()
    if args.deferred_self_reload:
        return reload_when_idle(
            args.deferred_self_reload,
            max(0.0, args.deferred_timeout),
            result_path=args.deferred_result,
        )
    if not args.message:
        parser.error("-m/--message is required")

    message = args.message
    if not message.strip():
        parser.error("--message must not be empty")

    is_slash = message.startswith("/")
    if is_slash:
        head = message.split()[0]
        if head in DESTRUCTIVE and not args.allow_destructive:
            parser.error(f"{head} destroys context fleet-wide; pass --allow-destructive")

    if args.end_turns and message.split()[0] == "/reload":
        parser.error("use --interrupt-working or --working-only for /reload")
    if message.split()[0] == "/reload" and not args.dry_run and not args.verify:
        parser.error("/reload requires --verify or --dry-run/--list")
    if args.end_turns and args.interrupt_working:
        parser.error("--end-agent-turns and --interrupt-working are aliases; choose one")
    if args.working_only and args.only:
        parser.error("--working-only cannot be combined with --only")
    interrupt_working = args.interrupt_working or args.end_turns or args.working_only
    self_pane = os.environ.get("HERDR_PANE_ID")
    if message.split()[0] == "/reload" and args.include_self and not self_pane:
        parser.error("cannot safely defer self reload: HERDR_PANE_ID is unset")
    agents = list_agents()
    self_reload = (
        bool(self_pane)
        and message.split()[0] == "/reload"
        and (args.include_self or self_pane in (args.only or []))
    )
    targets, skipped, other = plan(
        agents, self_pane, args.include_self, interrupt_working,
        args.only or [], working_only=args.working_only, slash=is_slash,
        defer_working_self=self_reload,
    )
    deferred_self = next((t for t in targets if t["pane"] == self_pane), None)
    if deferred_self and message.split()[0] == "/reload":
        targets = [t for t in targets if t["pane"] != self_pane]

    kind = "slash command" if is_slash else "prompt"
    preview = message if len(message) <= 60 else message[:57] + "..."

    if not targets and not skipped and not other and not deferred_self:
        print(f"broadcast-to-fleet: no targets (agents seen: {len(agents)}, "
              f"self: {self_pane or 'unset'})")
        return 0

    if args.dry_run:
        print(f"would send {kind} to {len(targets) + bool(deferred_self)} agent(s): {preview}")
        if deferred_self:
            print(f"  DEFER {deferred_self['pane']:<10} {deferred_self['name']:<24} until this turn returns")
        for t in targets:
            print(f"  SEND  {t['pane']:<10} {t['name']:<24} {t['status']}")
        if skipped:
            print(f"skipping {len(skipped)} working or unknown-status lane(s) — pass --interrupt-working for working lanes:")
            for s in skipped:
                print(f"  SKIP  {s['pane']:<10} {s['name']:<24} {s['status']}")
        if other:
            print(f"skipping {len(other)} non-pi lane(s) — a slash command needs pi:")
            for o in other:
                print(f"  SKIP  {o['pane']:<10} {o['name']:<24} {o['harness']}")
        return 0

    interrupted = [t for t in targets if t.get("was_working") and t is not deferred_self]
    ready: list[dict] = [t for t in targets if not t.get("was_working")]
    if interrupt_working and interrupted:
        esc_ok = 0
        esc_sent: set[str] = set()
        for t in interrupted:
            rc, err = run([HERDR, "agent", "send-keys", t["pane"], "esc"], args.timeout)
            if rc:
                esc_ok += 1
                esc_sent.add(t["pane"])
            else:
                print(f"  esc failed {t['pane']}: {err}", file=sys.stderr)
        print(f"broadcast-to-fleet: esc sent to {esc_ok}/{len(interrupted)} working lane(s)")

        deadline = time.time() + max(0.0, args.idle_timeout)
        # Only a confirmed Esc may enter the idle barrier. A failed status read
        # is also fail-closed: unknown lanes are never sent a command.
        pending = {}
        for t in interrupted:
            if t["pane"] not in esc_sent:
                continue
            status = status_of(t["pane"], args.timeout)
            if status == "working":
                pending[t["pane"]] = t
            elif status == "idle":
                ready.append(t)
            else:
                print(f"  not ready {t['pane']}: status is {status or 'unknown'}", file=sys.stderr)
        while pending and time.time() < deadline:
            for pane in list(pending):
                status = status_of(pane, args.timeout)
                if status == "idle":
                    ready.append(pending.pop(pane))
                elif status not in {"working", "idle"}:
                    print(f"  not ready {pane}: status is {status or 'unknown'}", file=sys.stderr)
                    pending.pop(pane)
            if pending:
                time.sleep(0.2)
        if pending:
            for pane in sorted(pending):
                print(f"  not ready {pane}: idle timeout after {args.idle_timeout:g}s", file=sys.stderr)
        not_ready = len(targets) - len(ready)
        print(f"broadcast-to-fleet: {len(ready)}/{len(targets)} lanes ready after idle barrier")
    elif interrupted:
        # This branch is only reachable for callers of plan() outside main.
        ready.extend(interrupted)

    ready.sort(key=lambda a: a["pane"])
    timed_out = len(targets) - len(ready) if interrupt_working else 0
    ok = 0
    failed: list[tuple[str, str]] = []
    confirmed: list[str] = []
    unconfirmed: list[str] = []
    not_verifiable: list[str] = []
    confirm_line = CONFIRMATIONS.get(message.split()[0]) if is_slash else None
    for t in ready:
        current_status = status_of(t["pane"], args.timeout)
        if current_status not in ({"idle"} if interrupt_working else {"idle", "done"}):
            failed.append((t["pane"], f"pre-delivery status is {current_status or 'unknown'}; skipped"))
            timed_out += 1
            continue
        if is_slash:
            sent, err, seen = send_slash(t["pane"], message, args.timeout, confirm_line)
            if sent and seen and message.split()[0] == "/reload" and t.get("was_working") and interrupt_working:
                nudge = ("Your turn was interrupted for a Pi reload. Inspect the current state and "
                         "continue the interrupted task from where it left off. Do not repeat "
                         "actions that may already have completed.")
                nudged, nudge_err = run([HERDR, "agent", "prompt", t["pane"], nudge], args.timeout)
                if not nudged:
                    failed.append((t["pane"], f"reload succeeded, resume nudge failed: {nudge_err}"))
            if not sent:
                pass  # counted as failed below
            elif confirm_line is None:
                not_verifiable.append(t["pane"])
            elif seen:
                confirmed.append(t["pane"])
            else:
                unconfirmed.append(t["pane"])
        else:
            sent, err = run([HERDR, "agent", "prompt", t["pane"], message], args.timeout)
        if sent:
            ok += 1
        else:
            failed.append((t["pane"], err))
        time.sleep(0.1)  # pacing only

    if deferred_self and not args.dry_run:
        try:
            result_path = defer_self_reload(deferred_self["pane"], max(args.idle_timeout, DEFAULT_SELF_RELOAD_TIMEOUT))
            print(f"broadcast-to-fleet: deferred self reload for {deferred_self['pane']} until this turn returns")
            print(f"broadcast-to-fleet: self reload result {result_path}")
        except OSError as exc:
            failed.append((deferred_self["pane"], f"could not schedule deferred self reload: {exc}"))

    print(f"broadcast-to-fleet: {ok} sent, {len(failed)} failed, "
          f"{len(skipped) + timed_out} skipped (working/not-ready)")
    for pane, err in failed:
        print(f"  FAILED {pane}: {err}", file=sys.stderr)
    if skipped and not interrupt_working:
        print("skipped (working or unknown; pass --interrupt-working for working lanes): "
              + " ".join(s["pane"] for s in skipped))
    if other:
        print("skipped (non-pi harness, no slash commands): "
              + " ".join(f"{o['pane']}({o['harness']})" for o in other))

    if args.verify and is_slash:
        if confirm_line is None:
            print(f"broadcast-to-fleet: {ok} sent; {message.split()[0]} prints no "
                  f"confirmation line, so delivery is unverified — check the effect "
                  f"itself (e.g. leader-board.py context %).")
        else:
            print(f"broadcast-to-fleet: verified {len(confirmed)}/{len(ready)} panes "
                  f"showing the command's confirmation")
            if unconfirmed:
                print("  unconfirmed: " + " ".join(unconfirmed))
        if not_verifiable and confirm_line is not None:
            print("  not verifiable: " + " ".join(not_verifiable))

    return 0 if not failed and timed_out == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
