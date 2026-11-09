#!/usr/bin/env bash
# migrate-unnamed-lane — migrate a pane whose pi agent has NO herdr name.
#
# Why a separate script: `herdr agent get <name>` cannot find a lane that was started
# with bare `pi` and never renamed, so migrate-lane.sh refuses it as "absent". Two such
# lanes exist (w1M:p1 `personal-leader`, w1S:p1 `omebian-leader` as of 2026-11-01): the
# agent is live and idle, it simply has no name — the failure mode lane-identity exists
# to prevent. Everything here targets the PANE id, and the relaunch through `pil` is what
# finally gives the lane its name from the tab label.
#
# Same contract as migrate-lane.sh: idle gate, continuation artifact, ctrl+c exit,
# pil inside the target pane, footer verification with retries.
#
# Usage: tools/migrate-unnamed-lane.sh <pane-id> [--skip-continuation]
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
pane="${1:?usage: migrate-unnamed-lane.sh <pane-id> [--skip-continuation]}"
skip_cont="${2:-}"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

field() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)["result"]["agent"]
except Exception: sys.exit(1)
print(d.get(sys.argv[1],""))' "$1"; }

# The pane must be hosting a pi agent, and it must be at a stop boundary.
info=$(herdr agent get "$pane" 2>/dev/null) || { say "FAIL $pane: no agent in that pane"; exit 1; }
tab=$(printf '%s' "$info" | field tab_id)
status=$(printf '%s' "$info" | field agent_status)
label=$(herdr tab get "$tab" 2>/dev/null | python3 -c 'import json,sys
print(json.load(sys.stdin)["result"]["tab"]["label"])')
lane=$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\+/-/g' -e 's/^-//' -e 's/-$//')
case "$lane" in [a-z]*) ;; *) say "REFUSE $pane: label '$label' does not yield a usable lane name"; exit 1 ;; esac
case "$status" in idle|done) ;; *) say "REFUSE $lane: status=$status"; exit 1 ;; esac
cont="$here/../continuations/$lane.md"
mkdir -p "$here/../continuations"
say "start $lane pane=$pane tab=$tab status=$status (unnamed agent)"

if [ "$skip_cont" != "--skip-continuation" ]; then
  before=$(stat -c %Y "$cont" 2>/dev/null || echo 0)
  cat > /tmp/migrate-brief.txt <<EOF
overlord here — one migration step, then you keep your own work.

The fleet now starts lanes through the \`pi\` launcher (\`pil\`), which gives each lane a named profile (13 skills, full control plane) instead of the bare \`pi\` process you are running now. Your lane also has no herdr name at all right now — the relaunch fixes both. It loses this session's context.

Two things, in this order, then stop:

1. Write a continuation prompt to $cont — enough for a fresh session in this same cwd to carry on without you: what you own, what is in flight, verified vs unverified state, file paths / bead ids / run paths that matter, and what your next action would be. Under 60 lines. Write the file; do not paste it back.
2. Reply with exactly: \`continuation written\` and the file's line count.

Do not start new work in this turn. I relaunch your pane immediately after you reply.
EOF
  herdr agent prompt "$pane" "$(cat /tmp/migrate-brief.txt)" >/dev/null 2>&1
  for _ in $(seq 1 300); do
    now=$(stat -c %Y "$cont" 2>/dev/null || echo 0)
    [ "$now" != "$before" ] && { say "continuation written ($(wc -l < "$cont") lines)"; break; }
    sleep 1
  done
  now=$(stat -c %Y "$cont" 2>/dev/null || echo 0)
  [ "$now" != "$before" ] || { say "FAIL $lane: no continuation artifact"; exit 1; }
  for _ in $(seq 1 240); do
    s=$(herdr agent get "$pane" 2>/dev/null | field agent_status)
    { [ "$s" = idle ] || [ "$s" = done ]; } && break
    sleep 1
  done
fi

herdr agent send-keys "$pane" ctrl+c ctrl+c >/dev/null 2>&1
for _ in $(seq 1 40); do herdr agent get "$pane" >/dev/null 2>&1 || break; sleep 0.5; done
herdr agent get "$pane" >/dev/null 2>&1 && { say "FAIL $lane: still alive after ctrl+c"; exit 1; }
say "process exited; relaunching through pil"

# Modes are artifacts now: bare `pil` gives resources and NO role duties. Leader lanes
# must be spawned with PI_MODE=leader.
herdr pane run "$pane" 'PI_MODE=leader pil' >/dev/null 2>&1
ok=""
for _ in $(seq 1 90); do
  s=$(herdr agent get "$lane" 2>/dev/null | field agent_status)
  { [ "$s" = idle ] || [ "$s" = done ]; } && { ok=1; break; }
  sleep 1
done
[ -n "$ok" ] || { say "FAIL $lane: did not return idle with a name after relaunch"; exit 1; }

footer=""
for _ in $(seq 1 20); do
  footer=$(herdr agent read "$lane" --source recent-unwrapped --lines 40 2>&1 | grep -aoE 'rooms: [a-z0-9_-]+( profile: [a-z]+)?' | tail -1)
  case "$footer" in *"profile: leader"*) break ;; esac
  sleep 1
done
case "$footer" in
  *"profile: leader"*) say "OK $lane named + on fleet ($footer)" ;;
  *) say "WARN $lane footer='$footer'"; exit 1 ;;
esac

if [ "$skip_cont" != "--skip-continuation" ]; then
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
    reorient_failed=1
  fi
fi