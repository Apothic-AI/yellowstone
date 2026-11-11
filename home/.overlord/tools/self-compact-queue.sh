#!/usr/bin/env bash
# Queue-based self-compaction. A prompt to a working lane QUEUES behind the live turn
# (operator ruling 2026-11-09), so no idle gate is needed and none can deadlock.
set -uo pipefail
LANE=overlord
HANDOFF=/home/bitnom/.overlord/continuations/overlord-continuation-2026-11-11T0025Z.md
SESSION=/home/bitnom/.pi/agent/sessions/--home-bitnom-.overlord--/2026-11-08T22-48-04-177Z_01a1bd58-ed51-70c2-97a7-79354c8745c6.jsonl
STAMP=$(date -u +%Y%m%dT%H%M%SZ); OUT=/home/bitnom/.local/state/overlord
LOG="$OUT/self-compact-queue-$STAMP.log"; RESULT="$OUT/self-compact-queue-$STAMP.json"
mkdir -p "$OUT"
say(){ printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG"; }
want=a9761c12730a2c7220838c2bcf6120b992220fb3b5e3615238ef006a63752014
have=$(sha256sum "$HANDOFF" 2>/dev/null | cut -d' ' -f1)
[ "$have" = "$want" ] || { say "FAIL handoff sha=$have"; printf '{"state":"failed","reason":"handoff sha","at":"%s"}\n' "$(date -u +%FT%TZ)" >"$RESULT"; exit 1; }
before=$(jq -s '[.[]|select(.type=="compaction")]|length' "$SESSION" 2>/dev/null || echo 0)
say "handoff ok; events before=$before; sending /compact (queues behind live turn)"
herdr agent prompt "$LANE" '/compact' >/dev/null 2>&1 || { say "FAIL prompt"; printf '{"state":"failed","reason":"prompt","at":"%s"}\n' "$(date -u +%FT%TZ)" >"$RESULT"; exit 1; }
deadline=$((SECONDS+1500))
while :; do
  now=$(jq -s '[.[]|select(.type=="compaction")]|length' "$SESSION" 2>/dev/null || echo "$before")
  if [ "${now:-0}" -gt "$before" ]; then
    ev=$(jq -rc 'select(.type=="compaction")|{t:.timestamp,from:.tokensBefore,id:.id}' "$SESSION" | tail -1)
    say "EVENT $ev"; printf '{"state":"confirmed","before":%s,"after":%s,"event":%s,"handoff":"%s","at":"%s"}\n' "$before" "$now" "$ev" "$HANDOFF" "$(date -u +%FT%TZ)" >"$RESULT"
    herdr agent prompt "$LANE" "[self-scheduled wake from the deferred self-compaction helper - not from the operator] You were compacted in this same session. Read the EXACT live handoff IN FULL now: $HANDOFF (106 lines, sha256 a9761c12...). Reply confirming (a) full read of that exact file, (b) your numeric context now, (c) that you resume coordination. Nothing else changes: FT22 stays RED, FT47 accounting open, FT15 live adoption refused, FT13 helpers unused, holds w2 and reserved wE:t19 untouched." >/dev/null 2>&1
    say "wake sent"; exit 0
  fi
  [ $SECONDS -ge $deadline ] && { say "FAIL no event in 25m"; printf '{"state":"failed","reason":"no-event","at":"%s"}\n' "$(date -u +%FT%TZ)" >"$RESULT"; exit 1; }
  sleep 10
done
