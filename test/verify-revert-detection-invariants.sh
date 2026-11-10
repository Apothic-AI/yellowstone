#!/usr/bin/env bash
# Exercise hook-style Git environment only against disposable callers, never this
# checkout. REVERT_DETECTION_SCRIPT can select the base script for a negative proof.
# REVERT_INVARIANTS_DIR retains snapshots and child logs outside the scratch repos.
set -euo pipefail
cd "$(dirname -- "$0")/.."
REPO="$(pwd)"
subject="${REVERT_DETECTION_SCRIPT:-$REPO/test/verify-revert-detection.sh}"
subject="$(realpath "$subject")"
unset $(git rev-parse --local-env-vars)
P="$(mktemp -d)"
trap 'rm -rf -- "$P"' EXIT
artifacts="${REVERT_INVARIANTS_DIR:-$P/evidence}"
mkdir -p "$artifacts" "$P/home" "$P/no-hooks"
artifacts="$(realpath "$artifacts")"
# No machine identity, hooks, aliases or signing settings in disposable repos.
export HOME="$P/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export LC_ALL=C

snapshot() {
  local caller="$1" dest="$2"
  mkdir -p "$dest"
  (
    cd "$caller"
    # Even a polluted bare setting must not prevent the after-snapshot.
    git() { command git -c core.bare=false --git-dir="$caller/.git" --work-tree="$caller" "$@"; }
    git rev-parse HEAD > "$dest/head"
    git symbolic-ref HEAD > "$dest/branch"
    git ls-files -s > "$dest/index"
    git diff --cached --binary > "$dest/cached.diff"
    while IFS= read -r -d '' path; do
      if [ -f "$path" ]; then sha256sum -- "$path"
      else printf 'MISSING  %s\n' "$path"; fi
    done < <(git ls-files -z) > "$dest/tracked.sha256"
    git status --porcelain=v1 --untracked-files=all > "$dest/status"
    sha256sum .git/config > "$dest/config.sha256"
  )
}

failed=0
for mode in success forced-failure; do
  caller="$P/$mode"
  evidence="$artifacts/$mode"
  mkdir -p "$caller/test" "$caller/home/.overlord/tools" "$evidence"
  cp "$subject" "$caller/test/verify-revert-detection.sh"
  cp "$REPO/test/verify-mirror-live.sh" "$caller/test/"
  cp "$REPO/home/.overlord/tools/mirror-provenance.sh" "$caller/home/.overlord/tools/"
  if [ "$mode" = forced-failure ]; then
    # Force every child mirror gate red, without changing the subject's control
    # flow: the pending case must fail, while the caller must remain untouched.
    printf '#!/usr/bin/env bash\necho "forced mirror failure (lineage)" >&2\nexit 1\n' \
      > "$caller/test/verify-mirror-live.sh"
  fi
  (
    cd "$caller"
    git init -q -b caller .
    git config core.hooksPath "$P/no-hooks"
    git config user.name caller
    git config user.email caller@example.invalid
    printf 'committed\n' > sentinel
    git add -A
    git commit -qm caller
    printf 'staged\n' > sentinel
    git add sentinel
    printf 'unstaged\n' >> sentinel
    printf 'untracked\n' > untracked-sentinel
  )
  snapshot "$caller" "$evidence/before"
  # All paths below are absolute and disposable. Include the linked-worktree
  # common dir and storage/index overrides, not just GIT_DIR/GIT_WORK_TREE.
  set +e
  GIT_DIR="$caller/.git" GIT_WORK_TREE="$caller" \
  GIT_COMMON_DIR="$caller/.git" GIT_INDEX_FILE="$caller/.git/index" \
  GIT_OBJECT_DIRECTORY="$caller/.git/objects" \
  GIT_ALTERNATE_OBJECT_DIRECTORIES="$caller/.git/objects" \
    bash "$caller/test/verify-revert-detection.sh" > "$evidence/run.log" 2>&1
  rc=$?
  set -e
  printf '%s\n' "$rc" > "$evidence/run.exit"
  snapshot "$caller" "$evidence/after"
  if diff -ru "$evidence/before" "$evidence/after" > "$evidence/invariants.diff"; then
    echo "  ok   $mode: caller HEAD/branch/index/tracked hashes/status/config unchanged"
  else
    echo "  FAIL $mode: caller changed (see $evidence/invariants.diff)" >&2
    failed=1
  fi
  if [ "$mode" = success ]; then
    if [ "$rc" = 0 ] && grep -q '^gate passed:' "$evidence/run.log"; then
      echo "  ok   success: expected gate pass (rc=0)"
    else
      echo "  FAIL success: wanted gate pass, rc=$rc" >&2
      failed=1
    fi
  else
    if [ "$rc" = 1 ] && grep -q '^gate FAILED:' "$evidence/run.log" && \
        grep -q 'forced mirror failure' "$evidence/run.log"; then
      echo "  ok   forced-failure: expected forced gate failure (rc=1)"
    else
      echo "  FAIL forced-failure: wanted forced gate failure, rc=$rc" >&2
      failed=1
    fi
  fi
done
if [ "$failed" = 0 ]; then
  echo 'gate passed: caller invariants hold on success and forced failure'
else
  echo 'gate FAILED: caller invariant regression' >&2
fi
exit "$failed"
