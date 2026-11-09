#!/usr/bin/env bash
# verify-revert-detection.sh — the check that checks the checker.
#
# The mirror-vs-live gate has one job that matters: fail when the tree has moved
# BACKWARDS, because `./install.sh` would then copy the reverted file over the live
# one and every other gate would stay green. That case is invisible to content
# comparison (the files simply differ) and invisible to mtime (a checkout stamps
# mtime = now, so the reverted mirror looks *newer*). Only provenance separates it
# from the ordinary edit-then-commit window.
#
# So this builds each of the three cases in a throwaway repository and asserts the
# gate's verdict on it. Without this, the gate is tested only by whatever happened
# to be true on the machine the day it was written — and the mtime version of this
# gate passed the revert case for an hour, in production, with a green run.
#
# Host-side on purpose (like the other verify-* scripts): it needs real git and
# history, which the container image deliberately lacks.
set -uo pipefail
cd "$(dirname -- "$0")/.."
REPO="$(pwd)"
fail=0

# build <case> — a scratch repo with one tool file and a synthetic live copy.
run_case() {
  local want="$1" kind="$2" P; P="$(mktemp -d)"
  mkdir -p "$P/repo/test" "$P/repo/home/.overlord/tools" "$P/live/tools"
  (
    cd "$P/repo" || exit 1
    git init -q .; git config user.email t@t; git config user.name t
    printf 'RETIRED contract\n' > home/.overlord/tools/t.sh; git add -A; git commit -qm A
    printf 'CURRENT contract\n' > home/.overlord/tools/t.sh; git commit -qam B
    case "$kind" in
      revert)
        # live = committed CURRENT; then a merge resolves the mirror back to A.
        cp home/.overlord/tools/t.sh "$P/live/tools/t.sh"
        touch -d '40 minutes ago' "$P/live/tools/t.sh"   # mtime says "mirror is newer"
        git checkout -q HEAD~1 -- home/.overlord/tools/t.sh ;;
      pending)
        # An install is outstanding: the mirror carries B's content, the live copy
        # still has A's — and A is committed, which is what makes this benign
        # rather than a revert. Both sides are in history, mirror is the descendant.
        git show HEAD~1:home/.overlord/tools/t.sh > "$P/live/tools/t.sh" ;;
      runtime)
        # live edited on the machine, never committed anywhere.
        cp home/.overlord/tools/t.sh "$P/live/tools/t.sh"
        printf 'hotfix nobody committed\n' >> "$P/live/tools/t.sh" ;;
    esac
    cp "$REPO/test/verify-mirror-live.sh" test/
    cp "$REPO/home/.overlord/tools/mirror-provenance.sh" home/.overlord/tools/
    git add -A; git commit -qm C
  ) >/dev/null 2>&1
  local out rc
  out="$(OVERLORD_DIR="$P/live" bash "$P/repo/test/verify-mirror-live.sh" 2>&1)"; rc=$?
  rm -rf "$P"
  if [ "$want" = pass ] && [ "$rc" = 0 ]; then
    echo "  ok   $kind: gate passes"; return 0
  fi
  if [ "$want" = fail ] && [ "$rc" != 0 ]; then
    echo "  ok   $kind: gate fails"; return 0
  fi
  echo "  FAIL $kind: wanted $want, gate exited $rc" >&2
  printf '%s\n' "$out" | sed 's/^/       /' >&2
  return 1
}

echo "== mirror direction =="
run_case fail  revert  || fail=1
run_case fail  runtime || fail=1
run_case pass  pending || fail=1

if [ "$fail" = 0 ]; then
  echo "gate passed: a reverted mirror, an uncommitted live edit and a pending install are told apart"
else
  echo "gate FAILED: the revert detection is not distinguishing the cases" >&2
fi
exit "$fail"
