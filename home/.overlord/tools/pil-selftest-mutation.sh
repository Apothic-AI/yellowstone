#!/usr/bin/env bash
# pil-selftest-mutation — prove that pil's role selftests can actually FAIL.
#
# WHY THIS EXISTS
# ---------------
# Three role cases once reported `ok` unconditionally: one printed a literal with no
# assertion, two asserted that a file the test itself had just written existed. The suite
# printed "all tests passed" while the role logic could have been completely broken. A
# green that cannot go red is not evidence — so the fix is not "the tests pass now", it is
# "here is the mutation that makes them fail, and it is reproducible by anyone".
#
# This script mutates a COPY of bin/pil, never the real one, and asserts:
#   1. unmodified copy            -> suite exits 0
#   2. worker guard deleted       -> suite exits 1 AND names "worker not promoted"
#   3. value regex replaced by    -> suite exits 1 AND the hostile value reaches the export
#      `true`                        (proves the regex is what blocks it, not something else)
#
# Checking exit codes alone is not enough: a mutation could make the suite fail for an
# unrelated reason (a syntax error, a missing fixture) and look like a successful proof.
# So each mutation also asserts the failing case NAME, which is the only part that shows
# the right thing broke.
#
# Usage: tools/pil-selftest-mutation.sh
# Exit: 0 all mutations behaved as required; 1 otherwise.

set -uo pipefail
SRC="${1:-$(dirname "$0")/../bin/pil}"
[ -r "$SRC" ] || { echo "FAIL cannot read $SRC" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fails=0
say() { printf '%s\n' "$*"; }

# Run a copy of pil's selftest; echo "rc=<n>", with output in $work/out
run() {
  local f="$1"
  bash "$f" --selftest >"$work/out" 2>&1
  echo "rc=$?"
}
has() { grep -qF -- "$1" "$work/out"; }

say "source: $SRC"
say "work:   $work"
say

# --- 1. baseline -----------------------------------------------------------------
cp "$SRC" "$work/base"
res="$(run "$work/base")"
if [ "$res" = "rc=0" ]; then
  say "ok   unmodified copy passes ($res)"
else
  say "FAIL unmodified copy should pass, got $res"
  sed -n '1,40p' "$work/out" | sed 's/^/     /'
  fails=$((fails + 1))
fi
# The baseline must ALSO show the hardened cases, otherwise we are proving nothing about
# them (e.g. running an older pil that lacks them).
for label in "leader fallback to launch.env" "worker not promoted" "hostile value rejected"; do
  if has "$label"; then
    say "ok   baseline covers: $label"
  else
    say "FAIL baseline lacks the case: $label (old pil?)"
    fails=$((fails + 1))
  fi
done
say

# --- 2. mutation: delete the worker guard ----------------------------------------
# restore_role refuses the launch.env fallback for non-leader names via
#     case "$name" in *-leader|overlord) ;; *) return 0 ;; esac
# Turn the leader arm into a no-op so every name proceeds to the fallback.
cp "$SRC" "$work/m1"
python3 - "$work/m1" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
# Literal guard: make the leader arm unreachable so every name falls through to the
# launch.env fallback. Fail loudly on a patch miss — a silently unpatched copy makes the
# suite pass and the script would blame the tests for the patch's mistake.
needle = '    *-leader|overlord) ;;'
n = s.count(needle)
if n != 1:
    sys.stderr.write(f'PATCH FAILED: expected 1 worker guard, found {n}\n')
    sys.exit(3)
s = s.replace(needle, '    *|*-leader|overlord) ;;')
open(p, 'w').write(s)
print(n)
PY
if [ $? -ne 0 ]; then
  say "FAIL worker-guard mutation could not be applied (patch failure, not a test result)"
  fails=$((fails + 1))
fi
res="$(run "$work/m1")"
if [ "$res" = "rc=1" ] && has "FAIL worker not promoted"; then
  say "ok   worker guard deleted -> rc=1 and 'worker not promoted' fails"
else
  say "FAIL worker-guard mutation: expected rc=1 + 'FAIL worker not promoted', got $res"
  grep -E '^(ok|FAIL)' "$work/out" | sed 's/^/     /'
  fails=$((fails + 1))
fi
say

# --- 3. mutation: value regex accepts everything ---------------------------------
# The guard is:  if [[ "$val" =~ ^[A-Za-z0-9_-]+$ ]]; then
# Replacing it with `true` must let a hostile value (PI_MODE=$(rm)) through to the export,
# which the hardened case detects. This is the mutation that proves the regex is load-bearing.
cp "$SRC" "$work/m2"
python3 - "$work/m2" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
# Literal, not regex: the guard text contains regex metacharacters, and an over-clever
# pattern silently matched 0 times during development — the "mutated" copy was then the
# original, the suite passed, and the script blamed the tests instead of the patch. Two
# occurrences exist (role record, then launch.env); require exactly that.
needle = 'if [[ "$val" =~ ^[A-Za-z0-9_-]+$ ]]; then'
n = s.count(needle)
if n != 2:
    sys.stderr.write(f'PATCH FAILED: expected 2 occurrences of the value guard, found {n}\n')
    sys.exit(3)
s = s.replace(needle, 'if true; then')
open(p, 'w').write(s)
print(n)
PY
if [ $? -ne 0 ]; then
  say "FAIL regex mutation could not be applied (patch failure, not a test result)"
  fails=$((fails + 1))
fi
res="$(run "$work/m2")"
if [ "$res" = "rc=1" ] && has "FAIL hostile value rejected"; then
  say "ok   value regex -> true -> rc=1 and 'hostile value rejected' fails"
  grep -E 'FAIL hostile value rejected' "$work/out" | sed 's/^/     /'
else
  say "FAIL regex mutation: expected rc=1 + 'FAIL hostile value rejected', got $res"
  grep -E '^(ok|FAIL)' "$work/out" | sed 's/^/     /'
  fails=$((fails + 1))
fi
say

if [ "$fails" -eq 0 ]; then
  say "PROVEN: the role selftests fail when the role logic is broken, and pass when it is not."
  say "The proof is reproducible: re-run this script against the same commit."
  exit 0
fi
say "$fails mutation check(s) failed — the tests may not be proving what they claim."
exit 1
