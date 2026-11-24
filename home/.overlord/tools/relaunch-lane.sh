#!/usr/bin/env bash
# relaunch-lane — replace one lane's process so it picks up everything that is resolved at exec
# (the pi bundle, PI_MODE/PI_PROFILE, the package set, the environment, and the profile UI
# extension the launcher injects as `-e .../pi-profile/index.ts`). `/reload` re-imports extension
# code but cannot do any of these.
#
# Contract, learned the hard way:
#   * `pil` derives the lane name from the TAB LABEL of the pane it runs in. So this script must
#     run pil *inside* the target pane (`herdr pane run <pane> pil`) and must NEVER run `pil` from
#     the caller's own pane: that makes a child claim the caller's name, and its leave-and-join
#     deregisters the live lane.
#   * `pil` restores the role contract from ~/.local/state/pil/roles/<lane>.env and the session from
#     ~/.local/state/pil/sessions/<lane>.path, so a bare `pil` in the pane IS the relaunch. Do not
#     inline `env PI_MODE=… PI_PROFILE=… PI_MODE_CONFIRM_PROJECT=1 PI_ROOMS_NAME=…`: every one of
#     those is restored or derived, and inlining the space's launch.env has already promoted a
#     worker lane to leader (ft55-parameter-plan, 2026-11-13).
#   * The lane must be idle/done first. Quitting a `working` lane kills an in-flight turn; quitting
#     a goal lane pauses its goal.
#   * Double `ctrl+c` is the exit. `/exit` is not a pi command: sent as a prompt it burns a turn and
#     the agent replies "Exiting." while staying alive.
#   * Verify from the footer and the session pin, never from an exit code — and never from argv.
#     The profile extension arrives through the launcher's parent process, so child argv looks
#     identical before and after a repair; an argv gate marks correctly repaired lanes FAILED.
#
# Usage:
#   tools/relaunch-lane.sh <lane-name> [options]
#
# Options:
#   --dry-run              report what would happen, change nothing
#   --verify-only          run the gates against the live lane, do not stop or relaunch it
#   --expect-profile NAME  require this profile in the footer (default: the profile recorded in
#                          the lane's role file, else the profile the footer shows before we stop
#                          it, else any profile token)
#   --json                 machine-readable summary on stdout
#   --path-prefix DIR      prepend DIR to PATH inside the pane before launching pil, so the lane
#                          runs a lane-local pi binary (a rollout artifact) instead of the global
#                          one. Code-only: HOME, the agent dir and the session are untouched. The
#                          rollback is the same relaunch WITHOUT this option.
#   --help                 this text
#
# Gates: registered · status idle/done · footer present · mode token has no `!` · `profile:` token
# present and matching the expectation · recorded session exists and the pil pin agrees with it.
#
# Refuses when: lane not found, lane has no pane, lane is working, or the tab label does not
# slugify to the lane name (the name would change on relaunch — that is leave-and-join for rooms
# and must be a deliberate act, not a side effect).
#
# Exit codes: 0 all gates passed · 1 a gate failed · 2 refused before touching anything.
#
# Read-only inspection of the same facts, without relaunching anything: `tools/lane check <lane>`.
set -uo pipefail

# Pause lane-supervise while this script is replacing panes: the timer must not resume a lane
# in the window between this script stopping it and starting it again, or two processes race
# one session. The hold carries this pid, so a crash here cannot pause supervision forever.
keepalive-hold start --reason relaunch-lane >/dev/null 2>&1 || true
trap 'keepalive-hold end --if-owner $$ >/dev/null 2>&1 || true' EXIT INT TERM

usage() { sed -n '3,50p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

lane=""
dry=0
verify_only=0
as_json=0
expect_profile=""
path_prefix=""

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) dry=1 ;;
    --verify-only) verify_only=1 ;;
    --json) as_json=1 ;;
    --expect-profile) shift; expect_profile="${1:-}"; [ -n "$expect_profile" ] || { echo "REFUSE: --expect-profile needs a value"; exit 2; } ;;
    --expect-profile=*) expect_profile="${1#*=}" ;;
    --path-prefix) shift; path_prefix="${1:-}"; [ -n "$path_prefix" ] || { echo "REFUSE: --path-prefix needs a value"; exit 2; } ;;
    --path-prefix=*) path_prefix="${1#*=}" ;;
    -*) echo "REFUSE: unknown option $1 (try --help)"; exit 2 ;;
    *) if [ -z "$lane" ]; then lane="$1"; else echo "REFUSE: unexpected argument $1"; exit 2; fi ;;
  esac
  shift
done

