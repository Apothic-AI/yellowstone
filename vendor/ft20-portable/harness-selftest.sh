#!/usr/bin/env bash
# harness-selftest.sh — negatives for the two harness defects the source
# acceptance found. Both are properties that only a negative can demonstrate:
# a guard that never refuses and a validator that never rejects are
# indistinguishable from working code on a green run.
#
#   ./harness-selftest.sh            run every case, write a receipt
#
# Part A — containment (review finding 2: "advertises outside-repo scratch but
# does not enforce it"; the rebuilt check was lexical, not canonical). Each case
# runs lib/scratch-guard.sh and asserts the refusal, so the guard is tested as
# an executable boundary rather than by reading its comments.
#
# Part B — strict JSON (review finding 4: rebuild-receipt.json had a trailing
# comma). Valid input must pass, and two malformed inputs must fail — one of
# them the *exact* historical malformed shape, so the regression is the defect
# itself, not a stand-in.
#
# Part C — receipt destinations (the p1E rejection). Part A only ever varied
# FT20_WORK, and the bypass was FT20_RECEIPT_DIR: a validated scratch root
# combined with an unvalidated output directory. Part C runs the real
# entrypoints with a *valid* fresh WORK and a forbidden receipt destination, and
# requires exit 2 with the destination still absent and the scratch root still
# empty — i.e. the refusal happens before any write, not after.
#
# Nothing here touches the repository: every path used is under a scratch root
# that is itself validated by the guard first.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/lib/scratch-guard.sh"
VALIDATOR="$HERE/lib/strict-json.mjs"
# Source the guard so the function prints the canonical path and nothing else;
# the standalone mode prints a human "OK: …" line, which is not a path.
. "$GUARD"
ROOT=$(ft20_require_scratch "${FT20_SELFTEST_ROOT:-/var/tmp/ft20-harness-selftest}" "$HERE") || {
  printf 'REFUSED: selftest root\n' >&2; exit 2; }
ft20_forbid_receipt_override || exit 2
RECEIPTS=$(ft20_require_output_dir "$ROOT" receipts) || exit 2

PASS=0; FAIL=0
record() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RECEIPTS/selftest.tsv"; }
expect() { # expect <label> <want:refuse|accept> <cmd...>
  local label="$1" want="$2"; shift 2
  local out rc
  out=$( "$@" 2>&1 ); rc=$?
  local got; [ "$rc" -eq 0 ] && got=accept || got=refuse
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); printf '  ok    %-44s %s\n' "$label" "$got"
    record "$label" "$want" "$got" "$(printf '%s' "$out" | head -1)"
  else
    FAIL=$((FAIL+1)); printf '  FAIL  %-44s want %s got %s\n' "$label" "$want" "$got"
    record "$label" "$want" "$got" "$(printf '%s' "$out" | head -1)"
  fi
}

: > "$RECEIPTS/selftest.tsv"
REPO_ROOT=$(git -C "$HERE" rev-parse --show-toplevel)
rm -rf "$ROOT/work"
mkdir -p "$ROOT/work"

# ---- Part A: containment -------------------------------------------------
printf '\n== containment (%s)\n' "$GUARD"
expect "absent directory outside repo"        accept "$GUARD" "$ROOT/work/fresh-absent"
expect "empty directory outside repo"         accept "$GUARD" "$ROOT/work/fresh-empty"
mkdir -p "$ROOT/work/fresh-empty"

expect "inside the repository"                refuse "$GUARD" "$REPO_ROOT/vendor/.scratch"
expect "repository root itself"               refuse "$GUARD" "$REPO_ROOT"
expect "path escaping into the repo (..)"     refuse "$GUARD" "$ROOT/work/../../../../$REPO_ROOT/x"
expect "relative path"                        refuse "$GUARD" "scratch-relative"
expect "empty argument"                       refuse "$GUARD" ""
expect "shared root /tmp"                     refuse "$GUARD" "/tmp"
expect "filesystem root /"                    refuse "$GUARD" "/"
expect "inside live HOME/.pi"                 refuse "$GUARD" "$HOME/.pi/agent/scratch"
expect "inside live HOME/.config"             refuse "$GUARD" "$HOME/.config/ft20-scratch"
expect "inside live HOME/.pi-profile-switch"  refuse "$GUARD" "$HOME/.pi-profile-switch/ft20"
expect "inside live HOME/.agents"             refuse "$GUARD" "$HOME/.agents/ft20"
expect "inside live HOME/.local/state"        refuse "$GUARD" "$HOME/.local/state/ft20-scratch"
expect "inside live HOME itself"              refuse "$GUARD" "$HOME/ft20-scratch"

