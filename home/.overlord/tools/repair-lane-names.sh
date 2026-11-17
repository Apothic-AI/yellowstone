#!/usr/bin/env bash
# repair-lane-names — keep herdr agent names in sync with tab labels.
#
# Why: a herdr agent *name* is runtime detection state; the tab label is workspace state.
# `/new`, herdr's "reload config", and detach/re-attach all make herdr re-detect the agent
# and drop the name while the label survives — so a lane looks correct and cannot be reached
# by name. Observed 2026-11-01: 8 of 49 panes unnamed after one `/new` plus a detach, two of
# them leader lanes.
#
# The name is a pure function of the tab label, so identical labels collide: herdr refuses the
# second rename with `agent_name_taken`, pi-rooms silently suffixes the loser to `<name>-<pid>`,
# and `roles/<name>.env` / `supervise/<lane>.json` merge under the shared name. FT-81 measured a
# 155x FAILED loop from three one-pane tabs labelled `ft76-startup-probe` — the one-agent-per-tab
# rule does not cover that. So before renaming anything this script looks at the TABS: a label
# that several tabs share, or a tab holding more than one unnamed pane, is reported once (naming
# the colliding tabs and panes) and nothing in those tabs is renamed. A refusal that cannot
# succeed is written once with herdr's own error body and is not retried while its cause is still
# there. Timestamps are UTC and marked Z.
#
# Idempotent and quiet: nothing to do prints nothing. A numeric tab label is skipped, not
# renamed — herdr auto-names a fresh tab "1", and pil deliberately refuses those rather than
# baking a number into a lane identity.
#
# Usage: repair-lane-names [--dry-run]
#   --dry-run   report what would be renamed or refused; change nothing
# Env: LANE_NAMES_LOG / LANE_NAMES_STATE override the log and the suppression ledger (for tests).
case "${1:-}" in
  -h|--help)
    awk 'NR > 1 && /^#/ { sub(/^#[ ]?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 0
    ;;
esac
set -uo pipefail
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
LOG="${LANE_NAMES_LOG:-$HOME/.local/state/overlord/lane-names.log}"
STATE="${LANE_NAMES_STATE:-$HOME/.local/state/overlord/lane-names-state.json}"
python3 - "$LOG" "$STATE" "$DRY_RUN" <<'PY'
import datetime, json, os, re, subprocess, sys

LOG, STATE, DRY_RUN = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
# A refusal whose cause is visible in this run is never retried while the cause is there.
# Anything the CLI could have decided (a JSON error code) is permanent; a failure that never
# reached the CLI (no JSON body: socket, crash, timeout) is worth another attempt.
TRANSIENT = {"transport_error", "socket_error", "timeout", "unavailable", "busy",
             "server_error", "internal_error"}
RETRY_LOG_SECONDS = 900

os.makedirs(os.path.dirname(STATE) or ".", exist_ok=True)
log = open(LOG, "a", buffering=1)


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def say(kind, text, announce=False):
    line = "%s %s %s\n" % (stamp(), kind, text)
    log.write(line)
    if announce:
        sys.stdout.write(line)


def body_of(proc):
    for stream in (proc.stdout, proc.stderr):
        try:
            data = json.loads(stream)
        except Exception:
            continue
        if isinstance(data, dict):
            return data
    return None


def result_of(proc):
    data = body_of(proc)
    if isinstance(data, dict) and isinstance(data.get("result"), dict):
        return data["result"]
    return None


def error_of(proc):
    """(code, message): herdr's own error body when it answered, else the exit status."""
    data = body_of(proc)
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        return str(err.get("code") or "error"), str(err.get("message") or "")
    text = (proc.stderr or proc.stdout or "").strip().splitlines()
    return "exit%d" % proc.returncode, (text[0] if text else "no output")


def call(*args):
    try:
        return subprocess.run(("herdr",) + args, capture_output=True, text=True)
    except OSError as exc:
        say("error", "cannot run herdr %s: %s" % (" ".join(args), exc))
        return None


def load_state():
    try:
        with open(STATE) as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            for key in ("collisions", "skips", "failures"):
                if not isinstance(data.get(key), dict):
                    data[key] = {}
            return data
    except Exception:
        pass
    return {"version": 1, "collisions": {}, "skips": {}, "failures": {}}


def save_state(data):
    try:
        tmp = STATE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(data, fh, indent=1, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, STATE)
    except Exception as exc:
        say("error", "could not write %s: %s" % (STATE, exc))


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def usable(name):
    return bool(name) and name[0].isalpha()


