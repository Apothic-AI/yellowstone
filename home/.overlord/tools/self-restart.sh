#!/usr/bin/env bash
# self-restart — relaunch this lane through the launcher with the env from <cwd>/.pi/launch.env.
# Unlike migrate-lane.sh this has no idle gate: a lane that is always mid-turn when it acts can
# never satisfy that gate, and the scheduled run keeps losing the race with its own turn.
#
# Canonical: restart-fleet --include-self (deferred) or new-self.py. This restarts the calling lane in place.
case "${1:-}" in
  -h|--help)
    sed -n "2,4p" "$0" | sed "s/^#[ ]*//"
    exit 0
    ;;
esac
set -uo pipefail

# Pause lane-supervise while this script is replacing panes: the timer must not resume a lane
# in the window between this script stopping it and starting it again, or two processes race
# one session. The hold carries this pid, so a crash here cannot pause supervision forever.
keepalive-hold start --reason self-restart >/dev/null 2>&1 || true
trap 'keepalive-hold end --if-owner $$ >/dev/null 2>&1 || true' EXIT INT TERM
lane="${1:-overlord}"
# Name the lane being replaced so lane-supervise skips this one and keeps watching the rest.
keepalive-hold set-lane "$lane" --quiet >/dev/null 2>&1 || true
pane="${2:-wE:p1}"
cwd="${3:-/home/bitnom/.overlord}"
log=/tmp/overlord-self-restart.log
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$log"; }
launch="$(cat "$cwd/.pi/launch.env") pil"
say "start lane=$lane pane=$pane launch=$launch"
herdr agent send-keys "$lane" ctrl+c ctrl+c >/dev/null 2>&1
for _ in $(seq 1 40); do herdr agent get "$lane" >/dev/null 2>&1 || break; sleep 0.5; done
if herdr agent get "$lane" >/dev/null 2>&1; then say "FAIL still alive after ctrl+c"; exit 1; fi
say "process exited; relaunching"
herdr pane run "$pane" "$launch" >/dev/null 2>&1
for _ in $(seq 1 90); do
  s=$(herdr agent get "$lane" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["agent"]["agent_status"])
except Exception: print("")' 2>/dev/null)
  case "$s" in idle|done) say "OK $lane $s after relaunch"; break ;; esac
  sleep 1
done
# Positive check from the record: M-1 is present only if a mode activated (FT-71).
mode_out=$(/home/bitnom/.overlord/tools/lane-fields "$lane" mode 2>/dev/null); mode_rc=$?
if [ "$mode_rc" = 6 ]; then
  say "note: fields withheld by policy (held lane) — not a composition failure"
elif [ -z "$mode_out" ]; then
  say "FAIL no active mode recorded — the lane has no role contract"
  /home/bitnom/.overlord/tools/pane-read "$lane" --reason "a rejected composition prints one stderr line, and only the screen holds it" --history --lines 30 2>/dev/null | tail -5 | sed 's/^/    /'
fi
say "done"
