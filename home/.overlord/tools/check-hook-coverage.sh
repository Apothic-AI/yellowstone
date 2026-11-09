#!/usr/bin/env bash
# check-hook-coverage.sh — which checkouts of a repo carry its pre-push hook, and whether
# any of them SHOULD and does not.
#
# Why this exists: `core.hooksPath` is shared by every worktree, but the hook FILE lives in
# the tree. A checkout whose branch predates the hook commit has no file, so git skips the
# hook silently and that lane pushes unguarded with no notice. Nothing inside the tree can
# see this — a hook cannot test its own absence — so it has to be checked from outside, one
# checkout at a time.
#
# Two kinds of unguarded, and only one is a defect:
#   expected   the branch predates the hook commit; a rebase or recreate fixes it
#   DEFECT     the branch CONTAINS the hook commit but the file is missing or not executable
#
# Exit status is 1 ONLY for DEFECT. "Four old branches" must never read as a red gate, or
# the check becomes permanently red and gets ignored — the vacuous-red failure this repo has
# already been bitten by once.
set -uo pipefail

repo="${1:-$HOME/Code/yellowstone}"

if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  echo "check-hook-coverage: not a git repo: $repo" >&2
  exit 2
fi

# The commit that first added the hook. Everything after it in a branch's history means the
# file is expected to be present and executable there.
intro="$(git -C "$repo" log --format=%H --diff-filter=A -- scripts/githooks/pre-push 2>/dev/null | tail -1)"
if [ -z "$intro" ]; then
  echo "check-hook-coverage: no scripts/githooks/pre-push in this repo's history — nothing to enforce"
  exit 0
fi

guarded=0; expected=0; defect=0
printf '  %-52s %-10s %s\n' CHECKOUT HEAD STATUS

while IFS= read -r wt; do
  [ -n "$wt" ] || continue
  sha="$(git -C "$wt" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [ -x "$wt/scripts/githooks/pre-push" ]; then
    printf '  %-52s %-10s %s\n' "$wt" "$sha" guarded
    guarded=$((guarded + 1))
    continue
  fi
  if git -C "$wt" merge-base --is-ancestor "$intro" HEAD 2>/dev/null; then
    printf '  %-52s %-10s %s\n' "$wt" "$sha" "DEFECT — branch has the hook commit, file missing"
    defect=$((defect + 1))
  else
    printf '  %-52s %-10s %s\n' "$wt" "$sha" "expected — branch predates the hook"
    expected=$((expected + 1))
  fi
done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree /{print $2}')

echo
echo "  guarded=$guarded  expected-unguarded=$expected  defect=$defect   (hook added at ${intro:0:8})"

if [ "$defect" -gt 0 ]; then
  echo "  FAIL: $defect checkout(s) carry the hook commit but not the hook file" >&2
  exit 1
fi
echo "  ok: every checkout whose branch carries the hook is guarded; the rest predate it"
