#!/usr/bin/env bash
# verify-subrepo-roundtrip.sh — the FT-01 completion gate.
#
# A subrepo monorepo is only converted if it reproduces from its own history and
# its remotes, not from whatever happens to be in a working tree. So this clones
# THIS branch into a throwaway directory and then, for every `src/**/.gitrepo`:
#
#   1. `git subrepo status` resolves the subrepo in the fresh clone,
#   2. the pulled commit equals the commit recorded in .gitrepo,
#   3. the subrepo directory actually has content,
#   4. `git subrepo pull` is a no-op — no new commit, no dirty tree.
#
# Plus one count assertion: the tree has the expected number of subrepos, so a
# subrepo deleted to make the rest pass fails the gate instead of shrinking it.
#
#   ./test/verify-subrepo-roundtrip.sh
#
# Needs network (it talks to the real remotes) and a clean work tree.
set -euo pipefail
cd "$(dirname -- "$0")/.."

EXPECTED=13
REPO="$(pwd)"

# `.pi/launch.env` is tracked on purpose: it is this space's launch line, and `pil` falls back to
# it for leader-named lanes. Profile machinery rewrites it in a live checkout, so it can be dirty
# at any moment without meaning anything is wrong. Exempting it by exact name keeps the gate
# runnable where people work; any other modification still fails, and so does this one if its
# name ever changes. A blanket "ignore dotfiles" or "ignore .pi/" would be the same exemption
# applied to files that do matter.
DIRT="$(git status --porcelain | grep -vx ' M \.pi/launch\.env' || true)"
if [ -n "$DIRT" ]; then
  echo "fail: working tree is dirty — commit first, the gate clones what is committed" >&2
  printf '%s\n' "$DIRT" | head >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "cloning $(git rev-parse --short HEAD) into a throwaway tree"
git clone -q --no-hardlinks "$REPO" "$TMP/clone"
cd "$TMP/clone"

fail=0
pass=0
seen=0

for gitrepo in $(find src -name .gitrepo | sort); do
  dir="$(dirname "$gitrepo")"
  seen=$((seen + 1))
  want_commit="$(git config -f "$gitrepo" subrepo.commit)"
  want_branch="$(git config -f "$gitrepo" subrepo.branch)"
  want_remote="$(git config -f "$gitrepo" subrepo.remote)"
  reasons=""

  # 1 + 2 — status resolves, and the pulled commit is the recorded one.
  if ! status="$(git subrepo status "$dir" 2>&1)"; then
    reasons="$reasons status-failed"
  else
    got_commit="$(printf '%s\n' "$status" | sed -n 's/^ *Pulled Commit: *//p' | head -1)"
    got_branch="$(printf '%s\n' "$status" | sed -n 's/^ *Tracking Branch: *//p' | head -1)"
    # `subrepo status` prints an abbreviated commit; .gitrepo records the full one.
    [ "${got_commit:0:8}" = "${want_commit:0:8}" ] || reasons="$reasons pulled(${got_commit:0:8})!=recorded(${want_commit:0:8})"
    [ "$got_branch" = "$want_branch" ] || reasons="$reasons branch($got_branch)!=recorded($want_branch)"
  fi

  # 3 — content, not an empty directory with a .gitrepo in it.
  if [ -z "$(ls -A "$dir" | grep -vx '.gitrepo' || true)" ]; then
    reasons="$reasons empty-directory"
  fi

  # 4 — pull is a no-op.
  before="$(git rev-parse HEAD)"
  if ! pull="$(git subrepo pull "$dir" 2>&1)"; then
    reasons="$reasons pull-failed"
  fi
  after="$(git rev-parse HEAD)"
  [ "$before" = "$after" ] || reasons="$reasons pull-created-a-commit"
  case "$pull" in
    *"up to date"*) : ;;
    *) [ -n "${reasons:-}" ] || reasons="$reasons pull-not-a-noop($(printf '%s' "$pull" | tail -1))" ;;
  esac

  if [ -n "${reasons:-}" ]; then
    fail=$((fail + 1))
    printf 'FAIL %-46s %-34s%s\n' "$dir" "$want_branch" "$reasons"
  else
    pass=$((pass + 1))
    printf 'ok   %-46s %-34s %s\n' "$dir" "$want_branch" "${want_commit:0:8}"
  fi
done

echo
if [ "$seen" -ne "$EXPECTED" ]; then
  echo "FAIL subrepo count: found $seen, expected $EXPECTED" >&2
  fail=$((fail + 1))
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL the throwaway clone is dirty after pulling — a pull is not a no-op" >&2
  git status --short | head >&2
  fail=$((fail + 1))
fi

if [ "$fail" -ne 0 ]; then
  echo "gate FAILED: $fail problem(s), $pass subrepo(s) clean" >&2
  exit 1
fi
echo "gate passed: $pass/$EXPECTED subrepos reproduce from a fresh clone, every pull a no-op"
