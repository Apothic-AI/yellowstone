#!/usr/bin/env bash
# Watch for a lane's stop boundary, then report the moment it is safe to compact.
#
# WHY: the policy is "at the lane's context reset line run the full compaction procedure", but a prompt
# sent to a `working` lane ABORTS its turn — the one thing that must never happen. So the
# threshold cannot be acted on directly; it has to wait for `idle`/`done`. This turns that
# wait into an event instead of a poll or a blocking sleep.
#
# Usage: watch-until-idle.sh <lane> [ctx_threshold_pct]
# Emits one line when the lane settles (or if it disappears), then exits.
set -uo pipefail
LANE="${1:?usage: watch-until-idle.sh <lane> [ctx_threshold_pct]}"
THRESH="${2:-25}"

agent() {
  herdr agent get "$LANE" 2>/dev/null | python3 -c '
import json,sys
try:
    a=json.load(sys.stdin)["result"]["agent"]
    print(json.dumps({"status": a.get("agent_status") or "unknown", "pane": a.get("pane_id") or ""}))
except Exception:
    sys.exit(1)' 2>/dev/null
}

pane_read() {
  herdr agent read "$1" --source recent-unwrapped --lines 8 2>/dev/null
}

ctx_from() {
  grep -oE '[0-9.]+%/1\.[0-9]+M' | tail -1 | cut -d/ -f1 | tr -d '%'
}

echo "watching $LANE for a stop boundary (threshold ${THRESH}%)"
while :; do
  if ! snapshot=$(agent); then
    echo "GONE $LANE at $(date '+%H:%M:%S') — agent state unavailable"
    exit 1
  fi
  s=$(printf '%s' "$snapshot" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  pane=$(printf '%s' "$snapshot" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pane"])')
  case "$s" in
    idle|done|blocked)
      if [ -z "$pane" ] || ! output=$(pane_read "$pane"); then
        echo "UNKNOWN $LANE status=$s at $(date '+%H:%M:%S') — pane evidence unavailable"
        exit 2
      fi
      c=$(printf '%s\n' "$output" | ctx_from)
      if printf '%s\n' "$output" | grep -Fq 'Compacting context'; then
        echo "ACTIVE $LANE status=$s ctx=${c:-?}% at $(date '+%H:%M:%S') — compaction still running"
        exit 2
      fi
      if ! printf '%s\n' "$output" | grep -Eq '[0-9.]+%/1\.[0-9]+M.*(profile:|mode:)'; then
        echo "UNKNOWN $LANE status=$s ctx=${c:-?}% at $(date '+%H:%M:%S') — no recognizable settled footer"
        exit 2
      fi
      if [ "$s" = blocked ]; then
        echo "BLOCKED $LANE ctx=${c:-?}% at $(date '+%H:%M:%S') — needs input before any compaction"
        exit 0
      fi
      echo "READY $LANE status=$s ctx=${c:-?}% at $(date '+%H:%M:%S') — pane footer confirms settled state"
      exit 0 ;;
    gone)
      echo "GONE $LANE at $(date '+%H:%M:%S') — no process"
      exit 1 ;;
  esac
  sleep 20
done