[ -n "$lane" ] || { usage >&2; exit 2; }
# Name the lane being replaced so lane-supervise skips this one and keeps watching the rest.
keepalive-hold set-lane "$lane" --quiet >/dev/null 2>&1 || true

herdr_get() { herdr agent get "$1" 2>/dev/null; }
jq_field() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)["result"]["agent"]
except Exception: sys.exit(1)
print(d.get(sys.argv[1],"") or "")' "$1"; }

# The footer is a rendering of recorded state, so ask the record (FT-71). This used to harvest
# 40 lines of scrollback to find one line — a probe of the lane it was inspecting.
footer_line() {
  /home/bitnom/.overlord/tools/lane-fields "$1" footer 2>/dev/null
}
tok() { printf '%s' "$2" | sed -n "s/.*$1: *\([A-Za-z0-9_!-]*\).*/\1/p"; }

json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

info=$(herdr_get "$lane") || { echo "FAIL: no live agent named $lane"; exit 2; }
pane=$(printf '%s' "$info" | jq_field pane_id)
tab=$(printf '%s' "$info" | jq_field tab_id)
status=$(printf '%s' "$info" | jq_field agent_status)
agent_session=$(printf '%s' "$info" | python3 -c 'import json,sys
try: s=json.load(sys.stdin)["result"]["agent"].get("agent_session") or {}
except Exception: sys.exit(0)
print(s.get("value","") if isinstance(s,dict) else "")')
[ -n "$pane" ] || { echo "FAIL: $lane has no pane_id"; exit 2; }

# Session: prefer the extension's own record, fall back to the pil pin.
SESSION_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pil/sessions"
ROLE_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pil/roles"
pin=""
[ -f "$SESSION_STATE_DIR/$lane.path" ] && pin=$(tr -d '\n' < "$SESSION_STATE_DIR/$lane.path" 2>/dev/null)
session="${agent_session:-$pin}"

label=$(herdr tab get "$tab" 2>/dev/null | python3 -c 'import json,sys
print(json.load(sys.stdin)["result"]["tab"]["label"])' 2>/dev/null)
slug=$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\+/-/g' -e 's/^-//' -e 's/-$//')
if [ "$slug" != "$lane" ]; then
  echo "REFUSE: tab label '$label' slugifies to '$slug', not '$lane' — a relaunch would rename the lane"
  exit 2
fi
case "$status" in
  idle|done|blocked) ;;
  *) echo "REFUSE: $lane is '$status' — quit it at a stop boundary, not mid-turn"; exit 2 ;;
esac

# What profile do we expect afterwards? An explicit flag wins, then the lane's own role file (the
# lane's live contract, never a space's launch.env), then whatever the footer showed before we
# stopped it. Only "any profile token" if none of those exist.
pre_line=$(footer_line "$lane")
pre_mode=$(tok mode "$pre_line")
pre_profile=$(tok profile "$pre_line")
recorded_profile=""
[ -f "$ROLE_STATE_DIR/$lane.env" ] && recorded_profile=$(sed -n 's/.*PI_PROFILE=\([A-Za-z0-9_-]*\).*/\1/p' "$ROLE_STATE_DIR/$lane.env" | tail -1)
expect="${expect_profile:-${recorded_profile:-$pre_profile}}"

echo "lane=$lane pane=$pane tab=$tab label=$label status=$status"
echo "session=${session:-<none>} pin=${pin:-<none>} exists=$([ -n "$session" ] && [ -f "$session" ] && echo yes || echo NO)"
echo "expected profile=${expect:-<any>} (source: $([ -n "$expect_profile" ] && echo flag || { [ -n "$recorded_profile" ] && echo role-file || echo pre-footer; }))"

