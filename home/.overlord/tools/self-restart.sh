#!/usr/bin/env bash
# self-restart — relaunch this lane through the launcher with the env from <cwd>/.pi/launch.env.
# Unlike migrate-lane.sh this has no idle gate: a lane that is always mid-turn when it acts can
# never satisfy that gate, and the scheduled run keeps losing the race with its own turn.
set -uo pipefail
lane="${1:-overlord}"
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
if herdr pane read "$pane" --source recent-unwrapped --lines 30 2>/dev/null | grep -qiE "composition is invalid|not confirmed|overlay mode was unavailable"; then
  say "FAIL composition rejected at launch — the lane has no role contract"
fi
say "done"
