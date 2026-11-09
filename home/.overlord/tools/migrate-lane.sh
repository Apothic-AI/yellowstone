#!/usr/bin/env bash
# migrate-lane — move one leader lane from bare `pi` onto the profiled launcher,
# preserving its work as a continuation note, and reorient it afterwards.
#
# Sequence (each step verified, not assumed):
#   1. refuse unless idle/done and the tab label slugifies to the lane name
#   2. ask the lane to write continuations/<lane>.md, wait for the artifact on disk
#   3. quit pi (ctrl+c twice — `/exit` is not a pi command and just burns a turn)
#   4. `pil` inside the target pane (never from our own pane: pil derives the name
#      from the pane's tab label, and a child claiming our name deregisters us)
#   5. verify `profile: leader` in the footer
#   6. reorient the fresh session at its continuation file
#
# Usage: tools/migrate-lane.sh <lane-name> [--skip-continuation]
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
lane="${1:?usage: migrate-lane.sh <lane-name> [--skip-continuation]}"
skip_cont="${2:-}"
cont="$here/../continuations/$lane.md"
mkdir -p "$here/../continuations"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

field() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)["result"]["agent"]
except Exception: sys.exit(1)
print(d.get(sys.argv[1],""))' "$1"; }

info=$(herdr agent get "$lane" 2>/dev/null) || { say "FAIL $lane: no live agent"; exit 1; }
pane=$(printf '%s' "$info" | field pane_id)
tab=$(printf '%s' "$info" | field tab_id)
status=$(printf '%s' "$info" | field agent_status)
label=$(herdr tab get "$tab" 2>/dev/null | python3 -c 'import json,sys
print(json.load(sys.stdin)["result"]["tab"]["label"])')
slug=$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\+/-/g' -e 's/^-//' -e 's/-$//')
[ "$slug" = "$lane" ] || { say "REFUSE $lane: tab label '$label' slugifies to '$slug'"; exit 1; }
case "$status" in idle|done) ;; *) say "REFUSE $lane: status=$status (needs a stop boundary)"; exit 1 ;; esac
say "start $lane pane=$pane tab=$tab status=$status"

if [ "$skip_cont" != "--skip-continuation" ]; then
  before=$(stat -c %Y "$cont" 2>/dev/null || echo 0)
  cat > /tmp/migrate-brief.txt <<EOF
overlord here — one migration step, then you keep your own work.

The fleet now starts lanes through the \`pi\` launcher (\`pil\`), which gives each lane a named profile (13 skills, full control plane) instead of the bare \`pi\` process you are running now. You can only pick up a profile by relaunching, which loses this session's context.

Two things, in this order, then stop:

1. Write a continuation prompt to $cont — enough for a fresh session in this same cwd to carry on without you: what you own, what is in flight, verified vs unverified state, file paths / bead ids / run paths that matter, and what your next action would be. Under 60 lines. Write the file; do not paste it back.
2. Reply with exactly: \`continuation written\` and the file's line count.

Do not start new work in this turn. I relaunch your pane immediately after you reply.
EOF
  herdr agent prompt "$lane" "$(cat /tmp/migrate-brief.txt)" >/dev/null 2>&1
  for _ in $(seq 1 240); do
    now=$(stat -c %Y "$cont" 2>/dev/null || echo 0)
    [ "$now" != "$before" ] && { say "continuation written ($(wc -l < "$cont") lines)"; break; }
    sleep 1
  done
  now=$(stat -c %Y "$cont" 2>/dev/null || echo 0)
  [ "$now" != "$before" ] || { say "FAIL $lane: no continuation artifact after 240s"; exit 1; }
  # the turn that wrote it must also have settled before we kill the process
  for _ in $(seq 1 60); do
    s=$(herdr agent get "$lane" 2>/dev/null | field agent_status)
    [ "$s" = idle ] || [ "$s" = done ] && break
    sleep 1
  done
fi

herdr agent send-keys "$lane" ctrl+c ctrl+c >/dev/null 2>&1
for _ in $(seq 1 40); do herdr agent get "$lane" >/dev/null 2>&1 || break; sleep 0.5; done
herdr agent get "$lane" >/dev/null 2>&1 && { say "FAIL $lane: still alive after ctrl+c"; exit 1; }
say "process exited; relaunching through pil"

# Modes are artifacts now: a lane needs PI_MODE to get its role duties, and bare `pil`
# gives it resources (profile) with no role at all. Leader lanes get PI_MODE=leader.
# A space may need a composed launch (a project mode overlay, an extra profile flag).
# <cwd>/.pi/launch.env holds the env prefix for this lane; without it the default leader
# launch applies. The composed form is all-or-nothing: a rejected overlay falls back to the
# native base prompt and the lane loses its whole role contract, so the stderr check below
# is not optional.
cwd=$(printf '%s' "$info" | field cwd)
if [ -n "${cwd:-}" ] && [ -f "$cwd/.pi/launch.env" ]; then
  launch="$(cat "$cwd/.pi/launch.env") pil"
  say "launch env from $cwd/.pi/launch.env"
else
  launch="PI_MODE=leader pil"
fi
herdr pane run "$pane" "$launch" >/dev/null 2>&1
ok=""
for _ in $(seq 1 90); do
  s=$(herdr agent get "$lane" 2>/dev/null | field agent_status)
  { [ "$s" = idle ] || [ "$s" = done ]; } && { ok=1; break; }
  sleep 1
done
[ -n "$ok" ] || { say "FAIL $lane: did not return idle after relaunch"; exit 1; }

# 3. Verify from the footer — profile and rooms identity are what this was for.
#    Retry: the footer line lands a beat after the agent reports idle, and one early
#    read reported 'profile not leader' for dxdb-leader that was already on leader.
# Composition check: a rejected overlay or missing confirmation leaves the lane role-less with
# one stderr line. Catch it here rather than discovering it when a lane misbehaves.
sleep 1
if herdr pane read "$pane" --source recent-unwrapped --lines 30 2>/dev/null | grep -qiE "composition is invalid|not confirmed|overlay mode was unavailable"; then
  say "FAIL $lane: mode composition rejected at launch — the lane has NO role contract"
  exit 1
fi

footer=""
for _ in $(seq 1 20); do
  footer=$(herdr agent read "$lane" --source recent-unwrapped --lines 40 2>&1 | grep -aoE 'rooms: [a-z0-9_-]+( profile: [a-z]+)?' | tail -1)
  case "$footer" in *"profile: leader"*) break ;; esac
  sleep 1
done
case "$footer" in
  *"profile: leader"*) say "OK $lane on fleet ($footer)" ;;
  *) say "WARN $lane footer='$footer' — profile not fleet"; exit 1 ;;
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

# bdi attribution: record the pane on the lane's root bead so the dashboard can join.
# Idempotent and a no-op when the lane has no root bead.
"$(dirname "$0")/stamp-lane-pane.sh" "$lane" >>"$HOME/.local/state/overlord/stamp.log" 2>&1 || true
