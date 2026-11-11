#!/usr/bin/env bash
# verify-portable.sh — the strict FT-20 gate, run against a *staged copy* of the
# vendored package so the committed tree is never a build directory.
#
#   FT20_WORK=/scratch/run ./verify-portable.sh
#
# Gates, in order, each one absolute rather than differential:
#
#   1  payload     106 files, byte-identical to the accepted fingerprint
#   2  deps        minimal local link (6 entries, no ancestor node_modules)
#   3  resolve     every linked name imports from the staged tree
#   4  typecheck   tsc --noEmit -p tsconfig.json -> 0 errors, strict + assertions
#   5  build       tsc -p tsconfig.build.json
#   6  tests       node --test test/*.test.mjs -> 77 pass / 0 fail / 0 skip
#   7  controls    published-base fail control -> 8/8
#   8  probes      accepted actual-entry runner -> 40/40 (30 R1 + 10 R2)
#   9  loader      `pi list` in a scratch HOME -> extension loads, boot-time only
#  10  integrity   the repo's vendored bytes are unchanged after the whole run
#  11  receipts    every emitted receipt parses as strict JSON
#
# Zero provider, zero network, zero install: the two host-SDK packages and
# typebox are symlinks, strip-ansi is the one real runtime dependency, and the
# probe/model calls are synthetic stubs inside the accepted runner.
#
# The scratch root is validated before anything is written: see
# lib/scratch-guard.sh (canonical, symlink-free, outside the repository and every
# live configuration directory, fresh). A refusal is exit 2 and nothing runs.
#
# Environment:
#   FT20_WORK          scratch dir, required, absolute, fresh, outside the repo
#                      and outside live configuration directories
#   FT20_TSC           tsc binary (default: `tsc` on PATH)
#   (no FT20_RECEIPT_DIR: there is no output override. Logs and receipts are
#    written under $FT20_WORK/receipts; setting an override is exit 2.)
#   FT20_HOST_ROOT/SDK_ROOT/NODE_TYPES/NPM_ROOT   see link-deps.sh
#   FT20_SKIP_LOADER   1 to skip gate 9 (a machine with no `pi` on PATH)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$(cd "$HERE/.." && pwd)"
PKG="$VENDOR/pi-hermes-memory-0.10.0-ft20"
PROV="$PKG/ft20-provenance"
# Containment first: a scratch root that resolves into the repo, into a live
# config directory, or through a symlink would have this script delete and
# rewrite the thing it is verifying.
. "$HERE/lib/scratch-guard.sh"
WORK=$(ft20_require_scratch "${FT20_WORK:-}" "$HERE") || exit 2
# Refuse an output override before printing progress: a run that will not write
# anywhere should not look like it has started.
ft20_forbid_receipt_override || exit 2
printf 'scratch root (canonical, guarded): %s\n' "$WORK"
RECEIPTS=$(ft20_require_output_dir "$WORK" receipts) || exit 2
STAGE=$(ft20_require_output_dir "$WORK" stage) || exit 2
printf 'receipts root (contained): %s\n' "$RECEIPTS"
TSC="${FT20_TSC:-$(command -v tsc || true)}"
CAND="$STAGE/pi-hermes-memory-0.10.0-ft20"

FAILED=0
note() { printf '%s\n' "$*"; }
hr()   { printf '%s\n' "------------------------------------------------------------"; }
gate() { local name="$1"; shift; hr; note "$name"; hr; if "$@"; then note "   ok"; else note "   FAIL"; FAILED=$((FAILED+1)); fi; }