# A symlinked component is the alias the lexical check could not see: the path
# string names /var/tmp/…, the bytes land in the repository.
ln -sfn "$REPO_ROOT" "$ROOT/work/repo-alias"
expect "symlink component to the repo"        refuse "$GUARD" "$ROOT/work/repo-alias/.scratch"
ln -sfn "$HOME/.pi" "$ROOT/work/live-alias"
expect "symlink component to live .pi"        refuse "$GUARD" "$ROOT/work/live-alias/scratch"
ln -sfn "$ROOT/work/fresh-empty" "$ROOT/work/plain-alias"
expect "symlink component, benign target"     refuse "$GUARD" "$ROOT/work/plain-alias"
ln -sfn "$ROOT/work/not-a-dir" "$ROOT/work/file-alias"
mkdir -p "$ROOT/work/stale"; : > "$ROOT/work/stale/leftover"
expect "existing non-empty directory"         refuse "$GUARD" "$ROOT/work/stale"
: > "$ROOT/work/a-file"
expect "existing non-directory"               refuse "$GUARD" "$ROOT/work/a-file"

# ---- Part B: strict JSON -------------------------------------------------
printf '\n== strict JSON (%s)\n' "$VALIDATOR"
node --input-type=module -e '
import fs from "node:fs";
fs.writeFileSync(process.argv[1], JSON.stringify({patch_series:[{file:"a",bytes:1,difffiles:1}],counts:{ok:1}}, null, 2) + "\n");
' "$ROOT/work/valid.json"
expect "valid receipt parses"                 accept node "$VALIDATOR" "$ROOT/work/valid.json"

# The exact historical defect: a trailing comma after the last array element.
printf '{\n  "patch_series": [\n    {"file": "a", "bytes": 1, "difffiles": 1},\n  ],\n  "counts": {}\n}\n' \
  > "$ROOT/work/trailing-comma.json"
expect "trailing comma is rejected"           refuse node "$VALIDATOR" "$ROOT/work/trailing-comma.json"
printf '{"counts": {"ok": 1,}}\n' > "$ROOT/work/trailing-comma-object.json"
expect "trailing comma in object is rejected" refuse node "$VALIDATOR" "$ROOT/work/trailing-comma-object.json"
expect "missing file is rejected"             refuse node "$VALIDATOR" "$ROOT/work/absent.json"

# A real receipt produced by the rebuild script, when one is available, must
# parse too — the generator and the gate have to agree.
if [ -n "${FT20_REBUILD_RECEIPT:-}" ] && [ -f "${FT20_REBUILD_RECEIPT}" ]; then
  expect "generated rebuild receipt parses"   accept node "$VALIDATOR" "$FT20_REBUILD_RECEIPT"
fi

# ---- Part C: receipt destinations (p1E) ----------------------------------
# Synthetic HOME only: the p1E reproduction ran against a synthetic HOME/.pi, and
# nothing here touches the real one. The destination is asserted absent and the
# scratch root empty afterwards, so a refusal that happened *after* mkdir would
# fail the case.
printf '\n== receipt destinations (entrypoints)\n'
SYNTH_HOME="$ROOT/work/synth-home"
rm -rf "$SYNTH_HOME"; mkdir -p "$SYNTH_HOME/.pi/agent"
ln -sfn "$SYNTH_HOME/.pi" "$ROOT/work/synth-pi-alias"

