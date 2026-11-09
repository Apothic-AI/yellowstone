#!/usr/bin/env bash
# verify-profile-skills.sh — every skill a profile names must actually be installed.
#
# A profile's `skills` list is an assertion: the lane will have these. Nothing checked
# the assertion, so a skill that moved, was renamed, or was never installed left the
# lane quietly running without it — and the profile still read as if it had it.
#
# This is the check that would have caught `profile-config`: named by the leader
# profile, shipped by `src/apps/pi-profile-switch/skills/`, declared by no package and
# absent from `skills/skills.tsv`, so it existed only as a hand copy on one machine.
#
#   ./test/verify-profile-skills.sh
#
# Skips cleanly where no profiles exist — a fresh machine has none until a lane runs.
set -uo pipefail
cd "$(dirname -- "$0")/.."

PROFILE_DIR="${PROFILE_DIR:-$HOME/.pi-profile-switch/profiles}"
SKILLS_DIR="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "skip: no profiles at $PROFILE_DIR — nothing to assert on a fresh machine"
  exit 0
fi

fail=0
checked=0
profiles=0

for profile in "$PROFILE_DIR"/*.json; do
  [ -f "$profile" ] || continue
  profiles=$((profiles + 1))
  ids="$(node -e 'const s=require(process.argv[1]);(s.skills||[]).forEach(x=>console.log(x))' "$profile" 2>/dev/null)"
  for id in $ids; do
    checked=$((checked + 1))
    if [ ! -e "$SKILLS_DIR/$id" ]; then
      fail=$((fail + 1))
      printf 'FAIL %-22s names %-28s but %s does not exist\n' \
        "$(basename "$profile")" "$id" "$SKILLS_DIR/$id"
    fi
  done
done

echo
if [ "$fail" -ne 0 ]; then
  echo "gate FAILED: $fail skill(s) named by a profile are not installed — a lane using that profile would run without them" >&2
  exit 1
fi
echo "gate passed: $checked skill reference(s) across $profiles profile(s) all resolve in $SKILLS_DIR"
