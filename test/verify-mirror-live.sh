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
# Three findings, and only one of them is a failure:
#
#   live NEWER than the mirror   → the snapshot about to be published lacks
#                                  changes this machine already runs. FAIL.
#   live-only file (not excluded) → the machine runs tooling the repo has no copy
#                                  of, so a fresh machine cannot reproduce it. FAIL.
#   mirror NEWER than the live   → an install is pending. Note it, do not fail:
#                                  pushing the newer mirror is correct.
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

# Direction by provenance, not by mtime.
#
# checkout and merge stamp mtime = now regardless of content age, so a merge that
# resolves a conflict back to an older mirror shows OLDER CONTENT WITH A NEWER
# mtime. An mtime test reads that as "the mirror is newer, an install is pending"
# and notes it — the one classification that promotes a reverted mirror into the
# running fleet on the next install, with a backup nobody reads.
#
# So: find the commit whose blob for this path equals the live file's content.
#   live content committed at a DESCENDANT of the mirror's commit -> the tree has
#     moved backwards since; the mirror lacks what the machine runs -> FAIL.
#   live content never committed -> the normal edit-then-commit window -> note.
#   live content committed at an ANCESTOR -> the mirror is legitimately ahead and
#     an install is pending -> note.
revert_detected() {
  local mirror="$1" live="$2" rel cur live_blob c found=""
  rel="$mirror"
  cur="$(git log -1 --format=%H -- "$rel" 2>/dev/null)"
  [ -n "$cur" ] || return 1
  live_blob="$(git hash-object -- "$live" 2>/dev/null)"
  [ -n "$live_blob" ] || return 1
  for c in $(git rev-list --max-count=400 -- "$rel" 2>/dev/null); do
    [ "$(git rev-parse "$c:$rel" 2>/dev/null)" = "$live_blob" ] && { found="$c"; break; }
  done
  [ -n "$found" ] || return 1
  git merge-base --is-ancestor "$cur" "$found" 2>/dev/null
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
  if [ "$live" -nt "$path" ]; then
    behind=$((behind + 1))
    behind_list="$behind_list
  $rel  (live edited $(ago_of "$live"), mirror $(ago_of "$path"))"
  elif revert_detected "$path" "$live"; then
    # mtime said "mirror newer", but the live content was committed at a
    # descendant of the mirror's commit: the tree moved backwards.
    behind=$((behind + 1))
    behind_list="$behind_list
  $rel  (REVERTED — the live content is newer in history than the mirror's)"
  else
    ahead=$((ahead + 1)); ahead_list="$ahead_list $rel"
  fi
done < <(find "$SRC/tools" "$SRC/bin" -type f 2>/dev/null | LC_ALL=C sort)

# Live side: anything the machine runs that the mirror has no copy of.
while IFS= read -r live; do
  rel="${live#"$OVERLORD_DIR"/}"
  [ -e "$SRC/$rel" ] && continue
  excluded "$rel" && continue
  liveonly=$((liveonly + 1)); liveonly_list="$liveonly_list $rel"
done < <(find "$OVERLORD_DIR/tools" "$OVERLORD_DIR/bin" -type f 2>/dev/null | LC_ALL=C sort)

echo "mirror vs live ($OVERLORD_DIR): $same identical, $behind older than live, $ahead newer than live or uninstalled, $liveonly live-only"

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
if [ "$behind" != 0 ]; then
  printf 'FAIL: %d mirrored file(s) are older than the live copy — the tree would publish a snapshot that lacks changes this machine runs:%s\n' \
    "$behind" "$behind_list" >&2
  rc=1
fi
[ "$liveonly" = 0 ] || rc=1

if [ "$rc" = 0 ]; then
  echo "gate passed: nothing live is newer than the mirror, and no live tooling is unmirrored"
fi
exit "$rc"
