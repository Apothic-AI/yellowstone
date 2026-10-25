#!/usr/bin/env bash
# herdr-agy.sh — reliable agent orchestration for herdr, working around
# herdrdev/herdr#3530.
#
# THE BUG (issue #3530)
#   For agent kinds `agy` (Antigravity CLI) and `grok` (Grok Build CLI), the
#   reported `agent_status` drops to `idle`/`done` in the MIDDLE of a turn, and
#   also while the agent waits on a background task it started itself. Any
#   consumer of `herdr agent wait` or `herdr agent prompt --wait` therefore sees
#   a premature "settled" state. Measured upstream: false `done` phases of up to
#   50 s while the pane is visibly still streaming, and seven premature `done`
#   events in a single orchestration run. A 4 s consumer-side debounce does NOT
#   help because the false phases are much longer than that.
#
# THE FIX
#   Stop trusting `agent_status` alone and treat the pane as ground truth. If the
#   last few lines of the agent's buffer carry a LIVE-CONTROL marker — a Braille
#   spinner, `esc to cancel`, a `● [HH:MM:SS] … running` task line, `N task(s)`,
#   `Loading...` (agy); `command(s) still running` (grok) — then the agent is NOT
#   settled, no matter what the status field says.
#
#   Markers are matched ONLY in the tail, never across the whole pane. This is the
#   upstream maintainer's explicit requirement: matching the live controls must
#   not also match old transcript text (a past tool call that happened to contain
#   the word "running" must not read as busy forever).
#
# USAGE
#   herdr-agy.sh status  <target> [--kind agy|grok] [--json]
#   herdr-agy.sh wait    <target> [--until STATE] [--timeout MS] [--interval S]
#   herdr-agy.sh prompt  <target> <text> [--timeout MS] [--interval S]
#   herdr-agy.sh watch   <target> [--interval S]
#   herdr-agy.sh probe   <target>            # debug: dump the signals
#
#   <target> is a unique live agent name, or the hosting pane id (`wC:pV`).
#   Pane ids are volatile; prefer agent names when one exists.
#
# EXIT CODES
#   0  settled (or, for status, command succeeded)
#   1  timeout
#   2  usage / target-resolution error
#   3  blocked — the agent is at an approval or question UI and needs a human
#
# ENV
#   HERDR_BIN         herdr executable            (default: herdr)
#   HERDR_AGY_LINES   tail lines to inspect       (default: 10)
#   HERDR_AGY_STABLE  consecutive clean polls
#                     required before believing a  (default: 2)
#                     settled reading
#   HERDR_AGY_POLL    default poll interval (s)   (default: 2)

set -uo pipefail

HERDR_BIN="${HERDR_BIN:-herdr}"
TAIL_LINES="${HERDR_AGY_LINES:-10}"
STABLE_POLLS="${HERDR_AGY_STABLE:-2}"
POLL="${HERDR_AGY_POLL:-2}"

die() { printf 'herdr-agy: %s\n' "$1" >&2; exit "${2:-2}"; }

# ---------------------------------------------------------------- target ----
# Accepts an agent name or a pane id, returns the pane id on stdout.
resolve_pane() {
  local target="$1" js pane
  js="$("$HERDR_BIN" agent get "$target" 2>/dev/null)" || return 1
  pane="$(printf '%s' "$js" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
a = d.get("result", {}).get("agent") or {}
p = a.get("pane_id")
print(p if p else "")
' 2>/dev/null)"
  [ -n "$pane" ] || return 1
  printf '%s' "$pane"
}

agent_status() {
  "$HERDR_BIN" agent get "$1" 2>/dev/null | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unknown"); sys.exit(0)
a = d.get("result", {}).get("agent") or {}
print(a.get("agent_status", "unknown"))
'
}

# --------------------------------------------------------------- markers ----
# Live-control markers, matched ONLY against the tail of the buffer.
#
# agy markers are deliberately strict:
#   * `esc to cancel` is agy\'s footer while a turn is in flight; its idle
#     footer is `? for shortcuts` instead. This is the single most reliable
#     signal and is checked first.
#   * `● [HH:MM:SS] ... running` is the background-task status line the issue
#     describes. The `[HH:MM:SS]` timestamp plus a trailing `running` is required
#     so that arbitrary command text containing "running" does not match.
#   * the Braille range covers agy\'s spinners in both the 2-column and 8-dot
#     variants; `Loading...` covers its task-resume placeholder.
# NOTE: each alternative MUST be introduced with `-e`. Bare
# `grep -E 'a' 'b' 'c'` treats `b` and `c` as FILENAMES, which silently makes
# every check fail open.
markers_agy() {
  grep -aE \
    -e 'esc to cancel' \
    -e '● \[[0-9]{2}:[0-9]{2}:[0-9]{2}\].* running' \
    -e '[⠁-⣿]' \
    -e 'Loading\.\.\.' \
    -e '[0-9]+ task\(s\)' \
    >/dev/null 2>&1
}