# ---- gates -------------------------------------------------------------------------------------
# Every gate must pass. UNKNOWN (nothing captured) is a failure, never a pass.
run_gates() {
  local line mode got expect_pin ok=1
  line=$(footer_line "$lane")
  if [ -z "$line" ]; then
    echo "GATE footer      FAIL  UNKNOWN — no status line; not evidence of a clean footer"
    ok=0
  else
    echo "GATE footer      PASS  $(printf '%s' "$line" | sed 's/  */ /g' | cut -c1-120)"
  fi
  mode=$(tok mode "$line")
  case "$mode" in
    *'!'*) echo "GATE drift       FAIL  mode token carries a bang: mode:$mode"; ok=0 ;;
    # No mode token is not drift: a lane that does not run pi-modes (or whose footer omits the
    # segment) has no composed mode to be stale, and treating absence as failure is the mistake
    # this fleet keeps correcting. Reported, never failed.
    '')    echo "GATE drift       warn  no mode token in the footer (no composed mode to check)" ;;
    *)     echo "GATE drift       PASS  mode:$mode" ;;
  esac
  got=$(tok profile "$line")
  if [ -z "$got" ]; then
    echo "GATE profile     FAIL  no profile token in the footer"; ok=0
  elif [ -n "$expect" ] && [ "$got" != "$expect" ]; then
    echo "GATE profile     FAIL  expected '$expect', footer shows '$got'"; ok=0
  else
    echo "GATE profile     PASS  profile: $got"
  fi
  if [ -n "$session" ] && [ ! -f "$session" ]; then
    echo "GATE session     FAIL  recorded session file is absent: $session"; ok=0
  elif [ -n "$pin" ] && [ "$pin" != "$agent_session" ] && [ -n "$agent_session" ]; then
    echo "GATE session     FAIL  pil pin and agent_session disagree"; ok=0
  else
    echo "GATE session     PASS  ${session:-<none>}"
  fi
  local now_status
  now_status=$(herdr_get "$lane" | jq_field agent_status)
  case "$now_status" in
    idle|done|blocked) echo "GATE registration PASS  $lane is '$now_status' on $pane" ;;
    "") echo "GATE registration FAIL  $lane is not registered after relaunch (repair: herdr agent rename $pane $lane)"; ok=0 ;;
    *) echo "GATE registration PASS  $lane is '$now_status' on $pane" ;;
  esac
  return $((1 - ok))
}

emit_summary() {
  local rc="$1"
  [ "$as_json" = 1 ] || return 0
  printf '{"lane":%s,"pane":%s,"tab":%s,"session":%s,"pin":%s,"expected_profile":%s,"mode":%s,"profile":%s,"verify_only":%s,"ok":%s}\n' \
    "$(json_str "$lane")" "$(json_str "$pane")" "$(json_str "$tab")" "$(json_str "$session")" \
    "$(json_str "$pin")" "$(json_str "$expect")" "$(json_str "$(tok mode "$(footer_line "$lane")")")" \
    "$(json_str "$(tok profile "$(footer_line "$lane")")")" \
    "$([ "$verify_only" = 1 ] && echo true || echo false)" \
    "$([ "$rc" = 0 ] && echo true || echo false)"
}

if [ "$verify_only" = 1 ]; then
  run_gates; rc=$?
  emit_summary "$rc"
  exit "$rc"
fi

[ "$dry" = 1 ] && { echo "dry-run: would stop $lane (ctrl+c twice) then '${path_prefix:+PATH=$path_prefix:\$PATH }pil --session <path>' in $pane"; exit 0; }
[ -n "$path_prefix" ] && [ ! -d "$path_prefix" ] && { echo "REFUSE: --path-prefix '$path_prefix' is not a directory"; exit 2; }
[ -z "$session" ] && echo "WARN: $lane has no recorded session; a relaunch would start it EMPTY"

# 1. Quit. Double ctrl+c; the agent vanishing from the roster is the only reliable "it is gone".
herdr agent send-keys "$lane" ctrl+c ctrl+c >/dev/null 2>&1
for _ in $(seq 1 40); do
  herdr agent get "$lane" >/dev/null 2>&1 || break
  sleep 0.5
done
herdr agent get "$lane" >/dev/null 2>&1 && { echo "FAIL: $lane still present after ctrl+c ctrl+c"; exit 1; }

# 2. Relaunch through the launcher, inside the target pane, resuming the same session. pil restores
#    PI_MODE / PI_PROFILE / PI_MODE_CONFIRM_PROJECT from the role record and derives PI_ROOMS_NAME
#    from the tab label, so a bare `pil` is the whole command.
# Optional lane-local binary: prepend the rollout artifact's bin dir for this launch only. The
# pane shell expands $PATH, so the prefix is scoped to the pil command and nothing persists.
prefix=""
[ -n "$path_prefix" ] && prefix="PATH='$path_prefix':\$PATH "
if [ -n "$session" ]; then
  herdr pane run "$pane" "${prefix}pil --session '$session'" >/dev/null 2>&1
else
  herdr pane run "$pane" "${prefix}pil" >/dev/null 2>&1
fi
for _ in $(seq 1 90); do
  s=$(herdr_get "$lane" | jq_field agent_status)
  { [ "$s" = idle ] || [ "$s" = done ]; } && break
  s=""
  sleep 1
done
if [ -z "${s:-}" ]; then
  echo "FAIL: $lane did not come back idle"
  /home/bitnom/.overlord/tools/pane-read "$pane" --reason "the lane did not come back idle; its last screen lines say why" --history --lines 20 2>&1 | tail -8
  exit 1
fi

# 3. Gates.
run_gates; rc=$?
emit_summary "$rc"
exit "$rc"
