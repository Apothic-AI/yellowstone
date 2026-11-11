#!/usr/bin/env bash
# FT-20 candidate verification. Deterministic, offline, no provider, no agent.
#
#   scripts/verify.sh            full run (link, typecheck x2, build, tests, base control)
#
# Exit codes: 0 green · 1 a test or control failed · 2 a setup/dependency problem.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

TSC_BIN="${TSC_BIN:-/home/bitnom/Code/codex-mcp-server/node_modules/typescript/bin/tsc}"
TSC="node $TSC_BIN"
BASE_COMMIT="${BASE_COMMIT:-5a1446c2a}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$@"; }
hr() { printf '%s\n' "------------------------------------------------------------"; }

[ -x "$TSC_BIN" ] || { echo "no TypeScript compiler at $TSC_BIN (set TSC_BIN)"; exit 2; }

hr; say "1. link local deps (no install, no network)"; hr
./scripts/link-local-deps.sh >/dev/null || exit 2
say "   ok"

hr; say "2. typecheck: whole component, strict, must be clean"; hr
# Absolute gate. Not a differential comparison against any baseline: this tree
# has to typecheck with zero errors, including the compile-time API-compat
# assertions under test/types/. The two host-SDK typing errors that 0.10.0
# shipped with are fixed in this candidate, not excused.
set -o pipefail
$TSC --noEmit -p tsconfig.json 2>&1 | tee "$WORK/typecheck.log"
TC_STATUS=${PIPESTATUS[0]}
TC_ERRORS=$(grep -cE 'error TS' "$WORK/typecheck.log" || true)
if [ "$TC_STATUS" -ne 0 ] || [ "$TC_ERRORS" -ne 0 ]; then
  say "   FAIL: typecheck reported $TC_ERRORS error(s)"
  exit 1
fi
say "   ok — 0 type errors"
set +o pipefail
say "   (compile-time API-compat assertions included via test/types/)"

hr; say "2b. export the committed base (needed only for the base fail control)"; hr
# git archive resolves pathspecs relative to the invoking directory, so run it
# from the worktree top.
git -C "$(git rev-parse --show-toplevel)" archive "$BASE_COMMIT" \
  src/pi-extensions/pi-hermes-memory-review-fix | tar -x -C "$WORK" 2>/dev/null
BASE_DIR="$WORK/src/pi-extensions/pi-hermes-memory-review-fix"
if [ -d "$BASE_DIR" ]; then
  ln -sfn "$HERE/node_modules" "$BASE_DIR/node_modules"
else
  say "   FAIL: could not export base commit $BASE_COMMIT"; exit 2
fi

hr; say "3. build the changed modules"; hr
rm -rf dist
$TSC -p tsconfig.build.json || { say "   FAIL: build"; exit 1; }
say "   ok"

hr; say "4. deterministic test suite (no provider, no network, no store)"; hr
node --test test/*.test.mjs 2>&1 | tee "$WORK/tests.log" | tail -9
TEST_STATUS=${PIPESTATUS[0]}
[ "$TEST_STATUS" -eq 0 ] || { say "   FAIL: tests"; exit 1; }

hr; say "5. base fail control (the defect, on the published base)"; hr
BASE_BUILD="$WORK/base-build"
mkdir -p "$BASE_BUILD"
# The base predates schema-compat.ts, so its build config lists only the two
# files that exist at that commit. Anything else would make the compiler fall
# back to defaults and report a flood of unrelated errors.
cat > "$BASE_DIR/tsconfig.build.json" <<EOF
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "$BASE_BUILD", "noEmitOnError": true },
  "include": ["src/handlers/review-memory-ops.ts", "src/handlers/background-review.ts"]
}
EOF
# ... and it needs the same compiler settings the candidate uses.
cp tsconfig.json "$BASE_DIR/tsconfig.json"
# The base build lives outside this tree, so give it the same linked deps.
ln -sfn "$HERE/node_modules" "$WORK/node_modules"
( cd "$BASE_DIR" && $TSC -p tsconfig.build.json ) || { say "   FAIL: base build"; exit 1; }
node test/base-control.mjs "$BASE_BUILD" "$HERE/dist" || exit 1

hr; say "GREEN"; hr