# grok signals: the `N command(s) still running · send a message to interrupt`
# line above the composer. Glyphs alone are not used — the pane blinks them.
markers_grok() {
  grep -aE \
    -e '[0-9]+ command\(s\) still running' \
    -e 'command\(s\) still running' \
    >/dev/null 2>&1
}

# Pane tail via --source detection (plain-text bottom buffer, the snapshot herdr
# itself uses for agent detection). Falls back to `visible`.
pane_tail() {
  local pane="$1" out
  out="$("$HERDR_BIN" pane read "$pane" --source detection --lines "$TAIL_LINES" 2>/dev/null)"
  if [ -z "$out" ]; then
    out="$("$HERDR_BIN" pane read "$pane" --source visible --lines "$TAIL_LINES" 2>/dev/null)"
  fi
  printf '%s' "$out"
}

# Exit 0 when the pane shows live controls (i.e. NOT settled).
pane_busy() {
  local pane="$1" kind="$2" tail
  tail="$(pane_tail "$pane")"
  [ -n "$tail" ] || return 1
  case "$kind" in
    grok) markers_grok <<<"$tail" ;;
    *)    markers_agy  <<<"$tail" ;;
  esac
}

# --------------------------------------------------------------- commands ----
is_settled_status() {
  case "$1" in
    idle|done|blocked|settled) return 0 ;;
    *) return 1 ;;
  esac
}

cmd_status() {
  local target="" kind=agy as_json=0 pane status busy eff
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) kind="$2"; shift 2 ;;
      --json) as_json=1; shift ;;
      --) shift; break ;;
      -*) die "unknown option for status: $1" ;;
      *)  [ -z "$target" ] || die "status takes one target"; target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || die "usage: herdr-agy.sh status <target> [--kind K] [--json]"

  pane="$(resolve_pane "$target")" || die "cannot resolve target: $target"
  status="$(agent_status "$pane")"
  if pane_busy "$pane" "$kind"; then busy=true; else busy=false; fi

  if   $busy            && is_settled_status "$status"; then eff=working   # the bug
  elif $busy            && [ "$status" = working ];     then eff=working
  else eff="$status"
  fi

  if [ "$as_json" -eq 1 ]; then
    python3 -c '
import json,sys
print(json.dumps({
  "pane": sys.argv[1], "reported_status": sys.argv[2],
  "pane_busy": sys.argv[3] == "true", "effective_status": sys.argv[4],
}))
' "$pane" "$status" "$busy" "$eff"
  else
    printf '%s\n' "$eff"
  fi
}

cmd_wait() {
  local target="" kind=agy until="" timeout_ms=900000 interval="$POLL" pane
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) kind="$2"; shift 2 ;;
      --until) until="$2"; shift 2 ;;
      --timeout) timeout_ms="$2"; shift 2 ;;
      --interval) interval="$2"; shift 2 ;;
      --) shift; break ;;
      -*) die "unknown option for wait: $1" ;;
      *)  [ -z "$target" ] || die "wait takes one target"; target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || die "usage: herdr-agy.sh wait <target> [--until S] [--timeout MS]"

  pane="$(resolve_pane "$target")" || die "cannot resolve target: $target"

  local deadline=$(( $(date +%s) + timeout_ms / 1000 ))
  local streak=0 status busy last=""

  while [ "$(date +%s)" -le "$deadline" ]; do
    status="$(agent_status "$pane")"
    if [ "$status" != "$last" ]; then
      [ -t 1 ] && printf '[herdr-agy] %s status=%s\n' "$(date +%H:%M:%S)" "$status" >&2
      last="$status"
    fi

    # blocked is a genuine stop; a human must look at the pane.
    if [ "$status" = blocked ] && ! pane_busy "$pane" "$kind"; then
      printf '[herdr-agy] BLOCKED — approval/question UI in pane %s\n' "$pane" >&2
      return 3
    fi

    if is_settled_status "$status" && ! pane_busy "$pane" "$kind"; then
      streak=$(( streak + 1 ))
      # Require consecutive clean readings so a momentary gap between sub-steps
      # (where the spinner can blink off for a frame) cannot end the wait early.
      if [ "$streak" -ge "$STABLE_POLLS" ]; then
        if [ -n "$until" ] && [ "$status" != "$until" ]; then
          streak=0
        else
          printf '[herdr-agy] settled: %s (reported=%s)\n' "$status" "$status" >&2
          return 0
        fi
      fi
    else
      streak=0
    fi
    sleep "$interval"
  done

  printf '[herdr-agy] TIMEOUT after %ss (reported=%s)\n' "$timeout_ms" "$last" >&2
  return 1
}

