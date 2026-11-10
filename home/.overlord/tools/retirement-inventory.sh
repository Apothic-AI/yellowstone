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

# LOOSE: instances that LOAD anything from outside the monorepo's src/.
#
# Two files, because an instance loads components from both:
#   settings.json    packages[].source            — pi extensions and packages
#   pi-profile.json  extensions[].entry / paths   — profile-declared extensions
#
# A `Code/` string is NOT evidence on its own. settings.json also records past installs as
# version-map keys (`"{\"source\":\"...\",\"scope\":\"user\"}": "1.4.8"`), which resolve nothing
# and load nothing. Only a live load path counts.
#
# Scanning settings.json alone undercounts: launch-ZTKNdC (herdr-leader) loads an extension from
# ~/Code/herdr/.pi/extensions/ and declares it in pi-profile.json while its 25 package sources are
# all inside src/. That is a fourth component behind the same precondition.
python3 - "$repo" <<'PY2'
import json, os, glob, re, subprocess, sys
base = sys.argv[1].rstrip(os.sep)
# "Inside the repo" has TWO spellings, not one: the main checkout at <base>/src/ and
# every worktree at <base>-wt/<name>/src/. Matching only the main checkout reports a
# CORRECT migration as incomplete — the closed-list defect inside the tool that exists
# to find it, and the unsatisfiable-gate failure that follows: a gate whose zero is
# unreachable trains people to ignore it. herdr-leader hit exactly this case, moving to
# yellowstone-wt/herdr-lane/src/apps/herdr and still reading LOOSE.
inward = re.compile("^" + re.escape(base) + r"(-wt/[^/]+)?/src/")
def walk(o, path=""):
    if isinstance(o, str):
        yield path, o
    elif isinstance(o, dict):
        for k, v in o.items():
            yield from walk(v, f"{path}.{k}" if path else k)
    elif isinstance(o, list):
        for i, v in enumerate(o):
            yield from walk(v, f"{path}[{i}]")
rows = []
insts = sorted(glob.glob(os.path.expanduser("~/.pi-profile-switch/instances/launch-*")))
scanned = 0
for i in insts:
    name = os.path.basename(i)
    found = []
    for fn in ("settings.json", "pi-profile.json"):
        f = os.path.join(i, fn)
        if not os.path.exists(f):
            continue
        try:
            data = json.load(open(f))
        except Exception:
            continue
        for p, s in walk(data):
            if p.startswith("{"):
                continue
            for c in (s, s.replace('\\"', '"')):
                if "Code/" in c and not inward.match(c) and ".pi/agent" not in c and os.sep + "Code" in c:
                    found.append((fn, c))
    if os.path.exists(os.path.join(i, "settings.json")):
        scanned += 1
    if found:
        rows.append((name, sorted(set(found))))
print()
print(f"LOOSE - instances loading a component from outside {base}[/-wt/<name>]/src/")
print(f"        {len(rows)} of {scanned} instances")
comps = set()
for n, found in rows:
    print(f"  {n}")
    for fn, c in found:
        comps.add(c)
        print(f"    [{fn}] {c}")
print(f"  distinct outer paths: {len(comps)}")

# LINKED - what npm's GLOBAL bin dir points at.
#
# The LOOSE scan above reads settings.json and pi-profile.json, which is where pi
# records packages. The launcher is neither: `pi-profile-switch` is resolved through
# npm's global bin dir and appears in no instance file. That is why this instrument
# reported "0 of 48" for the entire migration while the launcher was loading from
# ~/Code — the most load-bearing component was outside the population it measured.
#
# Three verdicts, and they are not the same thing:
#   inward    the link resolves inside <repo>[/-wt/<name>]/src/ — a component loaded
#             from the tree
#   installed the link resolves into our own install prefix (~/.local/share/yellowstone),
#             which is a copy npm made from our git pin. Derived, not a checkout.
#   LOOSE     anything else — a link into a checkout outside the repo, which is the
#             state that makes `git subrepo pull` a lie for that component.
root = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True).stdout.strip()
installed_prefix = os.path.expanduser("~/.local/share/yellowstone")
linked_rows = []
if root and os.path.isdir(root):
    for entry in sorted(os.listdir(root)):
        full = os.path.join(root, entry)
        if not os.path.islink(full):
            continue
        target = os.path.realpath(full)
        if inward.match(target + os.sep) or inward.match(target):
            verdict = "inward"
        elif target.startswith(installed_prefix + os.sep):
            verdict = "installed"
        else:
            verdict = "LOOSE"
        linked_rows.append((entry, target, verdict))
print()
print("LINKED - what npm's global bin dir resolves to")
if not linked_rows:
    print("        (no linked packages)")
loose_links = [r for r in linked_rows if r[2] == "LOOSE"]
for entry, target, verdict in linked_rows:
    mark = "LOOSE" if verdict == "LOOSE" else "ok   "
    print(f"  {mark} {entry:26} {verdict:9} {target}")
print(f"        {len(loose_links)} of {len(linked_rows)} links point outside the repo")
PY2
