#!/usr/bin/env bash
# fleet-remote-less-branches.sh — remote-less branches, scoped to the checkouts retirement touches.
#
# Scope: only checkouts whose origin URL matches one of the monorepo's subrepo remotes. The
# unscoped sweep of ~/Code reports 318 rows across 111 repos, which is true and useless — most of
# it is unrelated personal work that retirement will never touch. Scope is the whole finding.
#
# The instrument: `git rev-list --count <branch> --not --remotes`. Zero means every commit on the
# branch is reachable from some remote ref. NOT `@{u}`: a branch with no upstream, or a detached
# checkout, is precisely what this sweep hunts, and `@{u}` errors out or lies there.
#
# Nothing is pushed or deleted. Output is a decision list.
set -uo pipefail

repo="${1:-$HOME/Code/yellowstone}"
root="${2:-$HOME/Code}"
out="${3:-/tmp/fleet-remote-less.txt}"
: > "$out"

# The remotes the monorepo carries, normalised (no trailing .git, no scheme noise).
mapfile -t remotes < <(
  for f in $(git -C "$repo" ls-tree -r --name-only origin/master | grep '\.gitrepo$'); do
    git -C "$repo" show "origin/master:$f" 2>/dev/null | awk -F' = ' '/^[[:space:]]*remote = /{print $2; exit}'
  done | sed 's/\.git$//' | sort -u
)
echo "subrepo remotes in scope: ${#remotes[@]}"

match_url() {
  local u="$1" r
  u="${u%.git}"
  for r in "${remotes[@]}"; do [ "$u" = "$r" ] && return 0; done
  return 1
}

scanned=0; matched=0; rows=0
while IFS= read -r d; do
  case "$d" in *-wt|*-wt/*) continue ;; esac
  scanned=$((scanned + 1))
  url="$(git -C "$d" config --get remote.origin.url 2>/dev/null || true)"
  [ -n "$url" ] || continue
  match_url "$url" || continue
  matched=$((matched + 1))
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    n="$(git -C "$d" rev-list --count "$b" --not --remotes 2>/dev/null || echo 0)"
    [ "${n:-0}" -gt 0 ] || continue
    sha="$(git -C "$d" rev-parse --short "$b" 2>/dev/null)"
    when="$(git -C "$d" log -1 --format=%cs "$b" 2>/dev/null)"
    subj="$(git -C "$d" log -1 --format=%s "$b" 2>/dev/null | cut -c1-56)"
    printf '%s|%s|%s|%s|%s|%s\n' "${d#$HOME/Code/}" "$b" "$sha" "$n" "$when" "$subj" >> "$out"
    rows=$((rows + 1))
  done < <(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)
done < <(find "$root" -maxdepth 3 -name .git \( -type d -o -type f \) 2>/dev/null | sed 's:/\.git$::' | sort -u)

echo "checkouts scanned:              $scanned"
echo "checkouts matching a subrepo:   $matched"
echo "remote-less branch rows:        $rows"
echo
if [ "$rows" -eq 0 ]; then
  echo "ok: every branch in every fleet checkout is reachable from a remote ref"
  exit 0
fi
echo "CHECKOUT | BRANCH | TIP | UNPUB | LAST | SUBJECT"
sed 's/|/ | /g' "$out"