cmd_prompt() {
  local target="" text="" kind=agy timeout_ms=900000 interval="$POLL" pane send_rc
  # Parse flags only until the first positional; everything after the target is
  # prompt text, verbatim. Multi-line briefs contain lines beginning with `-`
  # (markdown rules), so option parsing MUST stop at the target rather than
  # scan the whole argument list.
  while [ $# -gt 0 ]; do
    case "$1" in
      -*) die "unknown option for prompt: $1 (flags must precede the target)" ;;
      *)  target="$1"; shift; break ;;
    esac
  done
  [ -n "$target" ] || die "usage: herdr-agy.sh prompt <target> <text...>"
  text="$*"
  [ -n "${text// /}" ] || die "prompt text is empty"

  pane="$(resolve_pane "$target")" || die "cannot resolve target: $target"

  # Send WITHOUT --wait: herdr's own --wait would return on the false `done`.
  send_rc="$("$HERDR_BIN" agent prompt "$pane" "$text" 2>&1)"
  if printf '%s' "$send_rc" | grep -q '"error"'; then
    printf '%s\n' "$send_rc" >&2
    die "prompt rejected" 3
  fi
  printf '[herdr-agy] prompt sent to %s\n' "$pane" >&2

  cmd_wait "$pane" --kind "$kind" --timeout "$timeout_ms" --interval "$interval"
}

cmd_watch() {
  local target="" kind=agy interval="$POLL" pane prev="" status busy eff
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) kind="$2"; shift 2 ;;
      --interval) interval="$2"; shift 2 ;;
      --) shift; break ;;
      -*) die "unknown option for watch: $1" ;;
      *)  target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || die "usage: herdr-agy.sh watch <target>"
  pane="$(resolve_pane "$target")" || die "cannot resolve target: $target"
  while :; do
    status="$(agent_status "$pane")"
    if pane_busy "$pane" "$kind"; then busy=true; else busy=false; fi
    if   $busy && is_settled_status "$status"; then eff="working*"
    elif $busy; then eff=working
    else eff="$status"
    fi
    if [ "$eff" != "$prev" ]; then
      printf '%s  reported=%-8s effective=%-9s %s\n' \
        "$(date +%H:%M:%S)" "$status" "$eff" "$([ "$eff" = "working*" ] && echo '(corrected: pane still live)')"
      prev="$eff"
    fi
    sleep "$interval"
  done
}

# Debug helper: show exactly what the wrapper is looking at.
cmd_probe() {
  local target="" kind=agy pane
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) kind="$2"; shift 2 ;;
      --) shift; break ;;
      -*) die "unknown option for probe: $1" ;;
      *) target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || die "usage: herdr-agy.sh probe <target>"
  pane="$(resolve_pane "$target")" || die "cannot resolve target: $target"
  printf 'pane=%s kind=%s reported=%s tail(%s lines, --source detection):\n' \
    "$pane" "$kind" "$(agent_status "$pane")" "$TAIL_LINES"
  pane_tail "$pane" | tail -n "$TAIL_LINES" | nl -ba -w3 -s' | '
  if pane_busy "$pane" "$kind"; then
    printf 'VERDICT: BUSY (live controls present — agent is NOT settled)\n'
  else
    printf 'VERDICT: settled\n'
  fi
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    status) cmd_status "$@" ;;
    wait)   cmd_wait "$@" ;;
    prompt) cmd_prompt "$@" ;;
    watch)  cmd_watch "$@" ;;
    probe)  cmd_probe "$@" ;;
    ""|-h|--help|help)
      sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
      ;;
    *) die "unknown command: $cmd" ;;
  esac
}

main "$@"