receipt_case() { # receipt_case <label> <entrypoint> <receipt-dir> [HOME]
  local label="$1" ep="$2" dest="$3" use_home="${4:-$HOME}"
  local work="$ROOT/work/rc-$(printf '%s' "$label" | tr -c 'a-z0-9' '-' | cut -c1-40)"
  rm -rf "$work"
  local out rc
  out=$( env HOME="$use_home" FT20_WORK="$work" FT20_RECEIPT_DIR="$dest" \
          FT20_TSC=/bin/true bash "$HERE/$ep" 2>&1 )
  rc=$?
  local got; [ "$rc" -eq 0 ] && got=accept || got=refuse
  local wrote=no
  [ -e "$dest" ] && wrote=yes
  local scratch_files; scratch_files=$(find "$work" -mindepth 1 2>/dev/null | wc -l)
  local want=refuse
  if [ "$got" = "$want" ] && [ "$wrote" = no ] && [ "$scratch_files" -eq 0 ]; then
    PASS=$((PASS+1)); printf '  ok    %-44s refuse, no write\n' "$label"
    record "$label" "$want" "$got" "dest_created=$wrote scratch_entries=$scratch_files"
  else
    FAIL=$((FAIL+1))
    printf '  FAIL  %-44s want refuse/no-write got %s dest_created=%s scratch=%s\n' \
      "$label" "$got" "$wrote" "$scratch_files"
    record "$label" "$want" "$got" "dest_created=$wrote scratch_entries=$scratch_files :: $(printf '%s' "$out" | head -1)"
  fi
  rm -rf "$work"
  [ "$wrote" = yes ] && rm -rf "$dest"
}

for ep in rebuild-vendor.sh verify-portable.sh; do
  receipt_case "$ep: repo receipt dir"          "$ep" "$REPO_ROOT/receipt-bypass"
  receipt_case "$ep: synthetic HOME/.pi receipt" "$ep" "$SYNTH_HOME/.pi/agent/receipt-bypass" "$SYNTH_HOME"
  receipt_case "$ep: symlink alias to live .pi"  "$ep" "$ROOT/work/synth-pi-alias/receipt-bypass" "$SYNTH_HOME"
  receipt_case "$ep: .. escape"                  "$ep" "$ROOT/work/../../ft20-receipt-escape"
  receipt_case "$ep: relative receipt dir"       "$ep" "receipt-bypass"
  receipt_case "$ep: plain outside dir"          "$ep" "$ROOT/work/plain-outside-receipts"
done

# The selftest's own output surface behaves the same way.
rc=0; FT20_RECEIPT_DIR="$SYNTH_HOME/.pi/agent/selftest-out" bash "$HERE/harness-selftest.sh" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ] && [ ! -e "$SYNTH_HOME/.pi/agent/selftest-out" ]; then
  PASS=$((PASS+1)); printf '  ok    %-44s refuse, no write\n' "harness-selftest: receipt override"
  record "harness-selftest: receipt override" refuse refuse "dest_created=no scratch_entries=0"
else
  FAIL=$((FAIL+1)); printf '  FAIL  %-44s rc=%s\n' "harness-selftest: receipt override" "$rc"
  record "harness-selftest: receipt override" refuse "rc=$rc" "unexpected"
fi

# ---- verdict -------------------------------------------------------------
{
  printf 'selftest: pass=%s fail=%s cases=%s\n' "$PASS" "$FAIL" "$((PASS+FAIL))"
  printf 'cases: %s\n' "$RECEIPTS/selftest.tsv"
} | tee "$RECEIPTS/selftest-summary.txt"
node --input-type=module -e '
import fs from "node:fs";
const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(l => {
  const [label, want, got, detail] = l.split("\t");
  return {label, want, got, pass: want === got, detail: detail ?? ""};
});
const pass = rows.filter(r => r.pass).length;
const fail = rows.length - pass;
fs.writeFileSync(process.argv[2], JSON.stringify({
  cases: rows.length, pass, fail, all_pass: fail === 0,
  containment: rows.filter(r => r.label.match(/repo|root|relative|argument|shared|live|symlink|directory|file/)).length,
  strict_json: rows.filter(r => r.label.match(/JSON|parses|comma/)).length,
  receipt_destinations: rows.filter(r => r.label.includes("receipt")).length,
  rows,
}, null, 2) + "\n");
console.log(`receipt: ${process.argv[2]}`);
' "$RECEIPTS/selftest.tsv" "$RECEIPTS/selftest-receipt.json"

node "$VALIDATOR" "$RECEIPTS/selftest-receipt.json" > /dev/null 2>&1 \
  || { printf 'FAIL: selftest receipt is not strict JSON\n' >&2; exit 1; }

[ "$FAIL" -eq 0 ] || exit 1
