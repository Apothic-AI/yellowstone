#!/usr/bin/env bash
# relaunch-lane-monorepo.sh <lane> [<lane>...]
#
# Restarts idle pi lanes so they materialise the monorepo-sourced canonical settings.
# Every step gates rather than assumes: a lane that is not idle, whose tab label does
# not slugify to its own name, or that comes back without a footer mode is reported
# and skipped rather than forced.
#
# Why a script: 31 lanes, each needing the same steps and the same verification.
# Why not `herdr agent start`: it does not carry our PI_MODE/PI_PROFILE convention,
# and pil derives the lane name from the tab label — a child started from my own pane
# would claim my label and deregister this lane.
#
# Two hard-won details:
#   * `pane run` types the command but does not reliably submit it on this build, so
#     Enter is sent separately and retried. An unsubmitted line looks exactly like a
#     lane that exited and never came back — that mistake cost two lanes a second pass.
#   * /exit is not a pi command; ctrl+c twice is the documented exit.
set -uo pipefail

HERDR="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"

slugify() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9_-]\+/-/g' -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//'; }

agent_field() {
  "$HERDR" agent get "$1" 2>/dev/null | python3 -c "
import json,sys
k=sys.argv[1]
try: print(json.load(sys.stdin)['result']['agent'].get(k) or '')
except Exception: print('')
" "$2"
}

lane_status() { agent_field "$1" agent_status; }

tab_label_of() {
  "$HERDR" tab get "$1" 2>/dev/null | python3 -c "
import json,sys
try: print(json.load(sys.stdin)['result']['tab']['label'])
except Exception: print('')
"
}

pi_pid() {
  "$HERDR" pane process-info --pane "$1" 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)['result']['process_info']
  print([p['pid'] for p in d['foreground_processes'] if p.get('name')=='pi'][0])
except Exception: print('')
"
}

env_of() { tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null; }

footer_has_mode() {  # $1 pane, $2 mode
  "$HERDR" pane read "$1" --lines 40 2>/dev/null | grep -qE "mode:${2}( |$)"
}

verify_instance() {
  local pane="$1" pid dir
  pid="$(pi_pid "$pane")"
  [ -n "$pid" ] || { echo "NO-PROCESS"; return; }
  dir="$(env_of "$pid" | sed -n 's/^PI_CODING_AGENT_DIR=//p')"
  [ -n "$dir" ] || { echo "NO-AGENT-DIR"; return; }
  python3 - "$dir" <<'PY'
import json,os,sys
d=sys.argv[1]
p=os.path.join(d,"settings.json")
if not os.path.exists(p): print("NO-SETTINGS"); raise SystemExit
s=json.load(open(p))
pk=[(v if isinstance(v,str) else v.get("source")) for v in (s.get("packages") or [])]
pk=[x for x in pk if isinstance(x,str)]
loose=[x for x in pk if "/home/bitnom/Code/" in x and "/Code/yellowstone/" not in x]
mono=[x for x in pk if "/Code/yellowstone/" in x]
print(f"MIGRATED entries={len(pk)} monorepo={len(mono)} loose=0" if not loose
      else f"NOT-MIGRATED loose={len(loose)} first={loose[0]}")
PY
}

relaunch_one() {
  local lane="$1" pane tab status label mode profile pid cmd i inst foot
  status="$(lane_status "$lane")"
  if [ "$status" != "idle" ] && [ "$status" != "done" ]; then
    echo "$lane SKIP status=$status (not a stop boundary)"; return 1
  fi
  pane="$(agent_field "$lane" pane_id)"
  tab="$(agent_field "$lane" tab_id)"
  label="$(tab_label_of "$tab")"
  if [ "$(slugify "$label")" != "$lane" ]; then
    echo "$lane SKIP tab-label '$label' would register as '$(slugify "$label")' — refusing to rename a lane"; return 1
  fi
  pid="$(pi_pid "$pane")"
  mode="$(env_of "$pid" | sed -n 's/^PI_MODE=//p')"
  profile="$(env_of "$pid" | sed -n 's/^PI_PROFILE=//p')"
  if [ -z "$mode" ]; then
    echo "$lane SKIP no PI_MODE in env (bare launch — relaunching would lose the role)"; return 1
  fi
  [ -n "$profile" ] || profile="$mode"

  # 1. quit: ctrl+c twice is the documented exit
  "$HERDR" agent send-keys "$lane" ctrl+c ctrl+c >/dev/null 2>&1
  for i in $(seq 1 25); do
    [ -z "$(pi_pid "$pane")" ] && break
    sleep 1
  done
  if [ -n "$(pi_pid "$pane")" ]; then echo "$lane SKIP did not exit in 25s"; return 1; fi

  # 2. relaunch in the target pane, same role, then submit
  cmd="PI_MODE=$mode PI_PROFILE=$profile PI_MODE_CONFIRM_PROJECT=1 pil"
  "$HERDR" pane send-text "$pane" "$cmd" >/dev/null 2>&1
  for i in 1 2 3 4 5; do
    "$HERDR" pane send-keys "$pane" Enter >/dev/null 2>&1
    sleep 2
    footer_has_mode "$pane" "$mode" && break
  done
  for i in $(seq 1 40); do
    footer_has_mode "$pane" "$mode" && break
    sleep 1
  done

  # 3. verify from the instance, not the footer
  inst="$(verify_instance "$pane")"
  foot="$("$HERDR" pane read "$pane" --lines 3 2>/dev/null | tail -1 | sed 's/^· //' | cut -c1-100)"
  echo "$lane pane=$pane inst=$inst status=$(lane_status "$lane")"
  echo "    footer: $foot"
  case "$inst" in
    MIGRATED*) return 0 ;;
    *) echo "    WARN: instance verification failed — $inst"; return 1 ;;
  esac
}

[ $# -ge 1 ] || { echo "usage: $0 <lane> [<lane>...]"; exit 2; }
fail=0
for lane in "$@"; do
  relaunch_one "$lane" || fail=$((fail+1))
done
echo "---"
echo "done: $(( $# - fail )) relaunched, $fail skipped/failed"