TOTAL_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ---------------------------------------------------------------- 1 payload
payload() {
  rm -rf "$CAND"; mkdir -p "$CAND"
  ( cd "$PKG" && awk '{ sub(/^[^ ]+  /,""); print }' "$PROV/ACCEPTED-13ce3cc6a.sha256" \
      | while IFS= read -r rel; do
          mkdir -p "$CAND/$(dirname "$rel")"; cp -p "$PKG/$rel" "$CAND/$rel"
        done )
  ( cd "$CAND" && sha256sum -c "$PROV/ACCEPTED-13ce3cc6a.sha256" > "$RECEIPTS/payload-check.txt" 2>&1 )
  local ok; ok=$(grep -c ': OK$' "$RECEIPTS/payload-check.txt")
  local files; files=$(find "$CAND" -type f | wc -l)
  note "   files=$files  sha256_ok=$ok/106"
  [ "$files" -eq 106 ] && [ "$ok" -eq 106 ]
}

# ------------------------------------------------------------------- 2 deps
deps() {
  # No ancestor may hold node_modules: the tree must link what it needs.
  local a="$CAND"
  : > "$RECEIPTS/no-ancestor.txt"
  while [ "$a" != / ]; do
    a="$(dirname "$a")"
    if [ -e "$a/node_modules" ]; then note "   ancestor node_modules: $a"; return 1; fi
    printf 'no node_modules: %s\n' "$a" >> "$RECEIPTS/no-ancestor.txt"
  done
  "$HERE/link-deps.sh" "$CAND" 2>&1 | tee "$RECEIPTS/link-deps.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || return 1
  # Exactly the six required entries (the optional native sqlite link is extra).
  local need=( "@earendil-works/pi-coding-agent" "@earendil-works/pi-ai" \
               "@earendil-works/pi-tui" "@types/node" "typebox" "strip-ansi" )
  local n
  for n in "${need[@]}"; do
    if [ -L "$CAND/node_modules/$n" ]; then note "   linked $n"; else note "   MISSING link $n"; return 1; fi
  done
  local extra; extra=$(find "$CAND/node_modules" -maxdepth 3 -name package.json | wc -l)
  note "   package.json entries reachable through node_modules: $extra"
  # The selection receipt is written here, by the caller that owns a validated
  # receipts directory — not by link-deps.sh, which must not have a destination
  # it can be pointed at from the environment.
  ( cd "$CAND" && node --input-type=module -e '
const fs = await import("node:fs");
const names = ["@earendil-works/pi-coding-agent","@earendil-works/pi-ai","@earendil-works/pi-tui","@types/node","typebox","strip-ansi","better-sqlite3"];
const out = [];
for (const name of names) {
  const p = "node_modules/" + name + "/package.json";
  if (!fs.existsSync(p)) { out.push({name, linked: false}); continue; }
  out.push({name, linked: true, version: JSON.parse(fs.readFileSync(p,"utf8")).version, file: fs.realpathSync(p)});
}
console.log(JSON.stringify(out, null, 2));
' ) > "$RECEIPTS/sdk-selection.json" || { note "   could not write sdk-selection.json"; return 1; }
}

# ---------------------------------------------------------------- 3 resolve
resolve() {
  ( cd "$CAND" && node --input-type=module -e '
import fs from "node:fs";
// Five of the six are real modules. @types/node is a types-only package with no
// runtime entry point, so resolving it as a module is a false negative; what the
// compiler needs from it is its declaration surface on disk.
const names = ["@earendil-works/pi-coding-agent","@earendil-works/pi-ai","@earendil-works/pi-tui","typebox","strip-ansi"];
for (const n of names) {
  const u = import.meta.resolve(n);
  if (!u) { console.error("unresolved: " + n); process.exit(1); }
  console.log("resolve " + n + " -> " + u);
}
const types = "node_modules/@types/node/index.d.ts";
if (!fs.existsSync(types)) { console.error("unresolved: @types/node (no " + types + ")"); process.exit(1); }
console.log("resolve @types/node -> " + types + " (types-only)");
' ) 2>&1 | tee "$RECEIPTS/resolve.log"
  [ "${PIPESTATUS[0]}" -eq 0 ]
}

# -------------------------------------------------------------- 4 typecheck
typecheck() {
  ( cd "$CAND" && "$TSC" --noEmit -p tsconfig.json ) > "$RECEIPTS/typecheck.log" 2>&1
  local rc=$? errors
  errors=$(grep -cE 'error TS' "$RECEIPTS/typecheck.log")
  note "   exit=$rc errors=$errors (strict, includes test/types/ assertions)"
  [ "$rc" -eq 0 ] && [ "$errors" -eq 0 ]
}

# ------------------------------------------------------------------ 5 build
build() {
  ( cd "$CAND" && rm -rf dist && "$TSC" -p tsconfig.build.json ) > "$RECEIPTS/build.log" 2>&1
  local rc=$?
  local js; js=$(find "$CAND/dist" -name '*.js' 2>/dev/null | wc -l)
  note "   exit=$rc emitted_js=$js"
  [ "$rc" -eq 0 ] && [ "$js" -ge 6 ]
}

# ------------------------------------------------------------------ 6 tests
tests() {
  ( cd "$CAND" && timeout 300 node --test test/*.test.mjs ) > "$RECEIPTS/tests-full.log" 2>&1
  local rc=$?
  local pass fail skip cancel
  pass=$(grep -m1 '^# pass ' "$RECEIPTS/tests-full.log" | awk '{print $3}')
  fail=$(grep -m1 '^# fail ' "$RECEIPTS/tests-full.log" | awk '{print $3}')
  skip=$(grep -m1 '^# skipped ' "$RECEIPTS/tests-full.log" | awk '{print $3}')
  cancel=$(grep -m1 '^# cancelled ' "$RECEIPTS/tests-full.log" | awk '{print $3}')
  note "   exit=$rc pass=$pass fail=$fail skipped=$skip cancelled=$cancel"
  [ "$rc" -eq 0 ] && [ "$pass" = 77 ] && [ "$fail" = 0 ] && [ "$skip" = 0 ] && [ "$cancel" = 0 ]
}

# --------------------------------------------------------------- 7 controls
controls() {
  local base="$WORK/base"
  rm -rf "$base"; cp -a "$CAND" "$base"
  local series=( 0001-fail-closed-parser-redacted-diagnostics.patch
                 0002-host-sdk-strict-typecheck.patch
                 0003-terminal-partial-apply-diagnostic-containment.patch
                 0004-child-failure-empty-consolidation-boundary.patch )
  ( cd "$base" && for ((i=${#series[@]}-1; i>=0; i--)); do
      git apply -R "$PROV/patches/${series[$i]}" || exit 1
    done ) || { note "   reverse apply failed"; return 1; }
  rm -rf "$base/dist" "$base/node_modules"
  ln -sfn "$CAND/node_modules" "$base/node_modules"
  # The published base predates schema-compat.ts, so its build config lists only
  # the files that exist there — exactly what the vendored scripts/verify.sh does.
  cat > "$base/tsconfig.build.json" <<EOF
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "$WORK/base-build", "noEmitOnError": true },
  "include": ["src/handlers/review-memory-ops.ts", "src/handlers/background-review.ts"]
}
EOF
  cp "$CAND/tsconfig.json" "$base/tsconfig.json"
  mkdir -p "$WORK/base-build"
  # The base build writes to $WORK/base-build, i.e. outside $base, so its own
  # node_modules is not on the resolution path. The vendored scripts/verify.sh
  # solves this the same way: one symlink at the parent that holds the output.
  ln -sfn "$CAND/node_modules" "$WORK/node_modules"
  ( cd "$base" && "$TSC" -p tsconfig.build.json ) > "$RECEIPTS/base-build.log" 2>&1 || { note "   base build failed"; return 1; }
  ( cd "$CAND" && node test/base-control.mjs "$WORK/base-build" "$CAND/dist" ) > "$RECEIPTS/base-control.log" 2>&1
  local rc=$? line
  line=$(grep -m1 'base-control:' "$RECEIPTS/base-control.log")
  note "   exit=$rc ${line:-no summary}"
  [ "$rc" -eq 0 ] && [[ "$line" == *"8/8 checks passed"* ]]
}

# ----------------------------------------------------------------- 8 probes
probes() {
  local dir="$WORK/probe"
  mkdir -p "$dir"
  cp "$HERE/probes/actual-probes.mjs" "$dir/actual-probes.mjs"
  local want; want=$(awk '/actual-probes.mjs$/ {print $1}' "$HERE/probes/PINNED.sha256")
  local got; got=$(sha256sum "$dir/actual-probes.mjs" | cut -d' ' -f1)
  note "   runner sha256 ${got:0:16}… (pinned ${want:0:16}…)"
  [ "$got" = "$want" ] || { note "   runner bytes differ from the pinned accepted runner"; return 1; }
  ( cd "$dir" && timeout 120 node actual-probes.mjs "$CAND/dist" \
      13ce3cc6a47c5dcf3ea2eef899ba04b9079f2fce ) > "$RECEIPTS/actual-probes.log" 2>&1
  local rc=$?
  node --input-type=module -e '
import fs from "node:fs";
// The runner prints one JSON row per check and a trailing summary row
// ({revision, failed}). Only rows carrying a name and a boolean verdict are
// checks; counting the summary as a check is how 40 becomes 41.
const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(l => JSON.parse(l))
  .filter(r => typeof r.name === "string" && typeof r.pass === "boolean");
const pass = rows.filter(r => r.pass).length;
const fail = rows.length - pass;
const R1 = rows.filter(r => r.pass && r.name.startsWith("R1")).length;
const R2 = rows.filter(r => r.pass && r.name.startsWith("R2")).length;
fs.writeFileSync(process.argv[2], JSON.stringify({total: rows.length, pass, fail, R1pass: R1, R2pass: R2}, null, 2));
console.log(`   probes total=${rows.length} pass=${pass} fail=${fail} R1=${R1} R2=${R2}`);
process.exit(pass === 40 && fail === 0 && R1 === 30 && R2 === 10 ? 0 : 1);
' "$RECEIPTS/actual-probes.log" "$RECEIPTS/actual-probes.summary.json"
  local tally=$?
  [ "$rc" -eq 0 ] && [ "$tally" -eq 0 ]
}

# ----------------------------------------------------------------- 9 loader
loader() {
  LOADER_STATUS="not run"
  if [ "${FT20_SKIP_LOADER:-0}" = 1 ]; then
    LOADER_STATUS="skipped: FT20_SKIP_LOADER=1"
    note "   skipped (FT20_SKIP_LOADER=1) — recorded as skipped, not as evidence"
    return 0
  fi
  if ! command -v pi >/dev/null 2>&1; then
    LOADER_STATUS="skipped: no pi on PATH"
    note "   skipped (no pi on PATH) — recorded as skipped, not as evidence"
    return 0
  fi
  local home="$WORK/pi-home"
  rm -rf "$home"; mkdir -p "$home/.pi/agent"
  cat > "$home/.pi/agent/settings.json" <<EOF
{
  "packages": ["$CAND"]
}
EOF
  local before after
  before=$(find "$home" -type f | sort | xargs -r sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)
  ( cd "$WORK" && HOME="$home" PI_CODING_AGENT_DIR="$home/.pi/agent" PI_OFFLINE=1 \
      timeout 120 pi list ) > "$RECEIPTS/loader.log" 2>&1
  local rc=$?
  after=$(find "$home" -type f | sort | xargs -r sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)
  local bad; bad=$(grep -c 'Failed to load extension' "$RECEIPTS/loader.log")
  local listed; listed=$(grep -cF "$CAND" "$RECEIPTS/loader.log")
  note "   exit=$rc load_failures=$bad package_listed=$listed scratch_unchanged=$([ "$before" = "$after" ] && echo yes || echo no)"
  if [ "$rc" -eq 0 ] && [ "$bad" -eq 0 ] && [ "$listed" -ge 1 ] && [ "$before" = "$after" ]; then
    LOADER_STATUS="ran: exit 0, 0 load failures, package listed, scratch unchanged"
    return 0
  fi
  LOADER_STATUS="ran: FAILED"
  return 1
}

# -------------------------------------------------------------- 10 integrity
integrity() {
  ( cd "$PKG" && sha256sum -c "$PROV/ACCEPTED-13ce3cc6a.sha256" ) > "$RECEIPTS/vendor-integrity.txt" 2>&1
  local ok; ok=$(grep -c ': OK$' "$RECEIPTS/vendor-integrity.txt")
  note "   committed vendored bytes after the run: $ok/106 OK"
  [ "$ok" -eq 106 ]
}

gate "1. payload — 106 accepted files, exact bytes"        payload
gate "2. deps — minimal local link, no ancestor node_modules" deps
gate "3. resolve — six linked names import from the tree"   resolve
gate "4. typecheck — strict, zero errors"                  typecheck
gate "5. build — changed modules"                          build
gate "6. tests — node --test (expect 77)"                  tests
gate "7. controls — published-base fail control (expect 8/8)" controls
gate "8. probes — accepted actual-entry runner (expect 40)" probes
gate "9. loader — scratch HOME, offline, boot only"         loader
gate "10. integrity — vendored bytes unchanged by the run"  integrity

# The gate receipt is serialised, not interpolated, and then parsed back by the
# same validator a consumer would use.
FT20G_CAND="$CAND" FT20G_WORK="$WORK" FT20G_RECEIPTS="$RECEIPTS" FT20G_START="$TOTAL_START" \
FT20G_FAILED="$FAILED" FT20G_COMPILER="$( "$TSC" --version 2>/dev/null )" \
FT20G_NODE="$(node --version)" FT20G_LOADER="${LOADER_STATUS:-not run}" \
node --input-type=module -e '
import fs from "node:fs";
const e = process.env;
const receipt = {
  vendor_package: "vendor/pi-hermes-memory-0.10.0-ft20",
  accepted_source: "13ce3cc6a47c5dcf3ea2eef899ba04b9079f2fce",
  staged_copy: e.FT20G_CAND,
  started_utc: e.FT20G_START,
  finished_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  failed_gates: Number(e.FT20G_FAILED),
  compiler: e.FT20G_COMPILER,
  node: e.FT20G_NODE,
  provider_calls: "none (synthetic stubs only)",
  network: "none",
  install_or_postinstall: "none",
  containment: {
    scratch_root: e.FT20G_WORK,
    receipts_root: e.FT20G_RECEIPTS,
    output_override: "refused (FT20_RECEIPT_DIR is unsupported)",
    guard: "lib/scratch-guard.sh",
    canonical: true,
    symlink_components: "refused",
    repo_and_live_dirs: "refused",
    freshness: "absent or empty",
  },
  loader_gate: e.FT20G_LOADER,
  receipt_format: {serialiser: "JSON.stringify", self_check: "JSON.parse via lib/strict-json.mjs"},
};
fs.writeFileSync(process.argv[1], JSON.stringify(receipt, null, 2) + "\n");
' "$RECEIPTS/gate-receipt.json" || { note "could not write gate-receipt.json"; FAILED=$((FAILED+1)); }

# ---------------------------------------------------------------- 11 receipts
receipts() {
  local files=() f
  for f in "$RECEIPTS"/*.json; do [ -e "$f" ] && files+=( "$f" ); done
  ( cd "$HERE" && node lib/strict-json.mjs "${files[@]}" ) 2>&1 | tee "$RECEIPTS/strict-json.log"
  local rc=${PIPESTATUS[0]}
  note "   parsed ${#files[@]} receipt file(s), exit=$rc"
  [ "$rc" -eq 0 ] && [ "${#files[@]}" -ge 2 ]
}

gate "11. receipts — every emitted receipt is strict JSON" receipts

hr
if [ "$FAILED" -eq 0 ]; then
  note "GREEN — every gate exact"; hr; exit 0
else
  note "RED — $FAILED gate(s) failed"; hr; exit 1
fi
