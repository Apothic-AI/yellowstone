#!/usr/bin/env bash
# Live-TUI harness for pi-pretty-tui's composer selection.
#
# Runs the real `pi` binary inside a real terminal (an isolated tmux server) with
# the extension loaded *from this working tree*, then drives it with raw key
# bytes and reads back the rendered screen with `tmux capture-pane`. This is the
# evidence class the regression suite cannot produce: the suite instantiates
# editor components, so it cannot see whether an editor-owning extension
# (pi-paster installs a `PasterEditor extends CustomEditor` subclass) bypasses a
# `CustomEditor.prototype` patch at runtime.
#
#   ./harness.sh up            # start the session (idempotent)
#   ./harness.sh screen        # plain-text rendered screen
#   ./harness.sh screen-ansi   # rendered screen with SGR attributes
#   ./harness.sh type 'text'   # literal keystrokes
#   ./harness.sh keys HEX...   # raw bytes, e.g. 1b 5b 44
#   ./harness.sh down          # kill the session and delete the temp agent dir
set -uo pipefail

SOCK=ppt-live
SESSION=live
ROOT=/tmp/ppt-live
AGENT="$ROOT/agent"
WORK="$ROOT/work"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PASTER=/home/bitnom/.pi/agent/npm/node_modules/pi-paster

up() {
  mkdir -p "$AGENT" "$WORK"
  python3 - "$REPO" "$PASTER" "$AGENT/settings.json" <<'PY'
import json, os, sys
repo, paster, dest = sys.argv[1:4]
src = json.load(open(os.path.expanduser("~/.pi/agent/settings.json")))
# Keep the model/theme/terminal config so pi boots straight to the composer, but
# load only the two extensions under test. No npm:/git: entries, so nothing is
# installed and nothing reaches the network at load time.
keep = {k: v for k, v in src.items() if k not in {"packages", "skills", "defaultTools"}}
keep["packages"] = [repo, paster]
keep["defaultTools"] = []
keep["skills"] = []
keep["collapseChangelog"] = True
keep["lastChangelogVersion"] = src.get("lastChangelogVersion", "0.0.0")
json.dump(keep, open(dest, "w"), indent=2)
PY
  tmux -L "$SOCK" kill-server 2>/dev/null
  tmux -L "$SOCK" new-session -d -s "$SESSION" -x "${COLS:-170}" -y "${ROWS:-48}" \
    "cd $WORK && PI_CODING_AGENT_DIR=$AGENT exec pi"
  # Wait for the composer frame to paint. The rounded frame comes from the
  # extension, so a painted frame is also proof the extension loaded.
  local i
  for i in $(seq 1 120); do
    if tmux -L "$SOCK" capture-pane -p -t "$SESSION" 2>/dev/null | grep -q '╭'; then
      echo "up: composer frame painted after ${i} ticks"
      return 0
    fi
    sleep 0.25
  done
  echo "up: FAILED — no frame painted in 30s" >&2
  tmux -L "$SOCK" capture-pane -p -t "$SESSION" 2>/dev/null | tail -20 >&2
  return 1
}

case "${1:-}" in
  up) up ;;
  screen) shift; tmux -L "$SOCK" capture-pane -p -t "$SESSION" "$@" ;;
  screen-ansi) tmux -L "$SOCK" capture-pane -p -e -t "$SESSION" ;;
  type) shift; tmux -L "$SOCK" send-keys -t "$SESSION" -l -- "$*" ;;
  keys) shift; tmux -L "$SOCK" send-keys -t "$SESSION" -H "$@" ;;
  down)
    tmux -L "$SOCK" kill-server 2>/dev/null
    rm -rf "$ROOT"
    echo "down: session killed, $ROOT removed" ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac