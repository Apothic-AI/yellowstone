#!/usr/bin/env bash
# verify-fleet-doc.sh — the document-history tool, and the two things it must never become.
#
# FT-82: `~/Documents/Assistant/Fleet TODOs.md` had no version control. Fifteen lanes edited it
# three at a time during the 2026-11-17 push and the only net was a 30s snapshot loop, so a
# read-modify-write race could lose a section with nothing anywhere to say so. `fleet-doc` captures
# each observed state as a commit, raises an ALARM when a captured section disappears, and restores
# it from history.
#
# Three properties are pinned here, and the last two are regressions this tool actually shipped
# during its own development — they are in this file because they happened, not because they were
# foreseen:
#
#   1. CONCURRENCY, ALARM, RECOVERY — the tool's own selftest: two lock-serialized appends both
#      land; a stale read-modify-write that eats a section makes the next capture commit an
#      `ALARM:` subject and log a recovery command; `recover` puts the exact bytes back in place.
#
#   2. IT NAMES NO DOCUMENT. The first version hardcoded the operator's `Fleet TODOs.md` path as
#      its default. This tool is mirrored into `home/.overlord/tools/`, which is published to a
#      PUBLIC repository — so that default published the shape of the operator's home directory for
#      no benefit, and made the tool wrong for every other document on its second use. `--doc` or
#      $FLEET_DOC is required, and no `/home/<user>` path may appear in the shipped bytes.
#
#   3. A CAPTURE COMMITS THE BYTES IT HASHED. `git add` + `git commit -- <path>` commits whatever
#      is on disk at commit time, so a writer landing between the read and the commit is folded in
#      under a message describing the OLDER content — a capture log that states something false.
#      The capture builds a tree from the blob it read and moves the ref with a compare-and-swap.
#      The selftest's T4/T5 exercise that path; the false-record case is checked here structurally
#      (the capture must use `commit-tree` + `update-ref`, never a bare `git commit`).
#
# Hermetic: the selftest builds its own throwaway repositories under a temp dir and never reads or
# writes a real document. Runs on a live machine and in a container with no git identity configured.
set -uo pipefail

REPO="$(cd "$(dirname -- "$0")/.." && pwd)"
TOOL="${FLEET_DOC_TOOL:-$REPO/home/.overlord/tools/fleet-doc}"
LIVE="$HOME/.overlord/tools/fleet-doc"
FAILED=0
PASSED=0

pass() { PASSED=$((PASSED + 1)); echo "ok   $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL $1"; shift; for line in "$@"; do printf '%s\n' "$line" | sed 's/^/     /'; done; }

[ -f "$TOOL" ] || { fail "the shipped tool exists at home/.overlord/tools/fleet-doc" "$TOOL is missing"; echo; echo "FAILED 1"; exit 1; }

# ---------------------------------------------------------------- 1. selftest
OUT="$(python3 "$TOOL" selftest 2>&1)"
RC=$?
if [ "$RC" = 0 ]; then
  pass "selftest: concurrency, alarm and recovery all pass ($(printf '%s' "$OUT" | grep -c '^PASS') checks)"
else
  fail "selftest exits 0" "exit=$RC" "$OUT"
fi
# The selftest must actually exercise each of the three, not merely pass. A selftest that lost its
# race case would still print PASSED and still exit 0.
for probe in \
  "T1 both concurrent appends present|lock-serialized writes both land" \
  "T2 capture raised an alarm|a lost section is reported" \
  "T3 recover restored the exact text|the lost bytes come back"
do
  name="${probe%%|*}"; desc="${probe#*|}"
  if printf '%s' "$OUT" | grep -q "^PASS  $name"; then
    pass "$desc"
  else
    fail "$desc" "no 'PASS  $name' line in the selftest output:" "$OUT"
  fi
done
if printf '%s' "$OUT" | grep -q '^FAIL '; then
  fail "selftest reports no failures" "$(printf '%s' "$OUT" | grep '^FAIL ')"
fi

# ------------------------------------------- 2. the shipped tool names no document
if grep -q '/home/[a-z]' "$TOOL"; then
  fail "shipped tool contains no /home/<user> path" \
    "this tree is published to a public repository; found:" \
    "$(grep -n '/home/[a-z]' "$TOOL" | head -5)"
else
  pass "shipped tool contains no /home/<user> path"
fi

ERR="$(env -u FLEET_DOC python3 "$TOOL" capture 2>&1)"
if printf '%s' "$ERR" | grep -q 'name the document with --doc'; then
  pass "capture with no document named explains itself instead of guessing"
else
  fail "capture with no document named fails cleanly" "expected the '--doc or \$FLEET_DOC' message, got:" "$ERR"
fi
if printf '%s' "$ERR" | grep -q 'Traceback'; then
  fail "no traceback when the document is unnamed" "$ERR"
else
  pass "no traceback when the document is unnamed"
fi

# ------------------------------------------- 3. a capture commits the bytes it hashed
if grep -q 'commit-tree' "$TOOL" && grep -q 'update-ref' "$TOOL"; then
  pass "capture commits the exact blob it hashed (commit-tree + compare-and-swap update-ref)"
else
  fail "capture commits the exact blob it hashed" \
    "expected commit-tree and update-ref in the capture path; a bare 'git commit -- <path>'"
fi

# ------------------------------------------- 4. the live install is the same bytes
# The mirror gate owns mirror-vs-live direction; this only reports, so a lane editing the live copy
# to debug sees why its change is not in the repository.
if [ -f "$LIVE" ]; then
  if cmp -s "$TOOL" "$LIVE"; then
    pass "the live install at ~/.overlord/tools/fleet-doc is byte-identical to this tree"
  else
    fail "the live install matches this tree" \
      "~/.overlord/tools/fleet-doc differs — run: cp $TOOL $LIVE"
  fi
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "FAILED $FAILED of $((PASSED + FAILED))"
  exit 1
fi
echo "gate passed: $PASSED checks; the document tool locks its writes, alarms on a lost section, and names no document of its own"
