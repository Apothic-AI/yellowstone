#!/usr/bin/env bash
# Watch the sealed a1-b1 pilot. Emits one event per newly sealed ask turn, then a
# full summary when the graded artifact lands — and an explicit FAILED line if the
# driver disappears without producing one, so silence is never read as success.
set -uo pipefail
cd /home/bitnom/bc-restore-qa || { echo "FAILED: work root missing"; exit 1; }

prev=-1
first=1
while :; do
  if [ -f evidence/pass-a1-b1-graded.json ]; then
    python3 - <<'PY'
import json, os
f = 'evidence/pass-a1-b1-graded.json'
d = json.load(open(f))
fo = d.get('folds') or {}
print(f"DONE a1-b1 graded ({os.stat(f).st_size}B)")
print(f"  exact/pw/absent/unrelated: {d.get('exact')}/{d.get('plausible_wrong')}/{d.get('absent')}/{d.get('unrelated')}"
      f"   [absent=24 is 36-12 NEVER ASKED, not failures]")
print(f"  restore_total: {d.get('restore_call_total')}  compress: {d.get('compress_calls')}")
print(f"  folds: {fo.get('folds')} degenerate {fo.get('degenerate_count')} "
      f"coverage {fo.get('coverage_pct')} sessions {fo.get('sessions')} available {fo.get('available')}")
print(f"  manifest: {(d.get('corpus_manifest') or {}).get('manifest_sha256')}")
for name, key in (('independence', 'protection_gate'), ('leak', 'protection_gate_attributed')):
    t = (d.get(key) or {}).get('turns') or []
    P = sum(1 for x in t if x.get('verdict') == 'PASS')
    V = sum(1 for x in t if x.get('verdict') == 'VOID')
    print(f"  gate {name}: {P}P/{V}V  " + str([(x.get('turn'), x.get('asked'), x.get('inside_protected')) for x in t]))
PY
    exit 0
  fi

  alive=$(ps -eo args 2>/dev/null | grep -F 'drive-sealed.sh a1-b1' | grep -vE 'grep|ps -eo' | wc -l)
  if [ "$alive" -eq 0 ]; then
    echo "FAILED a1-b1: driver gone, no graded artifact at $(date '+%H:%M:%S')"
    herdr pane read w25:p1 --source recent-unwrapped --lines 20 2>&1 | grep -E 'RESULT|rc=|Error|error|FAILED' | tail -6
    exit 1
  fi

  n=$(ls evidence/pass-a1-b1/turn-*-ask.json 2>/dev/null | wc -l)
  if [ "$first" -eq 1 ]; then
    echo "watching a1-b1 sealed: $n/12 ask turns so far ($(date '+%H:%M:%S'))"
    prev="$n"; first=0
  elif [ "$n" != "$prev" ]; then
    echo "a1-b1: $n/12 ask turns sealed ($(date '+%H:%M:%S'))"
    prev="$n"
  fi
  sleep 20
done
