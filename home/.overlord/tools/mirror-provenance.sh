#!/usr/bin/env bash
# mirror-provenance — is the shipped mirror BEHIND the machine it runs on?
#
# Decided by commit ancestry, not by mtime.
#
# Why mtime fails: `git checkout` and `git merge` stamp mtime = now regardless of content
# age. Measured in a throwaway repo — commit A "RETIRED", commit B "CURRENT", live copy = B
# touched 40m ago, then `git checkout HEAD~1 -- tool.sh` gives mirror content = A with an
# mtime of *now*. So a merge that reverts a tool presents as "the mirror is newer", which
# `test/verify-mirror-live.sh` classifies as "an install is pending" and passes; doctor's
# remediation then says to run ./install.sh, which promotes the regression into the running
# fleet. mtime records when a file was written, not what it descended from.
#
# The cases, and only one of them is the normal window:
#   mirror's commit is an ancestor of live's -> the tree moved BACKWARDS (revert)     FAIL
#   live's commit is an ancestor of mirror's -> an install is pending                note
#   live content matches no commit           -> uncommitted work on the machine      FAIL
#   neither is an ancestor of the other      -> both sides moved; content diverged   FAIL
#   live file absent                         -> not installed on this host           note
#   live file with no mirror counterpart     -> a fresh clone cannot reproduce it    FAIL
#
# Read-only: never writes, installs, or fetches. Safe from a pre-push hook, which is the
# only place this question can be asked — a fresh clone has no live directory.
#
# Usage: mirror-provenance.sh [--repo DIR] [--live DIR] [-q]
# Exit: 0 = nothing wrong in this direction, 1 = at least one FAIL, 2 = cannot run here.
set -uo pipefail

REPO="${YELLOWSTONE_REPO:-$HOME/Code/yellowstone}"
LIVE="${OVERLORD_DIR:-$HOME/.overlord}"
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --live) LIVE="$2"; shift 2 ;;
    -q|--quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "mirror-provenance: unknown argument $1" >&2; exit 2 ;;
  esac
done

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }

# Skip cleanly and SAY SO: the pushing clone need not be the machine the mirror came from.
# A vacuous pass that looks like coverage is the failure this check exists to prevent.
if [ ! -d "$LIVE/tools" ] && [ ! -d "$LIVE/bin" ]; then
  say "skip: no live overlord tooling at $LIVE — nothing to compare against"
  exit 0
fi
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "skip: $REPO is not a git repository — cannot resolve provenance" >&2; exit 2; }

# The migration's declared omissions, restated rather than imported: the exclusion is a
# decision and should be visible where it is enforced.
excluded() {
  case "$1" in
    *__pycache__*|*.pyc) return 0 ;;
    *.bak|*.bak-*|*.bak.*) return 0 ;;
    tools/rooms-names.json) return 0 ;;
    *pi-modes-cli.secret) return 0 ;;
    *) return 1 ;;
  esac
}

# Newest commit walking back from HEAD whose blob at <path> equals <blob>; empty if never.
commit_introducing() {
  local path="$1" blob="$2" c
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    if [ "$(git -C "$REPO" rev-parse "$c:$path" 2>/dev/null)" = "$blob" ]; then
      printf '%s' "$c"; return 0
    fi
  done < <(git -C "$REPO" rev-list HEAD -- "$path" 2>/dev/null)
  return 1
}

# The same search across every ref. Used only to separate two conditions that the
# HEAD-relative search cannot tell apart: content committed on a lineage HEAD cannot
# reach (branches diverged) versus content never committed at all. Conflating them
# reported a committed change as uncommitted — right verdict, wrong reason, which is
# the failure this tool exists to name.
commit_introducing_anywhere() {
  local path="$1" blob="$2" c
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    if [ "$(git -C "$REPO" rev-parse "$c:$path" 2>/dev/null)" = "$blob" ]; then
      printf '%s' "$c"; return 0
    fi
  done < <(git -C "$REPO" rev-list --all -- "$path" 2>/dev/null)
  return 1
}
ancestor() { git -C "$REPO" merge-base --is-ancestor "$1" "$2" 2>/dev/null; }

