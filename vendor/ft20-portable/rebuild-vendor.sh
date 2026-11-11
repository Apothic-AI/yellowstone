#!/usr/bin/env bash
# rebuild-vendor.sh — prove the vendored tree is reproducible offline, from a
# published base plus the four recorded patches, with no git history, no network
# and no access to the source worktree.
#
#   ./rebuild-vendor.sh            reconstruct, verify, write a receipt
#
# What it does, in order:
#
#   1. Stage the vendored package (only the 106 accepted files) into scratch.
#   2. RE-VERSE the patch series to recover the imported base: 106 files -> 94.
#      Verify the 92 files of the published tarball still match
#      BASE-MANIFEST.sha256, and that only the two importer files remain
#      unlisted. That is the "this is really upstream 0.10.0" half.
#   3. RE-PLAY the series forward and compare every one of the 106 files against
#      ACCEPTED-13ce3cc6a.sha256 — the independent reacceptance fingerprint of
#      the accepted commit. Zero mismatch, zero missing, zero extra.
#
# Exit 0 only if every count is exact. The receipt records the counts, not a
# verdict word.
#
#   FT20_WORK        scratch dir (required). Must be absolute, symlink-free,
#                    outside the repository and outside every live configuration
#                    directory, and fresh (absent or empty) — enforced by
#                    lib/scratch-guard.sh, which refuses otherwise.
#
# There is no receipt-directory override: every writable output — receipts
# included — is under the validated scratch root. Setting FT20_RECEIPT_DIR is an
# error (see lib/scratch-guard.sh), because a validated FT20_WORK must not be
# combinable with an unvalidated destination.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$(cd "$HERE/.." && pwd)"
PKG="$VENDOR/pi-hermes-memory-0.10.0-ft20"
PROV="$PKG/ft20-provenance"

# Containment first: nothing below may run against an unvalidated path.
. "$HERE/lib/scratch-guard.sh"
WORK=$(ft20_require_scratch "${FT20_WORK:-}" "$HERE") || exit 2
ft20_forbid_receipt_override || exit 2
RECEIPTS=$(ft20_require_output_dir "$WORK" receipts) || exit 2
printf 'scratch root (canonical, guarded): %s\n' "$WORK"
printf 'receipts root (contained): %s\n' "$RECEIPTS"

BASE_COUNT=94      # 92 published files + PROVENANCE.md + BASE-MANIFEST.sha256
EXACT_COUNT=106
PATCHES=(
  0001-fail-closed-parser-redacted-diagnostics.patch
  0002-host-sdk-strict-typecheck.patch
  0003-terminal-partial-apply-diagnostic-containment.patch
  0004-child-failure-empty-consolidation-boundary.patch
)

fail() { printf 'FAIL: %s\n' "$*"; exit 1; }

# The scratch root is validated above by lib/scratch-guard.sh (canonical,
# symlink-free, outside the repo and live directories, fresh). The staged copy
# is also the no-ancestor guard: a vendor tree staged under a directory that has
# its own node_modules would resolve deps it never linked.

STAGE="$WORK/rebuild"
rm -rf "$STAGE"
mkdir -p "$STAGE/base"

# ---- 1. stage exactly the accepted payload -------------------------------
manifest_paths() { awk '{ sub(/^[^ ]+  /,""); sub(/^\.\//,""); print }' "$1"; }

( cd "$PKG" && manifest_paths "$PROV/ACCEPTED-13ce3cc6a.sha256" | while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      mkdir -p "$STAGE/base/$(dirname "$rel")"
      cp -p "$PKG/$rel" "$STAGE/base/$rel"
    done )
staged=$(find "$STAGE/base" -type f | wc -l)
[ "$staged" -eq "$EXACT_COUNT" ] || fail "staged $staged files, expected $EXACT_COUNT"

# ---- 2. reverse the series to recover the import ------------------------
(
  cd "$STAGE/base" || exit 1
  for n in 3 2 1 0; do
    git apply -R "$PROV/patches/${PATCHES[$n]}" || { echo "FAIL: reverse ${PATCHES[$n]}"; exit 1; }
  done
) || fail "reverse apply"

base_files=$(find "$STAGE/base" -type f | wc -l)
[ "$base_files" -eq "$BASE_COUNT" ] || fail "base has $base_files files, expected $BASE_COUNT"

# Every file the published tarball shipped must still hash-match upstream.
manifest_ok=$( cd "$STAGE/base" && sha256sum -c BASE-MANIFEST.sha256 2>/dev/null | grep -c ': OK$' )
[ "$manifest_ok" -eq 92 ] || fail "BASE-MANIFEST matched $manifest_ok/92"

extra=$( cd "$STAGE/base" && find . -type f | sed 's|^\./||' | sort \
  | grep -vxF -f <(manifest_paths BASE-MANIFEST.sha256) || true )
[ "$extra" = "$(printf 'BASE-MANIFEST.sha256\nPROVENANCE.md')" ] \
  || fail "unexpected files outside the published manifest: $extra"

# ---- 3. replay the series and compare to the accepted bytes --------------
(
  cd "$STAGE/base" || exit 1
  for p in "${PATCHES[@]}"; do
    git apply "$PROV/patches/$p" || { echo "FAIL: apply $p"; exit 1; }
  done
) || fail "forward apply"