def age_seconds(previous_at):
    try:
        then = datetime.datetime.strptime(previous_at or "", "%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    return (now - then).total_seconds()


proc = call("tab", "list")
if proc is None:
    raise SystemExit(0)
tabs = (result_of(proc) or {}).get("tabs")
if not isinstance(tabs, list):
    code, message = error_of(proc)
    say("error", "error reading tab list: %s: %s" % (code, message))
    raise SystemExit(0)

proc = call("agent", "list")
if proc is None:
    raise SystemExit(0)
agents = (result_of(proc) or {}).get("agents")
if not isinstance(agents, list):
    code, message = error_of(proc)
    say("error", "error reading agent list: %s: %s" % (code, message))
    raise SystemExit(0)

label_of, count_of, panes_of = {}, {}, {}
for tab in tabs:
    tid = tab.get("tab_id")
    if not tid:
        continue
    label_of[tid] = tab.get("label") or ""
    count_of[tid] = tab.get("pane_count", 0)
for agent in agents:
    panes_of.setdefault(agent.get("tab_id"), []).append(agent.get("pane_id"))
holders = {a.get("name"): a for a in agents if a.get("name")}
unnamed = [a for a in agents if not a.get("name")]

# Wanted name -> the tabs that would claim it. More than one tab is the FT-81 collision.
by_slug = {}
for tab in tabs:
    name = slug(label_of.get(tab.get("tab_id"), ""))
    if usable(name):
        by_slug.setdefault(name, []).append(tab)
dupes = {name: group for name, group in by_slug.items() if len(group) > 1}

state = load_state()
collisions = state["collisions"]
live = {}


def describe(tab):
    tid = tab.get("tab_id")
    panes = sorted(p for p in panes_of.get(tid, []) if p)
    if panes:
        return "%s (pane%s %s)" % (tid, "s" if len(panes) > 1 else "", ", ".join(panes))
    count = count_of.get(tid)
    if isinstance(count, int):
        return "%s (%d pane%s)" % (tid, count, "" if count == 1 else "s")
    return str(tid)


for name in sorted(dupes):
    group = sorted(dupes[name], key=lambda t: t.get("tab_id") or "")
    signature = name + ":" + ",".join(t.get("tab_id") or "?" for t in group)
    live[signature] = True
    if signature in collisions:
        continue
    say("duplicate-label",
        "tab label %r is shared by %d tabs — %s; all of them derive the name %r, so herdr can "
        "name only one, and roles/<name>.env and supervise/<lane>.json merge under it. Nothing "
        "in these tabs is renamed until one label changes."
        % (group[0].get("label") or "", len(group), ", ".join(describe(t) for t in group), name),
        announce=True)
    collisions[signature] = {"label": group[0].get("label") or "", "name": name,
                             "tabs": [t.get("tab_id") for t in group], "first_seen": stamp()}
for signature in sorted(set(collisions) - set(live)):
    gone = collisions.pop(signature)
    say("duplicate-label-resolved",
        "tabs %s no longer share the label %r — the name %r is available again"
        % (", ".join(gone.get("tabs") or []), gone.get("label") or "", gone.get("name") or ""),
        announce=True)

skips, failures = state["skips"], state["failures"]
new_skips, new_failures = {}, {}
renamed = refused = skipped = 0

for agent in unnamed:
    pane, tid = agent.get("pane_id") or "?", agent.get("tab_id")
    label = label_of.get(tid)
    if label is None and tid:
        proc = call("tab", "get", tid)
        tab = (result_of(proc) or {}).get("tab") if proc else None
        label = (tab or {}).get("label")
    if label is None:
        continue
    name = slug(label)
    if not usable(name):
        say("skip", "%s: tab label %r is not a name" % (pane, label))
        skipped += 1
        continue

    previous = failures.get(pane) or {}
    holder = holders.get(name)

    if name in dupes:
        signature = "duplicate-label:" + name
        if (skips.get(pane) or {}).get("signature") != signature:
            say("skip", "%s: tab %s label %r is one of %d tabs sharing it — not renamed; the "
                        "duplicate-label line names them"
                % (pane, tid, label, len(dupes[name])))
        new_skips[pane] = {"signature": signature, "at": stamp()}
        skipped += 1
        continue

    siblings = [x.get("pane_id") for x in unnamed if x.get("tab_id") == tid]
    if len(siblings) > 1 and pane != siblings[0]:
        signature = "same-tab:" + str(tid)
        if (skips.get(pane) or {}).get("signature") != signature:
            say("skip", "%s: %d panes in tab %s (label %r) would all take the name %r; %s takes "
                        "it and this pane is not renamed" % (pane, len(siblings), tid, label, name,
                                                            siblings[0]))
        new_skips[pane] = {"signature": signature, "at": stamp()}
        skipped += 1
        continue

    # A permanent refusal still stands while the tab label is unchanged. The one exception is
    # agent_name_taken: its cause can leave (the holder closed, or the duplicate label fixed), so
    # the holder is re-checked rather than remembered.
    if previous.get("slug") == name:
        code = str(previous.get("code") or "")
        permanent = bool(previous.get("permanent"))
        if permanent and not (code == "agent_name_taken" and not (holder or name in dupes)):
            new_failures[pane] = previous
            continue

    if DRY_RUN:
        say("would-rename", "%s -> %s" % (pane, name), announce=True)
        renamed += 1
        continue

    proc = call("agent", "rename", pane, name)
    if proc is None:
        continue
    data = body_of(proc)
    if proc.returncode == 0 and not (isinstance(data, dict) and data.get("error")):
        say("renamed", "%s -> %s" % (pane, name))
        renamed += 1
        continue

    refused += 1
    code, message = error_of(proc)
    permanent = code not in TRANSIENT and not code.startswith("exit")
    note, retry = "", ""
    if code == "agent_name_taken" and holder:
        note = " (held by %s in tab %s, labelled %r)" % (
            holder.get("pane_id"), holder.get("tab_id"),
            label_of.get(holder.get("tab_id"), "?"))
    if permanent:
        retry = " — not retried until %s" % (
            "the name is free again" if code == "agent_name_taken" else "the tab label changes")
    else:
        retry = " — will be retried"

    # A transient failure is expected to recur; say so once, not every minute.
    if (previous.get("slug") == name and previous.get("code") == code
            and not permanent and (age_seconds(previous.get("at")) or 0) < RETRY_LOG_SECONDS):
        new_failures[pane] = previous
        continue
    say("FAILED", "%s -> %s: %s: %s%s%s" % (pane, name, code, message, note, retry))
    new_failures[pane] = {"slug": name, "code": code, "message": message,
                          "permanent": permanent, "at": stamp()}

state["collisions"], state["skips"], state["failures"] = collisions, new_skips, new_failures
save_state(state)
if renamed or refused or skipped:
    sys.stderr.write("repair-lane-names: %d renamed, %d refused, %d skipped\n"
                     % (renamed, refused, skipped))
PY
