#!/usr/bin/env bash
# rollout-profiles — migrate every still-idle leader lane onto the profiled launcher.
#
# Wraps tools/migrate-lane.sh, which owns the per-lane contract (idle gate, tab-label
# name check, continuation artifact, ctrl+c exit, pil in the target pane, footer
# verification). This script only decides order and reports, so a refusal on one lane
# never stops the rest.
#
# Lanes that are `working` are skipped, not forced: killing an in-flight turn is
# destructive, and a skipped lane comes back on the next rollout pass or its own
# natural restart. Lanes already showing `profile: leader` in the footer are skipped
# too, so re-running this is idempotent rather than churn.
#
# Usage: tools/rollout-profiles.sh [lane ...]     (no args = every lane the board lists)
#   Log: /home/bitnom/.local/state/overlord/rollout-<UTC>.log
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.local/state/overlord"
log="$HOME/.local/state/overlord/rollout-$(date -u +%Y%m%dT%H%M%SZ).log"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$log"; }

if [ "$#" -gt 0 ]; then
  lanes=("$@")
else
  mapfile -t lanes < <(timeout 180 "$here/leader-board.py" --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin)
for l in d.get("lanes",[]):
    if l.get("pane_id"): print(l["label"])')
fi

say "rollout start: ${#lanes[@]} candidate lane(s); log=$log"

migrated=(); skipped=(); failed=()
for lane in "${lanes[@]}"; do
  status=$(herdr agent get "$lane" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["agent"]["agent_status"])
except Exception: print("")' 2>/dev/null)
  case "$status" in
    idle|done) ;;
    *) say "SKIP $lane (status=${status:-absent})"; skipped+=("$lane"); continue ;;
  esac
  # Idempotence: a lane already on a profile must not be restarted again.
  footer=$(herdr agent read "$lane" --source recent-unwrapped --lines 40 2>&1 | grep -aoE 'profile: [a-z]+' | tail -1)
  if [ "$footer" = "profile: leader" ]; then
    say "SKIP $lane (already fleet)"; skipped+=("$lane"); continue
  fi
  if out=$("$here/migrate-lane.sh" "$lane" 2>&1); then
    printf '%s\n' "$out" | tee -a "$log" >/dev/null
    say "MIGRATED $lane"
    migrated+=("$lane")
  else
    printf '%s\n' "$out" | tee -a "$log" >/dev/null
    say "FAILED $lane"
    failed+=("$lane")
  fi
done

say "rollout done: migrated=${#migrated[@]} skipped=${#skipped[@]} failed=${#failed[@]}"
[ ${#migrated[@]} -gt 0 ] && say "  migrated: ${migrated[*]}"
[ ${#skipped[@]}  -gt 0 ] && say "  skipped:  ${skipped[*]}"
[ ${#failed[@]}   -gt 0 ] && say "  failed:   ${failed[*]}"
say "log: $log"