final_files=$(find "$STAGE/base" -type f | wc -l)
[ "$final_files" -eq "$EXACT_COUNT" ] || fail "replayed tree has $final_files files, expected $EXACT_COUNT"

cmp_count=0; mismatch=0; missing=0
while IFS= read -r line; do
  want="${line%%  *}"; rel="${line#*  }"; rel="${rel#./}"
  if [ ! -f "$STAGE/base/$rel" ]; then missing=$((missing+1)); echo "missing: $rel"; continue; fi
  got=$(sha256sum "$STAGE/base/$rel" | cut -d' ' -f1)
  if [ "$got" = "$want" ]; then cmp_count=$((cmp_count+1)); else mismatch=$((mismatch+1)); echo "mismatch: $rel"; fi
done < "$PROV/ACCEPTED-13ce3cc6a.sha256"
[ "$missing" -eq 0 ] || fail "$missing accepted file(s) missing from the replayed tree"
[ "$mismatch" -eq 0 ] || fail "$mismatch byte mismatch(es) against the accepted fingerprint"
[ "$cmp_count" -eq "$EXACT_COUNT" ] || fail "compared $cmp_count/$EXACT_COUNT"

# ---- receipt ------------------------------------------------------------
# Serialised by JSON.stringify, not by a heredoc with hand-placed commas. The
# previous release emitted a trailing comma after the final patch row and
# shipped a file no parser accepts (review finding 4). Here the commas are the
# serialiser's problem, and the result is parsed again before the script may
# exit 0.
rows="$WORK/patch-rows.tsv"
: > "$rows"
for p in "${PATCHES[@]}"; do
  printf '%s\t%s\t%s\n' "$p" "$(stat -c%s "$PROV/patches/$p")" "$(grep -c '^diff --git' "$PROV/patches/$p")" >> "$rows"
done

FT20R_STAGED="$staged" FT20R_BASE="$base_files" FT20R_MANIFEST="$manifest_ok" \
FT20R_REPLAYED="$final_files" FT20R_MATCHED="$cmp_count" FT20R_MISMATCH="$mismatch" \
FT20R_MISSING="$missing" FT20R_SCRATCH="$WORK" \
node --input-type=module -e '
import fs from "node:fs";
const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(line => {
  const [file, bytes, difffiles] = line.split("\t");
  return {file, bytes: Number(bytes), difffiles: Number(difffiles)};
});
const e = process.env;
const receipt = {
  vendor_package: "vendor/pi-hermes-memory-0.10.0-ft20",
  accepted_source: "13ce3cc6a47c5dcf3ea2eef899ba04b9079f2fce",
  imported_base_commit: "5a1446c2a819d78a8dae17bf06926e1b8e02937f",
  upstream: "npm:pi-hermes-memory 0.10.0 (92 files, BASE-MANIFEST.sha256)",
  method: "stage accepted payload, reverse the 4-patch series, verify BASE-MANIFEST, replay forward, compare sha256",
  patch_series: rows,
  counts: {
    staged_accepted_files: Number(e.FT20R_STAGED),
    reversed_base_files: Number(e.FT20R_BASE),
    base_manifest_ok: Number(e.FT20R_MANIFEST),
    replayed_files: Number(e.FT20R_REPLAYED),
    accepted_bytes_matched: Number(e.FT20R_MATCHED),
    mismatches: Number(e.FT20R_MISMATCH),
    missing: Number(e.FT20R_MISSING),
    extra_beyond_manifest: 2,
  },
  containment: {
    scratch_root: e.FT20R_SCRATCH,
    guard: "lib/scratch-guard.sh",
    canonical: true,
    symlink_components: "refused",
    repo_and_live_dirs: "refused",
    freshness: "absent or empty",
  },
  receipt_format: {
    serialiser: "JSON.stringify",
    self_check: "JSON.parse via lib/strict-json.mjs",
  },
  environment: {
    network: "none",
    source_worktree: "not consulted",
    git_history: "not consulted (patches only)",
  },
};
fs.writeFileSync(process.argv[2], JSON.stringify(receipt, null, 2) + "\n");
' "$rows" "$RECEIPTS/rebuild-receipt.json" || fail "could not write rebuild-receipt.json"

# The receipt is checked the way a consumer would check it. A malformed receipt
# fails this script; it is not reported as a successful rebuild with a bad file
# beside it.
node "$HERE/lib/strict-json.mjs" "$RECEIPTS/rebuild-receipt.json" > "$RECEIPTS/rebuild-receipt.strict-json.txt" 2>&1 \
  || { cat "$RECEIPTS/rebuild-receipt.strict-json.txt" >&2; fail "rebuild-receipt.json is not strict JSON"; }
cat "$RECEIPTS/rebuild-receipt.strict-json.txt"

{
  echo "rebuild: staged=$staged base=$base_files manifest=$manifest_ok/92 replayed=$final_files exact=$cmp_count/$EXACT_COUNT mismatch=$mismatch missing=$missing"
  echo "receipt: $RECEIPTS/rebuild-receipt.json (strict JSON verified)"
} | tee "$RECEIPTS/rebuild-receipt.txt"
