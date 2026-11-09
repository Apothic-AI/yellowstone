#!/usr/bin/env bash
# remote-less-branches.sh — find local branches whose commits exist on no remote.
#
# Why this and not `@{u}`: a branch with no upstream set, or a detached checkout, makes
# `@{u}` meaningless or error out — and those are exactly the cases this sweep exists to
# find. The question is not "does this branch track a remote" but "is every commit on this
# branch reachable from some remote ref". `git rev-list --count <branch> --not --remotes`
# answers that: 0 means fully published, >0 means N commits exist only here.
#
# Usage: remote-less-branches.sh [ROOT]        default ROOT=$HOME/Code
# Output: one pipe-separated row per branch, plus a summary. Nothing is pushed or deleted.
set -uo pipefail

root="${1:-$HOME/Code}"
out="${2:-/tmp/remote-less-branches.txt}"
: > "$out"

repos=0; clean=0; dirty=0

# Worktrees of the same repository share a branch namespace, so scanning one checkout of
# each repo is enough; skip the -wt trees to avoid reporting the same branch several times.
while IFS= read -r d; do
  case "$d" in *-wt|*-wt/*) continue ;; esac
  repos=$((repos + 1))
  repo_flagged=0
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    n="$(git -C "$d" rev-list --count "$b" --not --remotes 2>/dev/null || echo 0)"
    [ "${n:-0}" -gt 0 ] || continue
    sha="$(git -C "$d" rev-parse --short "$b" 2>/dev/null)"
    when="$(git -C "$d" log -1 --format=%cs "$b" 2>/dev/null)"
    subj="$(git -C "$d" log -1 --format=%s "$b" 2>/dev/null | cut -c1-58)"
    printf '%s|%s|%s|%s|%s|%s\n' "$d" "$b" "$sha" "$n" "$when" "$subj" >> "$out"
    dirty=$((dirty + 1))
    repo_flagged=1
  done < <(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)
  if [ "$repo_flagged" = 1 ]; then :; else clean=$((clean + 1)); fi
done < <(find "$root" -maxdepth 3 -name .git \( -type d -o -type f \) 2>/dev/null | sed 's:/\.git$::' | sort -u)

echo "repos scanned:            $repos"
echo "repos fully published:    $clean"
echo "remote-less branch rows:  $dirty"
echo
if [ "$dirty" -eq 0 ]; then
  echo "ok: every local branch is reachable from a remote ref"
  exit 0
fi
printf '%s\n' "REPO | BRANCH | TIP | UNPUB COMMITS | LAST COMMIT | SUBJECT"
sed 's/|/ | /g' "$out"
exit 0
