#!/usr/bin/env bash
# retirement-inventory.sh — one row per fleet checkout: what it is, what it would cost to retire.
#
# Fleet scope only: a checkout whose origin matches one of the monorepo's subrepo remotes.
# Non-fleet repos under ~/Code stay there by operator instruction and are deliberately out.
#
# Read-only. Prints a table; deletes nothing.
set -uo pipefail
repo="${1:-$HOME/Code/yellowstone}"
root="${2:-$HOME/Code}"

mapfile -t remotes < <(
  for f in $(git -C "$repo" ls-tree -r --name-only origin/master | grep '\.gitrepo$'); do
    git -C "$repo" show "origin/master:$f" 2>/dev/null | awk -F' = ' '/^[[:space:]]*remote = /{print $2; exit}'
  done | sed 's/\.git$//' | sort -u
)

printf '%-46s %-9s %-6s %-7s %-28s %s\n' CHECKOUT KIND DIRTY BRANCH HEAD "NOTE"

while IFS= read -r d; do
  url="$(git -C "$d" config --get remote.origin.url 2>/dev/null || true)"
  [ -n "$url" ] || continue
  u="${url%.git}"; hit=no
  for r in "${remotes[@]}"; do [ "$u" = "$r" ] && { hit=yes; break; }; done
  [ "$hit" = yes ] || continue

  if [ -d "$d/.git" ]; then kind=clone; else kind=worktree; fi
  dirty="$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  branch="$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  head="$(git -C "$d" rev-parse --short HEAD 2>/dev/null)"
  note=""
  [ "$dirty" -gt 0 ] || note=""
  [ "$dirty" -gt 0 ] && note="UNCOMMITTED WORK — capture first"
  [ "$kind" = worktree ] && note="${note:+$note · }git worktree remove, branches survive"

  printf '%-46s %-9s %-6s %-7s %-28s %s\n' "${d#$HOME/Code/}" "$kind" "$dirty" "${branch:0:26}" "$head" "$note"
done < <(find "$root" -maxdepth 4 -name .git \( -type d -o -type f \) 2>/dev/null | sed 's:/\.git$::' | sort -u)
