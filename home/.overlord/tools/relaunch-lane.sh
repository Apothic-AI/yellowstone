#!/usr/bin/env bash
# relaunch-lane — move a bare-`pi` leader lane onto the profiled launcher.
#
# Why: a lane gets a profile only when its process starts through `pil`. A bare `pi`
# process keeps the fleet-wide `fleet` selection at best, and 69/71 lanes here still
# run bare `pi` from before the launcher existed. `/reload` does not help — profile
# resolution happens at exec, so this is restart or nothing.
#
# Contract, learned the hard way:
#   * `pil` derives the lane name from the TAB LABEL of the pane it runs in. So this
#     script must run pil *inside* the target pane (`herdr pane run <pane> pil`) and
#     must NEVER run `pil` from the caller's own pane: that makes a child claim the
#     caller's name, and its leave-and-join deregisters the live lane.
#   * The lane must be idle/done first. Quitting a `working` lane kills an in-flight
#     turn; quitting a goal lane pauses its goal.
#   * Verify from the footer (`profile:` / `rooms:`), never from the exit code.
#
# Usage:
#   tools/relaunch-lane.sh <lane-name> [--dry-run]
#
# Refuses when: lane not found, lane has no pane, lane is working, tab label does not
# slugify to the lane name (the name would change on relaunch — that is leave-and-join
# for rooms and must be a deliberate act, not a side effect).
set -uo pipefail

lane="${1:?usage: relaunch-lane.sh <lane-name> [--dry-run]}"
dry=0
[ "${2:-}" = "--dry-run" ] && dry=1

herdr_get() { herdr agent get "$1" 2>/dev/null; }
jq_field() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)["result"]["agent"]
except Exception: sys.exit(1)
print(d.get(sys.argv[1],""))' "$1"; }

info=$(herdr_get "$lane") || { echo "FAIL: no live agent named $lane"; exit 1; }
pane=$(printf '%s' "$info" | jq_field pane_id)
tab=$(printf '%s' "$info" | jq_field tab_id)
status=$(printf '%s' "$info" | jq_field agent_status)
[ -n "$pane" ] || { echo "FAIL: $lane has no pane_id"; exit 1; }

# Read the active session from the extension's state file (most reliable)
SESSION_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pil/sessions"
session=""
if [ -f "$SESSION_STATE_DIR/$lane.path" ]; then
  session=$(cat "$SESSION_STATE_DIR/$lane.path" 2>/dev/null | tr -d '\n')
fi

label=$(herdr tab get "$tab" 2>/dev/null | python3 -c 'import json,sys
print(json.load(sys.stdin)["result"]["tab"]["label"])')
slug=$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\+/-/g' -e 's/^-//' -e 's/-$//')
if [ "$slug" != "$lane" ]; then
  echo "REFUSE: tab label '$label' slugifies to '$slug', not '$lane' — a relaunch would rename the lane"
  exit 1
fi
case "$status" in
  idle|done|blocked) ;;
  *) echo "REFUSE: $lane is '$status' — quit it at a stop boundary, not mid-turn"; exit 1 ;;
esac

echo "lane=$lane pane=$pane tab=$tab label=$label status=$status"
echo "session=${session:-<none>}"
[ "$dry" = 1 ] && { echo "dry-run: would /exit then 'pil --session <path>' in $pane"; exit 0; }
[ -z "$session" ] && { echo "WARN: $lane has no session path recorded; will start fresh"; }

# 1. Quit the bare pi process. `/exit` is NOT a pi command here — sent as a prompt it
#    burns a turn and the agent replies "Exiting." while staying alive (observed
#    2026-11-01 on yellowstone-leader). Double ctrl+c is the exit; the agent vanishing
#    from the roster is the only reliable "it is gone" signal.
herdr agent send-keys "$lane" ctrl+c ctrl+c >/dev/null 2>&1
for _ in $(seq 1 40); do
  herdr agent get "$lane" >/dev/null 2>&1 || break
  sleep 0.5
done
herdr agent get "$lane" >/dev/null 2>&1 && { echo "FAIL: $lane still present after ctrl+c ctrl+c"; exit 1; }

# 2. Relaunch through the launcher, inside the target pane, resuming the same session.
# With the role restoration fix merged, pil restores PI_MODE/PI_PROFILE from the recorded
# state automatically, so we don't need to pass them explicitly.
if [ -n "$session" ]; then
  herdr pane run "$pane" "pil --session '$session'" >/dev/null 2>&1
else
  herdr pane run "$pane" 'pil' >/dev/null 2>&1
fi
for _ in $(seq 1 90); do
  s=$(herdr agent get "$lane" 2>/dev/null | jq_field agent_status)
  [ "$s" = idle ] || [ "$s" = done ] && break
  s=""
  sleep 1
done
[ -n "${s:-}" ] || { echo "FAIL: $lane did not come back idle"; herdr pane read "$pane" --source recent-unwrapped --lines 20 2>&1 | tail -8; exit 1; }

# 3. Verify from the footer — profile and rooms identity are what this was for.
footer=$(herdr agent read "$lane" --source recent-unwrapped --lines 40 2>&1 | grep -aoE 'rooms: [a-z0-9_-]+ profile: [a-z]+' | tail -1)
echo "footer: ${footer:-<not found>}"
case "$footer" in
  *"profile: leader"*) echo "OK: $lane relaunched on profile fleet"; exit 0 ;;
  *) echo "WARN: $lane relaunched but profile is not fleet"; exit 1 ;;
esac