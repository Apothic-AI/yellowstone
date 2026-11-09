#!/usr/bin/env bash
# rollout-modes — give every role-less leader lane its `leader` role artifact.
#
# Why: `~/AGENTS.md` became role-neutral, and the delegation prose moved into the
# `leader` mode. A lane started with bare `pil` therefore gets resources (profile) and
# NO role duties. The 2026-11-01 profile rollout relaunched 23 leader lanes with bare
# `pil` before this was known, so every one of them is under-specified: fleet profile,
# no mode. This script re-runs them with `PI_MODE=leader`.
#
# Contracts honoured:
#   * `never prompt a working lane` — a lane that is `working` is skipped and re-queued,
#     never interrupted; migrate-lane.sh re-checks and refuses as well.
#   * reserved space excluded by TAB ID before anything else (wE:t19), and this agent's
#     own pane (wE:p1) is never a target.
#   * verification is from the pane's own environment (PI_MODE in /proc/<pid>/environ of
#     the `pi` process), never from the lane's self-report.
#   * continuation: these lanes already handed off minutes ago in
#     tools/../continuations/<lane>.md, so the relaunch skips capture and reorients at
#     that existing file.
#
# Usage: tools/rollout-modes.sh [lane ...]
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.local/state/overlord"
log="$HOME/.local/state/overlord/rollout-modes-$(date -u +%Y%m%dT%H%M%SZ).log"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$log"; }

SELF_PANE="${HERDR_PANE_ID:-wE:p1}"
RESERVED_TAB="wE:t19"

pane_of() { herdr agent get "$1" 2>/dev/null | python3 -c 'import json,sys
try: d=json.load(sys.stdin)["result"]["agent"]; print(d["pane_id"], d["tab_id"], d["agent_status"])
except Exception: print("")'; }

# PI_MODE as the pane's pi process actually carries it.
mode_of_pane() { # $1 = pane id
  local pane="$1" pid e m
  for pid in /proc/[0-9]*; do
    [ "$(cat "$pid/comm" 2>/dev/null)" = "pi" ] || continue
    e=$(tr '\0' '\n' < "$pid/environ" 2>/dev/null) || continue
    case "$e" in
      *"HERDR_PANE_ID=$pane"*)
        m=$(printf '%s\n' "$e" | sed -n 's/^PI_MODE=//p' | head -1)
        printf '%s' "${m:-none}"
        return 0 ;;
    esac
  done
  printf 'no-pi-process'
}

if [ "$#" -gt 0 ]; then
  lanes=("$@")
else
  mapfile -t lanes < <(timeout 180 "$here/leader-board.py" --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin)
for l in d.get("lanes",[]):
    if l.get("pane_id") and l["label"].endswith("-leader"): print(l["label"])')
fi

say "modes rollout: ${#lanes[@]} candidate lane(s); self=$SELF_PANE reserved=$RESERVED_TAB"
restarted=(); skipped=(); failed=(); already=()

for lane in "${lanes[@]}"; do
  read -r pane tab status <<<"$(pane_of "$lane")"
  if [ -z "${pane:-}" ]; then say "SKIP $lane (no live agent)"; skipped+=("$lane(absent)"); continue; fi
  if [ "$pane" = "$SELF_PANE" ]; then say "SKIP $lane (this agent's own pane)"; skipped+=("$lane(self)"); continue; fi
  if [ "$tab" = "$RESERVED_TAB" ]; then say "SKIP $lane (reserved tab $RESERVED_TAB)"; skipped+=("$lane(reserved)"); continue; fi
  case "$status" in
    idle|done) ;;
    *) say "SKIP $lane (status=$status — re-queue at its stop boundary)"; skipped+=("$lane($status)"); continue ;;
  esac
  before=$(mode_of_pane "$pane")
  if [ "$before" = "leader" ]; then say "SKIP $lane (already PI_MODE=leader)"; already+=("$lane"); continue; fi

  say "RESTART $lane pane=$pane tab=$tab mode_before=${before:-none}"
  if out=$("$here/migrate-lane.sh" "$lane" --skip-continuation 2>&1); then
    printf '%s\n' "$out" | tee -a "$log" >/dev/null
    after=$(mode_of_pane "$pane")
    if [ "$after" = "leader" ]; then
      say "OK $lane PI_MODE=leader (env of pane $pane)"
      restarted+=("$lane")
      cont="$here/../continuations/$lane.md"
      if [ -f "$cont" ]; then
    seq_before=$(herdr agent get ""$lane"" 2>/dev/null | python3 -c 'import json,sys
  try: print(json.load(sys.stdin)["result"]["agent"]["state_change_seq"])
  except Exception: print("")')
    herdr agent prompt ""$lane"" "Your pane was relaunched through \`PI_MODE=leader pil\`: same lane, same work, fresh process, and this session has no memory of the previous one. Read $cont first — it is the handoff your previous session wrote — then continue from it, verifying state against the working copy rather than trusting the note." >/dev/null 2>&1
    seq_now="$seq_before"
    for _ in $(seq 1 15); do
      seq_now=$(herdr agent get ""$lane"" 2>/dev/null | python3 -c 'import json,sys
  try: print(json.load(sys.stdin)["result"]["agent"]["state_change_seq"])
  except Exception: print("")')
      [ "$seq_now" != "$seq_before" ] && break
      sleep 1
    done
    if [ "$seq_now" = "$seq_before" ]; then
      # The bytes were written but Enter never landed: the prompt is sitting in the
      # composer of a fresh session that has not seen it. Submit it, then re-check.
      herdr agent send-keys ""$lane"" enter >/dev/null 2>&1
      for _ in $(seq 1 15); do
        seq_now=$(herdr agent get ""$lane"" 2>/dev/null | python3 -c 'import json,sys
  try: print(json.load(sys.stdin)["result"]["agent"]["state_change_seq"])
  except Exception: print("")')
        [ "$seq_now" != "$seq_before" ] && break
        sleep 1
      done
    fi
    if [ "$seq_now" != "$seq_before" ]; then
      say "reoriented "$lane" at $cont (observed turn: seq $seq_before -> $seq_now)"
    else
      say "WARN "$lane": reorientation draft stuck in composer — run tools/submit-stuck-drafts.sh"
    
    fi
      else
        say "no continuation for $lane — left idle, not prompted"
      fi
    else
      say "FAIL $lane: relaunched but PI_MODE=${after:-none} in the pane env"
      failed+=("$lane(mode=$after)")
    fi
  else
    printf '%s\n' "$out" | tee -a "$log" >/dev/null
    say "FAILED $lane"; failed+=("$lane")
  fi
done

say "modes rollout done: restarted=${#restarted[@]} already=${#already[@]} skipped=${#skipped[@]} failed=${#failed[@]}"
[ ${#restarted[@]} -gt 0 ] && say "  restarted: ${restarted[*]}"
[ ${#already[@]}   -gt 0 ] && say "  already:   ${already[*]}"
[ ${#skipped[@]}   -gt 0 ] && say "  skipped:   ${skipped[*]}"
[ ${#failed[@]}    -gt 0 ] && say "  failed:    ${failed[*]}"
say "log: $log"