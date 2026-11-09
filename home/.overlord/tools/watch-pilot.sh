#!/usr/bin/env bash
# Watch a sealed pilot pass. Usage: watch-pilot.sh <pass> [lane-pane]
#
# Emits one event per newly sealed ask turn, then a graded summary — or an explicit
# FAILED line if the driver disappears without producing an artifact, so silence is
# never read as success.
#
# It reports the ASKED-outcome split, not the artifact's `absent` field: a 12-question
# pass grades against 36 expected, so `absent` mixes "never asked" with "asked but
# unanswered" and reads as 24–32 failures when nothing failed. The split is the honest
# number and is computed here from pilot-qids.txt.
set -uo pipefail
PASS="${1:?usage: watch-pilot.sh <pass> [pane]}"
PANE="${2:-w25:p1}"
ROOT=/home/bitnom/bc-restore-qa
cd "$ROOT" || { echo "FAILED: work root missing"; exit 1; }

report() {
  python3 - "$PASS" <<'PY'
import json, os, sys
from collections import Counter
p = sys.argv[1]
f = f'evidence/pass-{p}-graded.json'
d = json.load(open(f))
fo = d.get('folds') or {}
asked = {q.strip() for q in open('pilot-qids.txt') if q.strip() and not q.startswith('#')}
rows = {r['q']: r for r in (d.get('rows') or [])}
split = Counter(rows.get(q, {}).get('class') for q in asked)
never = len([q for q in rows if q not in asked])
print(f"DONE {p} graded ({os.stat(f).st_size}B)")
print(f"  ASKED split ({len(asked)} asked): {dict(split)}")
print(f"  absent={d.get('absent')} = {never} never-asked + {split.get('absent', 0)} asked-but-unanswered")
print(f"  restore_total={d.get('restore_call_total')}  compress={d.get('compress_calls')}")
print(f"  folds={fo.get('folds')} degenerate={fo.get('degenerate_count')} "
      f"max_cov={fo.get('max_coverage')} sessions={fo.get('sessions')} available={fo.get('available')}")
print(f"  manifest={(d.get('corpus_manifest') or {}).get('manifest_sha256')}")
for name, key in (('independence', 'protection_gate'), ('leak', 'protection_gate_attributed')):
    t = (d.get(key) or {}).get('turns') or []
    P = sum(1 for x in t if x.get('verdict') == 'PASS')
    V = sum(1 for x in t if x.get('verdict') == 'VOID')
    print(f"  gate {name}: {P}P/{V}V")
for q in sorted(asked, key=lambda x: int(x[1:])):
    r = rows.get(q, {})
    print(f"    {q} -> {str(r.get('produced'))[:26]:28} {r.get('class')}")
PY
}

prev=-1; first=1

# A graded artifact that predates this run's first turn belongs to a PREVIOUS run and must
# never be reported as this run's result. On 2026-11-04 this watcher fired "DONE a1-b1
# graded / 12 absent / 0P" while the run was still in its ingest phase: pass-a1-b1-graded.json
# was written 17:08:45 by the earlier attempt and the new run did not start until 17:09:11.
# The gate then read 0P/0V simply because no ask turn existed yet — a complete and convincing
# false report, and exactly the stale-artifact class the driver itself still has (#268).
start_epoch() {
  # The run's own start is its first turn file; fall back to the driver's process start.
  local t
  t=$(ls -t evidence/pass-"$PASS"/turn-*.json 2>/dev/null | tail -1)
  if [ -n "$t" ]; then stat -c %Y "$t" 2>/dev/null; return; fi
  local p
  p=$(pgrep -f "drive-sealed.sh $PASS" | head -1)
  [ -n "$p" ] && stat -c %Y /proc/"$p" 2>/dev/null
}
STALE_OK=0
while :; do
  graded="evidence/pass-$PASS-graded.json"
  if [ -f "$graded" ]; then
    g=$(stat -c %Y "$graded" 2>/dev/null || echo 0)
    s=$(start_epoch); s=${s:-0}
    if [ "$g" -ge "$s" ]; then report; exit 0; fi
    if [ "$STALE_OK" -eq 0 ]; then
      echo "ignoring $graded: it predates this run's start (artifact $(( (s-g)/60 ))m older) — waiting for the real one"
      STALE_OK=1
    fi
  fi
  alive=$(ps -eo args 2>/dev/null | grep -F "drive-sealed.sh $PASS" | grep -vE 'grep|ps -eo' | wc -l)
  if [ "$alive" -eq 0 ]; then
    # Before declaring failure, re-check for a graded artifact that IS current — the driver may
    # have finished between the two reads above.
    graded="evidence/pass-$PASS-graded.json"
    if [ -f "$graded" ]; then
      g=$(stat -c %Y "$graded" 2>/dev/null || echo 0)
      s=$(start_epoch); s=${s:-0}
      [ "$g" -ge "$s" ] && { report; exit 0; }
    fi
    echo "FAILED $PASS: driver gone, no CURRENT graded artifact at $(date '+%H:%M:%S')"
    herdr pane read "$PANE" --source recent-unwrapped --lines 20 2>&1 | grep -E 'RESULT|rc=|Error|FAILED' | tail -6
    exit 1
  fi
  n=$(ls evidence/pass-"$PASS"/turn-*-ask.json 2>/dev/null | wc -l)
  if [ "$first" -eq 1 ]; then
    echo "watching $PASS sealed: $n/12 ask turns so far ($(date '+%H:%M:%S'))"
    prev="$n"; first=0
  elif [ "$n" != "$prev" ]; then
    echo "$PASS: $n/12 ask turns sealed ($(date '+%H:%M:%S'))"
    prev="$n"
  fi
  sleep 20
done
