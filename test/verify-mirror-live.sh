#!/usr/bin/env bash
# verify-mirror-live.sh — is the snapshot in this tree still the machine it is
# being pushed from?
#
# Every container suite installs a copy of this repository and then compares that
# install to the same tree. That is what makes them reproducible, and it is also
# why they cannot answer this question: a mirror that has silently reverted a fix
# which is live on the machine passes all of them. The only witness is the live
# file, compared from outside.
#
# Direction is decided by COMMIT ANCESTRY, not by mtime, and that is not a detail:
# `git checkout` and `git merge` stamp mtime = now whatever the content is, so a
# merge that reverts a tool writes the OLD file with a NEW timestamp. Measured in a
# throwaway repo: reverting with `git checkout HEAD~1 -- tool.sh` leaves mtime as
# now, and an mtime rule reads that as "the mirror is newer, an install is pending"
# and passes — the exact reverted-mirror case this gate exists to catch.
#
# The ancestry check lives in `home/.overlord/tools/mirror-provenance.sh`, which
# ships with the fleet tooling and answers the same question properly:
#
#   mirror's commit is an ancestor of live's -> the tree moved BACKWARDS  FAIL
#   live's commit is an ancestor of mirror's -> an install is pending     note
#   neither is an ancestor of the other      -> the content diverged      FAIL
#   live content matches no commit           -> uncommitted work          FAIL
#   live file with no mirror counterpart     -> a fresh clone cannot reproduce it  FAIL
#
# This script keeps the cheap half — existence on both sides, which is what caught
# a tool created on the machine while a merge was open — and delegates direction to
# that tool. One predicate, in one place.
#
# Failing on the last one would redden the gate for the normal edit-then-commit
# workflow, and a check whose failing condition is a normal state is a check
# people learn to ignore.
#
# Skipped when the live directory is absent: a fresh clone on a machine that has
# never installed the overlord space has nothing to compare against. This check is
# machine-local by construction, the same class as the skills-population baseline.
#
# The live-only exclusions are the ones the migration declared, restated here
# rather than imported: a credential, mutable lane pins, Python caches and backups.
# A new live file that is none of those is the defect — it is the machine carrying
# something the tree does not.
set -uo pipefail
cd "$(dirname -- "$0")/.."

REPO="$(pwd)"
OVERLORD_DIR="${OVERLORD_DIR:-$HOME/.overlord}"
SRC="home/.overlord"

if [ ! -d "$OVERLORD_DIR/tools" ] && [ ! -d "$OVERLORD_DIR/bin" ]; then
  echo "skip: no live overlord tooling at $OVERLORD_DIR — nothing to compare against"
  exit 0
fi

ago_of() {
  local secs=$(( $(date +%s) - $(stat -c %Y -- "$1") ))
  [ "$secs" -lt 0 ] && secs=0
  if [ "$secs" -lt 3600 ]; then printf '%dm ago' $((secs / 60))
  elif [ "$secs" -lt 86400 ]; then printf '%dh ago' $((secs / 3600))
  else printf '%dd ago' $((secs / 86400)); fi
}

# excluded <path relative to $OVERLORD_DIR> — the migration's declared omissions.
excluded() {
  case "$1" in
    *__pycache__*|*.pyc) return 0 ;;
    *.bak|*.bak-*|*.bak.*) return 0 ;;
    tools/rooms-names.json) return 0 ;;   # mutable lane pins, not shipped
    *pi-modes-cli.secret) return 0 ;;     # credential, never shipped
    *) return 1 ;;
  esac
}

same=0; behind=0; ahead=0; liveonly=0
behind_list=""; ahead_list=""; liveonly_list=""

# Mirror side: every shipped file, compared to its live copy.
while IFS= read -r path; do
  rel="${path#"$SRC"/}"
  live="$OVERLORD_DIR/$rel"
  if [ ! -e "$live" ]; then
    ahead=$((ahead + 1)); ahead_list="$ahead_list $rel"
    continue
  fi
  if cmp -s -- "$path" "$live"; then same=$((same + 1)); continue; fi
  # They differ: mtime cannot say which side is right (see above), so this asks the
  # provenance tool and falls back to a loud 'undecided' rather than guessing.
  ahead=$((ahead + 1)); ahead_list="$ahead_list $rel"
done < <(find "$SRC/tools" "$SRC/bin" -type f 2>/dev/null | LC_ALL=C sort)

# Live side: anything the machine runs that the mirror has no copy of.
while IFS= read -r live; do
  rel="${live#"$OVERLORD_DIR"/}"
  [ -e "$SRC/$rel" ] && continue
  excluded "$rel" && continue
  liveonly=$((liveonly + 1)); liveonly_list="$liveonly_list $rel"
done < <(find "$OVERLORD_DIR/tools" "$OVERLORD_DIR/bin" -type f 2>/dev/null | LC_ALL=C sort)

echo "mirror vs live ($OVERLORD_DIR): $same identical, $ahead differing or uninstalled, $liveonly live-only"

# A long list is unauditable, and the first few names are enough to act on.
brief() {  # brief <count> <list>
  local n="$1" list="$2" shown
  [ "$n" = 0 ] && return 0
  shown="$(printf '%s' "$list" | tr ' ' '\n' | sed '/^$/d' | head -5 | tr '\n' ' ')"
  [ "$n" -le 5 ] || shown="$shown… ($n total)"
  printf '%s' "$shown"
}

[ "$ahead" = 0 ] || echo "note: an install is pending or these are not installed here: $(brief "$ahead" "$ahead_list")"
[ "$liveonly" = 0 ] || echo "FAIL: live-only tooling — the machine runs these and the tree has no copy, so a fresh machine cannot reproduce them: $(brief "$liveonly" "$liveonly_list")"

rc=0
[ "$liveonly" = 0 ] || rc=1

# Direction, decided by ancestry. Delegated so the predicate exists once; if the
# tool is missing (an older machine), say so instead of passing quietly.
provenance="$REPO/home/.overlord/tools/mirror-provenance.sh"
if [ -x "$provenance" ] || [ -f "$provenance" ]; then
  bash "$provenance" --repo "$REPO" --live "$OVERLORD_DIR" || rc=1
elif [ "$ahead" = 0 ]; then
  : # nothing differs, so there is no direction to decide
else
  # Absence is not neutrality. The tool ships in this tree, so a clone without it
  # is broken — and "cannot tell" must not read as "nothing wrong" when the thing
  # it cannot tell apart is a reverted mirror about to be published. Say it and
  # fail; a gate that passes because it lost its instrument is the vacuous pass
  # this whole file is about.
  echo "FAIL: direction cannot be decided — home/.overlord/tools/mirror-provenance.sh is missing from the tree, and $ahead file(s) differ from live" >&2
  rc=1
fi

if [ "$rc" = 0 ]; then
  echo "gate passed: nothing live is newer than the mirror, and no live tooling is unmirrored"
fi
exit "$rc"
