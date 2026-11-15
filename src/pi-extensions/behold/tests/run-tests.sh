#!/usr/bin/env bash
# run-tests.sh — behold P1+P2 test suite (stdlib only, no network, no fleet access).
#
# Usage: tests/run-tests.sh [--keep] [--lanes N]
# Exits non-zero on the first failing suite. Every suite prints its own PASS/FAIL counts,
# and the bench suite prints p50/p95 numbers against the budget targets (numbers, not vibes).
#
# ISOLATION. The suite runs against a disposable tree: HOME and the XDG directories point
# into it, the fixtures, the fake `herdr` and every cache path live there, and every
# roster run is explicit (--root, --as-of, and a cache decision). The fail-closed guard
# (tests/isolation.py) refuses the real home, a live herdr capture and a live roster
# run — in this process and in every child.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
cd "$root"

python="${PYTHON:-python3}"
lanes=61
keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) keep=1 ;;
    --lanes) lanes="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

workdir="$(mktemp -d "${TMPDIR:-/tmp}/behold-tests.XXXXXX")"
cleanup() { [ "$keep" -eq 1 ] || rm -rf "$workdir"; }
trap cleanup EXIT

# TEST ISOLATION -----------------------------------------------------------------------
# A disposable tree: HOME and the XDG directories point into the sandbox, and the
# fail-closed guard (tests/isolation.py) refuses any path under the REAL home -- the
# repository and the sandbox excepted -- and refuses a live herdr capture, in this
# process and in every child (through the sitecustomize on PYTHONPATH). Every roster run
# is synthetic and explicit: --root, and a cache decision.
export BEHOLD_ISOLATION_ROOT="$workdir/isolation"
export BEHOLD_FIXTURE_ROOT="$workdir/isolation/fixtures"
export BEHOLD_SANDBOX="$workdir/sandbox"
export BEHOLD_AS_OF="2026-11-11T03:00:00Z"
export HOME="$workdir/home"
export XDG_CONFIG_HOME="$workdir/config"
export XDG_DATA_HOME="$workdir/data"
export XDG_CACHE_HOME="$workdir/cache"
export XDG_STATE_HOME="$workdir/state"
export PYTHONPATH="$workdir/isolation:$root${PYTHONPATH:+:$PYTHONPATH}"
mkdir -p "$BEHOLD_SANDBOX" "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" \
         "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
# the child's sitecustomize: the same guard, in every Python child
"$python" -c "import sys; sys.path.insert(0, '$root'); from tests import isolation; isolation.prepare_sandbox()" || exit 1

echo "== fixtures =="
"$python" fixtures/make_fixtures.py "$BEHOLD_FIXTURE_ROOT" --lanes "$lanes" || exit 1

echo
echo "== unit + integration + negative + guard + watch =="
"$python" -m unittest discover -s tests -t . -v > "$workdir/suite.log" 2>&1
status=$?
tail -40 "$workdir/suite.log"
echo "(the full suite log is at $workdir/suite.log)"
echo
if [ "$status" -ne 0 ]; then
  echo "FAILED (exit $status)"
  [ "$keep" -eq 1 ] && echo "sandbox kept at $workdir"
  exit "$status"
fi
echo "PASSED"
[ "$keep" -eq 1 ] && echo "sandbox kept at $workdir"
exit 0
