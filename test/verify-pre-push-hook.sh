#!/usr/bin/env bash
# verify-pre-push-hook.sh — make the hook fail on purpose, or it is a file, not a control.
#
# scripts/githooks/pre-push is the only thing that runs the mirror-vs-live check at push
# time. A hook that nothing exercises is a *description* of protection: the moment either
# script it calls changes its interface, the hook keeps existing and stops guarding, and
# its presence still reads as safety. So this builds both cases in a throwaway repo —
# one where its checks pass, one where one is planted to fail — and asserts the verdict.
#
# It also asserts the hook is WIRED. Present-but-unwired is the exact state a reader
# assumes is covered, and it is invisible in a file listing.
set -uo pipefail
REPO="$(cd -- "$(dirname -- "$0")/.." && pwd)"
hook="$REPO/scripts/githooks/pre-push"
fail=0
ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  fail %s\n' "$1"; fail=1; }

[ -x "$hook" ] && ok "hook is present and executable" || bad "hook is missing or not executable"

wired=no
[ "$(git -C "$REPO" config --get core.hooksPath 2>/dev/null)" = "scripts/githooks" ] && wired=yes
[ -x "$REPO/.git/hooks/pre-push" ] && wired=yes
[ "$wired" = yes ] && ok "hook is wired into git (core.hooksPath or .git/hooks)" \
  || bad "hook exists but nothing runs it — set core.hooksPath=scripts/githooks"

P="$(mktemp -d)"
mkdir -p "$P/test" "$P/scripts/githooks"
cp "$hook" "$P/scripts/githooks/pre-push"
printf '#!/usr/bin/env bash\nexit 0\n' > "$P/test/verify-revert-detection.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$P/test/verify-mirror-live.sh"
( cd "$P" && git init -q . && git config user.email t@t && git config user.name t \
  && git add -A && git commit -qm fixture ) >/dev/null 2>&1

( cd "$P" && bash scripts/githooks/pre-push ) >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok "hook passes when its checks pass" \
  || bad "hook failed on a passing tree (rc=$rc)"

# The planted failure: same tree, one dependency now exits non-zero.
printf '#!/usr/bin/env bash\nexit 1\n' > "$P/test/verify-mirror-live.sh"
( cd "$P" && bash scripts/githooks/pre-push ) >/dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && ok "hook blocks when a check fails" \
  || bad "hook passed with a failing check — it is not a control"

# A ABSENT check is not a PASSING check. This is the durable half of the hook fix:
# `[ -f "$t" ] || continue` made a renamed or deleted dependency exit 0, so the hook
# kept reporting success for a push it never checked. Each case below must fail, and
# must name what is missing, because a silent non-zero sends a lane hunting the
# wrong thing.
restore_checks() {
  printf '#!/usr/bin/env bash\nexit 0\n' > "$P/test/verify-revert-detection.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$P/test/verify-mirror-live.sh"
}
restore_checks

rm -f "$P/test/verify-revert-detection.sh"
out="$( cd "$P" && bash scripts/githooks/pre-push 2>&1 )"; rc=$?
[ "$rc" != 0 ] && ok "hook blocks when ONE check (revert-detection) is missing" \
  || bad "hook passed with verify-revert-detection.sh missing — a skipped check reads as coverage"
case "$out" in
  *"verify-revert-detection.sh"*"missing"*) ok "…and names the missing revert-detection check" ;;
  *) bad "missing-check failure did not name verify-revert-detection.sh: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')" ;;
esac

restore_checks
rm -f "$P/test/verify-mirror-live.sh"
out="$( cd "$P" && bash scripts/githooks/pre-push 2>&1 )"; rc=$?
[ "$rc" != 0 ] && ok "hook blocks when ONE check (mirror-live) is missing" \
  || bad "hook passed with verify-mirror-live.sh missing"
case "$out" in
  *"verify-mirror-live.sh"*"missing"*) ok "…and names the missing mirror-live check" ;;
  *) bad "missing-check failure did not name verify-mirror-live.sh" ;;
esac

restore_checks
rm -f "$P/test/verify-revert-detection.sh" "$P/test/verify-mirror-live.sh"
out="$( cd "$P" && bash scripts/githooks/pre-push 2>&1 )"; rc=$?
[ "$rc" != 0 ] && ok "hook blocks when BOTH checks are missing" \
  || bad "hook passed with both checks missing — verifying nothing is not verifying"
both=0
case "$out" in *"verify-revert-detection.sh"*) both=$((both + 1)) ;; esac
case "$out" in *"verify-mirror-live.sh"*) both=$((both + 1)) ;; esac
[ "$both" = 2 ] && ok "…and names both missing checks, not just the last one" \
  || bad "both-missing failure named $both of 2 checks"

# A present check is still trusted over a missing one: restoring must return to green,
# or the new failure mode would be indistinguishable from "this hook always fails".
restore_checks
( cd "$P" && bash scripts/githooks/pre-push ) >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok "hook passes again once both checks are restored" \
  || bad "hook stayed red after restoring both checks (rc=$rc)"

rm -rf "$P"

if [ "$fail" = 0 ]; then
  echo "gate passed: the pre-push hook is wired, passes a clean tree and blocks a planted failure"
else
  echo "gate FAILED: the pre-push hook would not stop a bad push" >&2
fi
exit "$fail"
