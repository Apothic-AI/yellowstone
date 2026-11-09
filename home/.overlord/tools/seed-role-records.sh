#!/usr/bin/env bash
# Give the role-less leader lanes an explicit PI_MODE=leader launch, so pil writes a role
# record for each and every later relaunch/reboot restores the contract.
#
# Why these lanes need it: pil has NO default role. A lane with no record and no
# launch.env up its cwd chain stays role-less forever, and each relaunch drops it to pi's
# native 169-char prompt. For a lane only `migrate-lane.sh` knows about, that default
# (`PI_MODE=leader pil`) lives in the migration tool, not in pil — so the record has to be
# created once, deliberately, from here.
#
# Safety, learned the hard way earlier tonight:
#   * quit only at an idle/done boundary — quitting a working lane kills a live turn
#   * resume the RECORDED session explicitly, so the conversation is not lost
#   * verify from /proc and the transcript preamble, never from the footer: the footer
#     still prints `profile: leader` when the composition was dropped
set -uo pipefail
LANES=(dxdb-leader gemini-accts-leader lynx-leader omebian-leader personal-leader seeker-leader sysops-leader vpn2proxy-leader)

# agent_session is an OBJECT ({agent,kind,source,value}); every other field is a scalar. A
# single helper that just prints the field returns the whole object as a python dict repr,
# so comparing it against a path never matches — the first run of this script skipped all
# eight lanes for that reason (the guard was right to refuse; its input was malformed).
getf() { herdr agent get "$1" 2>/dev/null | python3 -c '
import json,sys
try: a=json.load(sys.stdin)["result"]["agent"]
except Exception: sys.exit(0)
f=sys.argv[1]
v=a.get(f,"")
if isinstance(v,dict): v=v.get("value","") or ""
print(v)' "$2" 2>/dev/null; }

for lane in "${LANES[@]}"; do
  st=$(getf "$lane" agent_status)
  pane=$(getf "$lane" pane_id)
  rec=$(cat "$HOME/.local/state/pil/sessions/$lane.path" 2>/dev/null | tr -d '\n')
  pin=$(getf "$lane" agent_session)

  if [ -z "$pane" ]; then echo "SKIP $lane: no pane"; continue; fi
  if [ "$st" != "idle" ] && [ "$st" != "done" ]; then echo "SKIP $lane: status=$st"; continue; fi
  if [ -z "$rec" ] || [ ! -f "$rec" ]; then echo "SKIP $lane: no usable session record"; continue; fi
  if [ "$rec" != "$pin" ]; then echo "SKIP $lane: record != herdr pin (refusing to guess)"; continue; fi

  herdr agent send-keys "$lane" ctrl+c ctrl+c >/dev/null 2>&1
  gone=0
  for _ in $(seq 1 40); do herdr agent get "$lane" >/dev/null 2>&1 || { gone=1; break; }; sleep 0.5; done
  [ "$gone" = 1 ] || { echo "FAIL $lane: would not quit"; continue; }

  herdr pane run "$pane" "PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil --session '$rec'" >/dev/null 2>&1
  back=0
  for _ in $(seq 1 60); do
    s=$(getf "$lane" agent_status)
    case "$s" in idle|done) back=1; break;; esac
    sleep 1
  done
  [ "$back" = 1 ] || { echo "FAIL $lane: did not come back"; continue; }

  after=$(getf "$lane" agent_session)
  # POLL for the pin to converge. Sampling it once right after the lane returns idle reported
  # session=CHANGED for 7 of 8 lanes on 2026-11-04; the re-check showed pin == record on every
  # one of them with the conversation intact (dxdb 3.6MB/36.9%, vpn2proxy 1.7MB/28.2%). pi
  # re-registers its session a moment after it settles, so a single read races it — and a
  # false CHANGED reads exactly like the session loss this whole mechanism exists to prevent.
  want=$(getf "$lane" agent_session)
  for _ in $(seq 1 30); do
    after=$(getf "$lane" agent_session)
    [ "$after" = "$rec" ] && break
    sleep 1
  done
  mode=$(for p in $(pgrep -x pi); do
           n=$(tr '\0' '\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^PI_ROOMS_NAME=//p')
           [ "$n" = "$lane" ] && tr '\0' '\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^PI_MODE=//p'
         done)
  sess_ok=$([ "$after" = "$rec" ] && echo same || echo CHANGED)
  echo "OK   $lane  mode=${mode:-<unset>}  session=$sess_ok  role_record=$([ -f "$HOME/.local/state/pil/roles/$lane.env" ] && echo yes || echo NO)"
done
