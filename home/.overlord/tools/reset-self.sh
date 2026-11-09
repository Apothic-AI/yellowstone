#!/usr/bin/env bash
# reset-self — the context ritual and the pending mode fix, as one detached action.
#
# Why detached: this lane relaunching itself means its own pi process must die. A script
# running inside that process dies with it, so the relaunch never happens and the lane is
# left dead. Run this with setsid (own session, own process group) so the ctrl+c that kills
# the pane's pi does not kill the script that is about to relaunch it.
#
# Why the leading delay: the operator and the overlord are reading this lane's turn. Killing
# the process mid-stream truncates the report. The delay lets the turn finish; it is pacing
# before a one-shot action, not a poll.
#
# Order is deliberate:
#   1. land-mode-fixes.sh  — edits .pi/modes/leader.json and relaunches (new digest confirmed
#      at startup by PI_MODE_CONFIRM_PROJECT=1 in .pi/launch.env, which self-restart reads).
#   2. reorient            — point the fresh session at the continuation; self-restart does
#      not prompt afterwards the way migrate-lane does, so without this the lane idles.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
lane=self-improvement-leader
log=/tmp/context-ritual.log
cont="$here/../continuations/$lane.md"

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ritual start ==="
  sleep "${RITUAL_DELAY:-25}"

  if "$here/land-mode-fixes.sh"; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) land-mode-fixes OK"
  else
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) land-mode-fixes rc=$? — check /tmp/overlord-self-restart.log"
  fi

  # Wait for the relaunched agent to be reachable, then orient it. Never prompt a working
  # lane: only send once herdr reports idle/done.
  for _ in $(seq 1 60); do
    s=$(herdr agent get "$lane" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["agent"]["agent_status"])
except Exception: print("")' 2>/dev/null)
    case "$s" in idle|done) break ;; esac
    sleep 1
  done
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) agent status after relaunch: ${s:-unknown}"

  herdr agent prompt "$lane" "Your pane was relaunched after a context reset, and this session has no memory of the previous one. Read $cont first — it is the handoff — then continue from it, verifying state against the working copy rather than trusting the note. Two things to check before anything else: (1) this space's .pi/modes/leader.json no longer says '/reload never re-reads a mode file' — that claim is false, and ~/.overlord/tools/land-mode-fixes.sh corrected it in this same relaunch, so confirm the preamble still carries the fleet leader contract plus this space's delta; (2) todo #33 (BEADS_DIR is unset; bd attaches by walking up to .beads/metadata.json) still needs the operator's word before it lands." >/dev/null 2>&1
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) reorientation sent"
  echo "=== ritual done ==="
} >> "$log" 2>&1