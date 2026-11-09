#!/usr/bin/env bash
# overlord-watchdog — if the overlord lane is gone, resume its last session.
#
# Why: on 2026-11-02 a `pkill -f 'pi$'` killed ~46 lanes including the overlord while the
# operator was away; restoring it was manual. Discipline cannot prevent that class of
# mistake, so this is the recovery half. Deliberately small: a pid-level liveness check and
# a resume, cheap enough to run often.
#
# Two invariants, and they are the whole design:
#   1. Never resume over a live lane. A resumed lane that was merely slow means two writers
#      on one session — a second outage, not a fix. A lock file with a stale timeout is the
#      entire defence.
#   2. Resume, never start fresh. The fleet's coordination state lives in the session, so a
#      blank session is an outage with a healthy pid.
#
# It does not classify what is wrong with a running lane. If a pi process is in the pane,
# this exits without touching anything.
#
# Modes:
#   overlord-watchdog.sh --record   save the live lane's session as the resume target
#   overlord-watchdog.sh            one pass (the timer's ExecStart)
set -uo pipefail

PANE="${OVERLORD_PANE:-wE:p1}"
CWD="${OVERLORD_CWD:-$HOME/.overlord}"
HERDR="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
STATE="${OVERLORD_STATE:-$HOME/.local/state/overlord}"
TARGET="$STATE/resume-target.json"
LOCK="$STATE/watchdog.lock"
LOG="$STATE/watchdog.log"
LOCK_STALE_SECS=${LOCK_STALE_SECS:-300}

mkdir -p "$STATE"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }

# Tell the resumed lane what happened, once. Facts only: the watchdog does not inspect,
# summarise or interpret what the lane missed — it says what it did and when.
notify_resumed() { # $1 = detected_at, $2 = resumed_at
  local detected="$1" resumed="$2" gap st out i
  gap=$(( $(date -d "$resumed" +%s 2>/dev/null || date +%s) - $(date -d "$detected" +%s 2>/dev/null || date +%s) ))
  [ "$gap" -lt 0 ] && gap=0

  local msg
  msg="[overlord-watchdog — automated resume, NOT from the operator] This lane was found down at ${detected}, resumed at ${resumed} (gap ~${gap}s). The watchdog continued the previous session rather than starting a new one. Nothing was restarted; whatever the lane was doing before is still in this session. Check for anything missed during the gap at your own discretion."

  # Only send once the resumed session is actually accepting input; a prompt typed into a
  # starting pane is lost, and the whole point is that the lane knows.
  st=""
  for i in $(seq 1 10); do
    st=$("$HERDR" agent get "$PANE" 2>/dev/null | python3 -c 'import json,sys
    try: print(json.load(sys.stdin)["result"]["agent"].get("agent_status") or "unknown")
    except Exception: print("absent")' 2>/dev/null)
    case "$st" in idle|done|unknown) break ;; esac
    sleep 2
  done
  case "$st" in
    working|blocked)
      # Never interrupt a turn. Informational, so a skipped notification is acceptable;
      # the lane's own wake will surface the gap.
      say "notify skipped: lane is $st — not interrupting"
      return 0 ;;
    absent)
      say "notify skipped: lane absent again after resume"
      return 0 ;;
  esac

  if out=$("$HERDR" agent prompt "$PANE" "$msg" --wait --timeout 30000 2>&1); then
    say "notified $PANE of the resume (detected $detected, resumed $resumed, gap ${gap}s)"
  else
    say "notify failed (${out:0:200}) — recorded, no retry until the next interval"
  fi
  return 0
}

# The pi process in the pane, from the process table — not from a status field.
pi_pid() {
  "$HERDR" pane process-info --pane "$PANE" 2>/dev/null | python3 -c '
import json,sys
try:
    procs=json.load(sys.stdin)["result"]["process_info"].get("foreground_processes") or []
except Exception:
    print(""); raise SystemExit
for p in procs:
    if (p.get("name") or "")=="pi" or (p.get("argv") or [None])[0]=="pi":
        print(p.get("pid")); break
else: print("")' 2>/dev/null
}

