#!/usr/bin/env bash
# stamp-lane-pane — record which pane a lane occupies on its root bead, for bdi's join.
#
# Why: bdi joins beads to live panes only through bead metadata. The session key is dead for
# pi lanes (its reader requires agent_session.kind == "id"; herdr reports "path"), so the
# working key is `agent_pane`. Proven on a throwaway tracker 2026-11-01: no metadata -> the
# tree hides as "no live agent"; agent_pane set -> joins, source agent_pane.
#
# Idempotent and silent by design: no pane, no root bead, or a missing bd all no-op. It cannot
# misattribute — herdr never reuses a closed pane id — and a lane restarted in the same pane
# needs nothing. Re-run it whenever a pane id changes (a pane moved to another workspace gets
# a new workspace-qualified id).
set -uo pipefail
lane="${1:?usage: stamp-lane-pane.sh <lane>}"

pane=$(herdr agent get "$lane" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["result"]["agent"]["pane_id"])
except Exception: print("")' 2>/dev/null)
[ -n "$pane" ] || exit 0

bead=$(timeout 60 bd -C /home/bitnom list --all --json 2>/dev/null | python3 -c 'import json,sys
lane=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
for b in d:
    if b.get("status")=="closed": continue
    if (b.get("title") or "").startswith(lane+" \u2014"): print(b["id"]); break' "$lane" 2>/dev/null)
[ -n "$bead" ] || exit 0

timeout 60 bd -C /home/bitnom update "$bead" --set-metadata "agent_pane=$pane" >/dev/null 2>&1 || exit 0
printf '%s stamped %s agent_pane=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$bead" "$pane"