#!/usr/bin/env bash
# herdr-binary-guard — shout if the herdr that serves the fleet is not the herdr we deployed.
#
# Why: on 2026-11-07 the machine rebooted and herdr came back from `~/.local/bin/herdr`, which
# had not been rewritten since 2026-11-05. Every deployed fix had gone live through
# `herdr server live-handoff --import-exe …`, which swaps the *running process* and touches
# nothing on disk — so the reboot silently reverted the fleet to a pre-fix build, and nothing
# noticed for a day and a half. The deploy was not wrong; it was not durable, and there was no
# signal. This is the signal.
#
# Two things can drift, and both mean the same thing:
#   * the SERVING process is not the pinned build  -> the deploy was reverted or replaced
#   * the LAUNCHER file is not the pinned build    -> the next reboot will revert it again
#
# Read-only. No signals, no restarts, no repairs: it reports, and a human or the operator's lane
# decides. Exit 0 = both match. Exit 1 = drift (unit shows failed). Exit 2 = cannot tell.
#
#   herdr-binary-guard.sh            one pass (the timer's ExecStart)
#   herdr-binary-guard.sh --pin      pin the current serving build as expected (deploy step)
set -uo pipefail

LAUNCHER="${HERDR_BIN_PATH:-$HOME/.local/bin/herdr}"
STATE="${HERDR_GUARD_STATE:-$HOME/.local/state/pil}"
EXPECTED="$STATE/herdr-expected-binary"
LOG="$STATE/herdr-binary-guard.log"

mkdir -p "$STATE"

sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

serving_pid() {
  # The server process is `herdr server`; its parent is the `herdr` supervisor.
  pgrep -f "herdr server" 2>/dev/null | head -1
}

serving_sha() {
  local pid; pid="$(serving_pid)"
  [ -n "$pid" ] || return 1
  sha "/proc/$pid/exe"
}

if [ "${1:-}" = "--pin" ]; then
  local_sha="$(serving_sha)" || { echo "cannot read the serving herdr binary" >&2; exit 2; }
  printf '%s\n' "$local_sha" > "$EXPECTED"
  echo "pinned expected herdr build: $local_sha"
  exit 0
fi

expected="$(tr -d '[:space:]' < "$EXPECTED" 2>/dev/null)"
if [ -z "$expected" ]; then
  echo "no pinned build at $EXPECTED — run: $0 --pin" >&2
  exit 2
fi

serving="$(serving_sha)" || serving="none"
launcher="$(sha "$LAUNCHER")"
[ -n "$launcher" ] || launcher="missing"

stamp="$(date -Is)"
if [ "$serving" = "$expected" ] && [ "$launcher" = "$expected" ]; then
  printf '%s ok serving=%s launcher=%s\n' "$stamp" "${serving:0:12}" "${launcher:0:12}" >> "$LOG"
  rm -f "$STATE/herdr-binary-guard.MISMATCH"
  exit 0
fi

msg="DRIFT expected=${expected:0:12} serving=${serving:0:12} launcher=${launcher:0:12}"
printf '%s %s\n' "$stamp" "$msg" >> "$LOG"
printf '%s\n' "$msg" > "$STATE/herdr-binary-guard.MISMATCH"
echo "herdr binary drift: $msg" >&2
echo "serving binary:  $( [ "$serving" != "$expected" ] && echo 'NOT the pinned build — a deploy was reverted or the server restarted from an old file')" >&2
echo "launcher binary: $( [ "$launcher" = "$expected" ] || echo 'NOT the pinned build — the next reboot will revert the fleet')" >&2
echo "repair: install the pinned build at $LAUNCHER, then" >&2
echo "  herdr server live-handoff --import-exe <pinned build> --expected-protocol 22 --expected-version 0.9.5" >&2
exit 1