if [ "${1:-}" = "--record" ]; then
  sess=$("$HERDR" agent get "$PANE" 2>/dev/null | python3 -c '
import json,sys
try: print(((json.load(sys.stdin)["result"]["agent"].get("agent_session") or {}).get("value")) or "")
except Exception: print("")' 2>/dev/null)
  if [ -n "$sess" ] && [ -f "$sess" ]; then
    # Record the session UUID, not the absolute path. pi-profile-switch creates a NEW
    # instance dir per launch and sweeps old ones, so a path recorded before a resume can
    # be gone by the next pass — measured 2026-11-02: the resumed lane moved from
    # launch-qgLbng to launch-3kcdin and the recorded path vanished. `pi --session <uuid>`
    # resolves the session across instances; the path does not survive the sweep.
    python3 - "$TARGET" "$sess" "$CWD" <<'PY'
import json,os,re,sys,time
path,sess,cwd=sys.argv[1:4]
m=re.search(r'_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$', sess)
sid=m.group(1) if m else ""
json.dump({"session_id":sid,"session_path":sess,"cwd":cwd,
           "recorded_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())},
          open(path,"w"),indent=1)
PY
    say "recorded resume target: ${sess##*_}"
  elif [ -n "$sess" ]; then
    # herdr can report a session path before pi has flushed the file. Never overwrite a
    # good target with a path that does not exist yet.
    say "not recording: reported session file absent ($sess)"
  fi
  exit 0
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  age=$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -le "$LOCK_STALE_SECS" ]; then
    say "skip: another pass holds the lock (${age}s)"; exit 0
  fi
  say "lock stale ${age}s (>${LOCK_STALE_SECS}s) — proceeding"
fi

pid=$(pi_pid)
if [ -n "$pid" ]; then
  "$0" --record >/dev/null 2>&1 || true
  exit 0
fi

# Gone — this is the moment the watchdog noticed, and the resumed lane is told it.
detected_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Gone. Resume — but only if there is a session to resume into.
if [ ! -f "$TARGET" ]; then
  say "gone, no resume target recorded — a human must start the lane once"
  exit 1
fi
session=$(python3 -c 'import json;d=json.load(open("'"$TARGET"'"));print(d.get("session_id") or "")' 2>/dev/null)
if [ -z "$session" ]; then
  # Older target file recorded only a path. The UUID in the filename is the durable part,
  # so extract it whether or not that file still exists — the path is expected to be gone
  # after an instance sweep, which is exactly when this fallback runs.
  path_only=$(python3 -c 'import json;print(json.load(open("'"$TARGET"'")).get("session") or "")' 2>/dev/null)
  [ -n "$path_only" ] && session=$(basename "$path_only" | sed -n 's/.*_\([0-9a-f-]\{36\}\)\.jsonl$/\1/p')
fi
if [ -z "$session" ]; then
  say "gone, no usable session id recorded — a human must start the lane once"
  exit 1
fi

say "gone — resuming $PANE into session $session"
if ! "$HERDR" pane run "$PANE" \
      "cd $(printf '%q' "$CWD") && PI_MODE=leader PI_PROFILE=leader PI_MODE_CONFIRM_PROJECT=1 pil --session $(printf '%q' "$session")" \
      >/dev/null 2>&1; then
  say "resume command failed to send"; exit 1
fi

for i in $(seq 1 20); do
  sleep 3
  [ -n "$(pi_pid)" ] && break
done

if [ -n "$(pi_pid)" ]; then
  say "resumed: pid=$(pi_pid) session=$session"
  "$0" --record >/dev/null 2>&1 || true
  notify_resumed "$detected_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit $?
fi
say "resume did not bring the lane back (session=$session)"
exit 1
