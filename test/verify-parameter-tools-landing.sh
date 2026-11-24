#!/usr/bin/env bash
# parameter-tools landing gate.
#
# This component is a workspace subdirectory of our pi-extensions fork, so it cannot be
# pinned the way the subrepo components are: `pi install git:<repo>@<sha>` installs a
# repository root, and ours declares no `pi.extensions`. It is installed from the checkout
# by its own stage. What can rot silently is therefore (a) the landed source drifting from
# the accepted commit and (b) the package declaring an entry point that does not exist.
# This gate binds both, and proves the stage is wired.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$REPO_ROOT/src/pi-extensions/pi-parameter-tools"
fail=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }

# Accepted source: FT-89 resolved parameter-tools source, commits 0d8ab3c6b and 8348c0552
# on top of the accepted landing bcd33c755. The two files that carry the behavior are pinned by
# the invariant that matters (its declared entry point), so a version bump alone is not a
# red gate but a moved or missing entry point is.
declare -A PINS=(
  ["src/index.ts"]="e8e96de0f7f358ce771efe66fbf030fea06f0addfb83cecccb3a4869211cd112"
  ["src/receiver.ts"]="11ff6ca771b6db967d9883128c9c1f0952a8a80c813eb29582e9ba73d9ffd7ea"
)
for rel in "${!PINS[@]}"; do
  f="$PKG/$rel"
  if [ ! -f "$f" ]; then bad "missing $rel"; continue; fi
  actual="$(sha256sum "$f" | cut -d' ' -f1)"
  if [ "$actual" != "${PINS[$rel]}" ]; then
    bad "$rel differs from the accepted FT-89 final source"
  fi
done
[ "$fail" -eq 0 ] && ok "landed source matches the accepted commit (2 pinned files)"

if [ -f "$PKG/package.json" ]; then
  entry="$(python3 - "$PKG/package.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
ext = ((d.get("pi") or {}).get("extensions") or [])
print(ext[0] if ext else "")
PY
)"
  if [ -z "$entry" ]; then
    bad "package.json declares no pi.extensions entry"
  elif [ ! -f "$PKG/${entry#./}" ]; then
    bad "package.json declares entry $entry but the landing does not carry it"
  else
    ok "package declares an entry point the landing carries ($entry)"
  fi
else
  bad "package.json is missing"
fi

# The stage: defined, and actually called.
if ! sed -n '/^install_parameter_tools()/,/^}/p' "$REPO_ROOT/install.sh" | grep -q 'pi-parameter-tools'; then
  bad "install.sh has no install_parameter_tools() that installs this component"
fi
if ! grep -q 'want parameter-tools && install_parameter_tools' "$REPO_ROOT/install.sh"; then
  bad "install.sh never calls install_parameter_tools"
fi
grep -q 'parameter-tools' "$REPO_ROOT/install.sh" && ok "installer wires the stage" || true

echo
if [ "$fail" -eq 0 ]; then
  echo "ok   parameter-tools: landed source, entry point and installer agree"
  exit 0
fi
echo "FAIL parameter-tools landing: $fail check(s) failed"
exit 1
