#!/usr/bin/env bash
# Behold landing gate.
#
# Behold is not a `pi install` package: it is a Python CLI plus a single-file Pi
# reporter. Two things can therefore go wrong silently on a landing like this —
# the component can drift from the accepted source, and the reporter can stop
# being the file the installer actually places. This gate checks both, by bytes,
# and then runs the component's own capture tests so the landed code is executed
# rather than merely present.
#
# It reads no live fleet state, needs no network, and writes nothing outside its
# own temporary directory.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENT="$REPO_ROOT/src/pi-extensions/behold"
fail=0
ok()   { printf 'ok   %s\n' "$1"; }
bad()  { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }

# 1. The component is present and its own manifest verifies.
#    The manifest is `sha256  path  mode`, so it is parsed here rather than fed to
#    `sha256sum -c`, which would treat the mode column as part of the filename.
[ -f "$COMPONENT/MANIFEST.sha256" ] || bad "component manifest is missing"
if [ -f "$COMPONENT/MANIFEST.sha256" ]; then
  checked=0
  while read -r digest path _mode; do
    [ -n "${digest:-}" ] || continue
    file="$COMPONENT/$path"
    if [ ! -f "$file" ]; then
      bad "manifest names a file the landing does not carry: $path"
      continue
    fi
    actual="$(sha256sum "$file" | cut -d' ' -f1)"
    if [ "$actual" != "$digest" ]; then
      bad "landed bytes differ from the accepted source: $path"
    fi
    checked=$((checked + 1))
  done < "$COMPONENT/MANIFEST.sha256"
  [ "$checked" -gt 0 ] || bad "manifest listed no files"
  [ "$fail" -eq 0 ] && ok "component matches its accepted manifest ($checked files)"
fi

# 2. The reporter the installer places is the reporter the component carries.
if cmp -s "$COMPONENT/pi-extension/behold-state.ts" \
          "$REPO_ROOT/home/.pi/agent/extensions/behold-state.ts"; then
  ok "agent extension mirror is byte-identical to the component reporter"
else
  bad "home/.pi/agent/extensions/behold-state.ts differs from the component's reporter"
fi

# 3. The installer actually installs it: a stage, a call site, and the agent-dir copy.
grep -q 'behold|plugins\|behold|' "$REPO_ROOT/install.sh" || bad "install.sh has no behold stage in its argument list"
grep -q 'want behold  && install_behold' "$REPO_ROOT/install.sh" || bad "install.sh never calls install_behold"
grep -q 'behold-state.ts' "$REPO_ROOT/install.sh" || bad "install.sh does not place the reporter"

# 4. Execute the landed code: the CLI answers, and the capture tests pass.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ( cd "$COMPONENT" && PYTHONDONTWRITEBYTECODE=1 timeout 120 python3 -m unittest tests.test_capture >"$tmp/capture.log" 2>&1 ); then
  ok "component capture tests pass (tests/test_capture.py)"
else
  bad "component capture tests failed — see the run above"
  tail -20 "$tmp/capture.log" | sed 's/^/    /'
fi
if PYTHONDONTWRITEBYTECODE=1 timeout 60 "$COMPONENT/bin/behold" --version >"$tmp/version.out" 2>&1; then
  ok "behold CLI runs: $(cat "$tmp/version.out")"
else
  bad "behold CLI did not run"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ok   behold: landed component, reporter and installer agree with the accepted source"
  exit 0
fi
echo "FAIL behold landing: $fail check(s) failed"
exit 1