# The newest commit reachable from <rev> whose blob at <path> equals <blob>.
# Used to answer "did this content already exist BEFORE that point in history?", which is the
# only question that separates a revert from an advance. Walking back from HEAD cannot answer
# it: a COMMITTED revert puts the old content in a NEW commit, so HEAD-relative search finds
# the revert commit itself and calls it the origin.
commit_introducing_before() {
  local rev="$1" path="$2" blob="$3" c
  [ -n "$rev" ] || return 1
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    if [ "$(git -C "$REPO" rev-parse "$c:$path" 2>/dev/null)" = "$blob" ]; then
      printf '%s' "$c"; return 0
    fi
  done < <(git -C "$REPO" rev-list "$rev" -- "$path" 2>/dev/null)
  return 1
}

fails=0; same=0; notes=0
fail_lines=(); note_lines=()

compare() {
  local rel="$1"
  local shipped="$REPO/home/.overlord/$rel"
  local live="$LIVE/$rel"
  local mcommit lcommit mblob lblob

  if [ ! -e "$live" ]; then
    notes=$((notes + 1)); note_lines+=("$rel  not installed on this host — an install is pending"); return
  fi
  if cmp -s -- "$shipped" "$live"; then same=$((same + 1)); return; fi

  mblob="$(git -C "$REPO" hash-object -- "$shipped" 2>/dev/null)"
  lblob="$(git -C "$REPO" hash-object -- "$live" 2>/dev/null)"
  # The repo path, not the mirror-relative one: rel is used for messages and exclusions,
  # but every git lookup must address the file where the repo actually stores it.
  local repo_path="home/.overlord/$rel"
  lcommit="$(commit_introducing "$repo_path" "$lblob")"

  if [ -z "$lcommit" ]; then
    fails=$((fails + 1))
    local elsewhere
    if elsewhere="$(commit_introducing_anywhere "$repo_path" "$lblob")" && [ -n "$elsewhere" ]; then
      fail_lines+=("$rel  the machine's content is committed on a lineage this branch cannot reach (${elsewhere:0:8}) — the lineages diverged; reconcile them, do not publish over it")
    else
      fail_lines+=("$rel  the machine's content was never committed at this path — commit it before publishing")
    fi
  elif ! ancestor "$lcommit" HEAD; then
    fails=$((fails + 1))
    fail_lines+=("$rel  the machine runs content from a commit that is not an ancestor of HEAD — unrelated lineage")
  elif commit_introducing_before "$lcommit^" "$repo_path" "$mblob" >/dev/null; then
    # The mirror's content already existed BEFORE the live content was committed. The tree
    # has gone back to a state the machine has since moved past: that is a revert, however
    # recently the reverting commit was written.
    fails=$((fails + 1))
    fail_lines+=("$rel  the tree moved BACKWARDS: live content committed in ${lcommit:0:8}, and the mirror's copy restores content that predates it — a revert would ship")
  else
    notes=$((notes + 1))
    note_lines+=("$rel  the mirror carries newer committed content than this host — install pending")
  fi
}

while IFS= read -r rel; do
  [ -n "$rel" ] && compare "$rel"
done < <(git -C "$REPO" ls-tree -r --name-only HEAD -- home/.overlord/tools home/.overlord/bin 2>/dev/null | sed 's|^home/.overlord/||')

# Live-only: tooling the machine runs that the tree has no copy of. A shipped-to-installed
# comparison can never see this; it is how undo-self.py was invisible.
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  excluded "$rel" && continue
  git -C "$REPO" cat-file -e "HEAD:home/.overlord/$rel" 2>/dev/null && continue
  fails=$((fails + 1))
  fail_lines+=("$rel  exists only on this machine — a fresh clone cannot reproduce it")
done < <( { [ -d "$LIVE/tools" ] && (cd "$LIVE" && find tools -type f); \
            [ -d "$LIVE/bin" ] && (cd "$LIVE" && find bin -type f); } 2>/dev/null )

say "mirror vs live ($LIVE): $same identical · $notes note(s) · $fails failure(s)"
if [ "${#note_lines[@]}" -gt 0 ]; then
  say "notes (not failures):"; printf '  %s\n' "${note_lines[@]}"
fi
if [ "${#fail_lines[@]}" -gt 0 ]; then
  echo "FAIL: the shipped mirror is not a snapshot of this machine:"
  printf '  %s\n' "${fail_lines[@]}"
  exit 1
fi
say "gate passed: the mirror is not behind this machine, and nothing live is unmirrored"
exit 0
