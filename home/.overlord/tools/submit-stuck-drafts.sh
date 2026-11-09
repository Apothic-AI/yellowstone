#!/usr/bin/env bash
# submit-stuck-drafts — deliver a reorientation prompt that was typed but never sent.
#
# The failure this exists for: `herdr agent prompt <lane> <text>` reports success when the
# bytes are written, but the Enter that submits them does not always land. The lane then
# sits idle with a full prompt in its composer and a fresh session that never saw it — and
# the rollout log says "reoriented", because the log was written from intent, not from an
# observed turn. Observed 2026-11-01 on lynx-leader and ~9 other leader lanes.
#
# Safety:
#   * Only a draft containing OUR marker is submitted ("Your pane was relaunched through").
#     Anything else — the operator's own typing, a half-written note — is reported and left
#     untouched. Submitting someone else's draft sends mail they did not send.
#   * Never touches a `working` or `blocked` lane. A blocked lane is a human's dialog.
#   * Success requires an observed lifecycle change, not an exit code.
#
# Usage: tools/submit-stuck-drafts.sh [pane-or-lane ...]   (default: every -leader lane)
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.local/state/overlord"
log="$HOME/.local/state/overlord/stuck-drafts-$(date -u +%Y%m%dT%H%M%SZ).log"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$log"; }
MARKER='Your pane was relaunched through'

status_of() { herdr agent get "$1" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["agent"]["agent_status"])
except Exception: print("absent")'; }

if [ "$#" -gt 0 ]; then
  targets=("$@")
else
  mapfile -t targets < <(herdr agent list 2>/dev/null | python3 -c 'import json,sys
for a in json.load(sys.stdin)["result"]["agents"]:
    n=a.get("name") or ""
    if n.endswith("-leader"): print(a["pane_id"])')
fi

say "stuck-draft scan: ${#targets[@]} pane(s); log=$log"
submitted=(); left=(); none=(); failed=()

for target in "${targets[@]}"; do
  st=$(status_of "$target")
  [ "$st" = "absent" ] && { say "SKIP $target (no agent)"; none+=("$target(absent)"); continue; }
  case "$st" in
    working|blocked) say "SKIP $target (status=$st — not ours to interrupt)"; left+=("$target($st)"); continue ;;
  esac
  visible=$(herdr pane read "$target" --source visible --lines 60 2>/dev/null)
  case "$visible" in
    *"$MARKER"*) ;;
    *) say "SKIP $target (no reorientation draft in the composer)"; none+=("$target") ; continue ;;
  esac

  herdr agent send-keys "$target" enter >/dev/null 2>&1
  ok=""
  for _ in $(seq 1 20); do
    s=$(status_of "$target")
    case "$s" in working|blocked) ok=1; break ;; esac
    sleep 1
  done
  if [ -n "$ok" ]; then
    say "SUBMITTED $target -> status=$s"
    submitted+=("$target")
  else
    say "FAIL $target: draft present, Enter did not start a turn (status=$s)"
    failed+=("$target")
  fi
done

say "done: submitted=${#submitted[@]} left_alone=${#left[@]} no_draft=${#none[@]} failed=${#failed[@]}"
[ ${#submitted[@]} -gt 0 ] && say "  submitted: ${submitted[*]}"
[ ${#left[@]} -gt 0 ] && say "  left:      ${left[*]}"
[ ${#none[@]} -gt 0 ] && say "  no draft:  ${none[*]}"
[ ${#failed[@]} -gt 0 ] && say "  failed:    ${failed[*]}"
say "log: $log"