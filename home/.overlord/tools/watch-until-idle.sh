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
case "${1:-}" in
  -h|--help)
    sed -n "2,10p" "$0" | sed "s/^#[ ]*//"
    exit 0
    ;;
esac
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

ctx_now() {
  # Context occupancy and the settled footer are recorded (T-3, M-1/M-3). Asking the screen
  # meant harvesting 8 lines on every poll (FT-71).
  /home/bitnom/.overlord/tools/lane-fields "$1" ctx 2>/dev/null
}

footer_now() {
  /home/bitnom/.overlord/tools/lane-fields "$1" footer 2>/dev/null
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
      if [ -z "$pane" ]; then
        echo "UNKNOWN $LANE status=$s at $(date '+%H:%M:%S') — pane evidence unavailable"
        exit 2
      fi
      c=$(ctx_now "$LANE")
      foot=$(footer_now "$LANE")
      # The compaction banner is a transient TUI line and is not in the record, so this one read
      # stays a screen read; --source visible never harvests (FT-71).
      screen=$(/home/bitnom/.overlord/tools/pane-read "$pane" \
        --reason "the compaction banner is drawn, not recorded" --lines 12 2>/dev/null || true)
      if printf '%s\n' "$screen" | grep -Fq 'Compacting context'; then
        echo "ACTIVE $LANE status=$s ctx=${c:-?}% at $(date '+%H:%M:%S') — compaction still running"
        exit 2
      fi
      if [ -z "$foot" ]; then
        echo "UNKNOWN $LANE status=$s ctx=${c:-?}% at $(date '+%H:%M:%S') — no recorded settled footer"
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
