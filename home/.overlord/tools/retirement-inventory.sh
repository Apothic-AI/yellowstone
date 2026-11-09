#!/usr/bin/env bash
# retirement-inventory.sh — one row per fleet checkout: what it is, what it would cost to retire.
#
# Fleet scope only: a checkout whose origin matches one of the monorepo's subrepo remotes.
# Non-fleet repos under ~/Code stay there by operator instruction and are deliberately out.
#
# Read-only. Prints a table; deletes nothing.
#
# THREE numbers must be zero before any delete: DIRTY, UNPUBLISHED, and LOOSE (printed at the end).
#     DIRTY        uncommitted work in the checkout      → capture
#     UNPUBLISHED  commits on a local branch that no remote ref contains → push
#     LOOSE        an instance that LOADS a package from outside the monorepo → relaunch it
#
# FETCH FIRST. UNPUBLISHED is computed with `--not --remotes`, which reads *local*
# remote-tracking refs; without a fetch a recently-pushed branch looks local-only.
set -uo pipefail
repo="${1:-$HOME/Code/yellowstone}"
root="${2:-$HOME/Code}"

# Compare origins as `org/repo`, never as full URLs. The same remote is written
# `git@github.com:Org/repo.git` in a clone and `https://github.com/Org/repo` in a .gitrepo
# pin. Exact string equality silently drops every SSH-remote checkout — it hid
# pi-extensions-apothic, one of the three that must retire last.
slug() { sed -E 's#^[a-z][a-z0-9+.-]*://[^/]+/##; s#^[^@/]+@[^:]+:##; s#\.git$##' | tr '[:upper:]' '[:lower:]'; }

mapfile -t remotes < <(
  for f in $(git -C "$repo" ls-tree -r --name-only origin/master | grep '\.gitrepo$'); do
    git -C "$repo" show "origin/master:$f" 2>/dev/null | awk -F' = ' '/^[[:space:]]*remote = /{print $2; exit}'
  done | slug | sort -u
)

printf '%-44s %-9s %-6s %-12s %-8s %-26s %s\n' CHECKOUT KIND DIRTY UNPUBLISHED HEAD BRANCH NOTE

while IFS= read -r d; do
  url="$(git -C "$d" config --get remote.origin.url 2>/dev/null || true)"
  [ -n "$url" ] || continue
  u="$(printf '%s' "$url" | slug)"
  hit=no
  for r in "${remotes[@]}"; do [ "$u" = "$r" ] && { hit=yes; break; }; done
  [ "$hit" = yes ] || continue

  if [ -d "$d/.git" ]; then kind=clone; else kind=worktree; fi
  dirty="$(git -C "$d" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  branch="$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  head="$(git -C "$d" rev-parse --short HEAD 2>/dev/null)"
  unpub=0
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    n="$(git -C "$d" rev-list --count "$br" --not --remotes 2>/dev/null || echo 0)"
    unpub=$((unpub + n))
  done < <(git -C "$d" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)

  note=""
  [ "$dirty" -gt 0 ] && note="UNCOMMITTED WORK — capture first"
  [ "$unpub" -gt 0 ] && note="${note:+$note · }UNPUBLISHED — push first"
  [ "$kind" = worktree ] && note="${note:+$note · }git worktree remove, branches survive"

  printf '%-44s %-9s %-6s %-12s %-8s %-26s %s\n' "${d#$HOME/Code/}" "$kind" "$dirty" "$unpub" "$head" "${branch:0:26}" "$note"
done < <(find "$root" -maxdepth 4 -name .git \( -type d -o -type f \) 2>/dev/null | sed 's:/\.git$::' | sort -u)

# LOOSE: instances that LOAD a package from outside the monorepo's src/.
#
# A `Code/` string is NOT evidence. settings.json also records past installs as version-map
# keys (`"{\"source\":\"...\",\"scope\":\"user\"}": "1.4.8"`) — notes that resolve nothing and
# load nothing. Counting those as loose invents lanes that will never load from ~/Code again;
# ignoring them loses the fact that the instance once did. Only packages[].source decides.
python3 - "$repo" <<'PY'
import json, os, glob, sys
want = os.path.join(sys.argv[1], "src") + os.sep
rows = []
insts = sorted(glob.glob(os.path.expanduser("~/.pi-profile-switch/instances/launch-*")))
scanned = 0
for i in insts:
    f = os.path.join(i, "settings.json")
    if not os.path.exists(f):
        continue
    scanned += 1
    srcs = []
    def c(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "source" and isinstance(v, str):
                    srcs.append(v)
                c(v)
        elif isinstance(o, list):
            for v in o:
                c(v)
    try:
        c(json.load(open(f)))
    except Exception:
        continue
    out = [s for s in srcs if "Code/" in s and not s.startswith(want)]
    if out:
        rows.append((os.path.basename(i), out))

print()
print(f"LOOSE — instances loading a package from outside {want}")
print(f"        {len(rows)} of {scanned} instances with a settings.json")
for n, out in rows:
    print(f"  {n}")
    for s in out:
        print(f"    {s}")
PY
