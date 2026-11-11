#!/usr/bin/env bash
# verify-vendor-provenance.sh — the accepted payload is the bytes that were reviewed.
#
# The container suite asserts that a lint exemption is granted by *membership and
# matching bytes*, which is only worth something if the manifest it matches against
# cannot be rewritten. Otherwise an exemption is self-service: edit a payload file,
# regenerate the manifest from the edit, and every check agrees with itself. That is
# the failure this gate exists to make impossible, and it is why this one is
# host-side: the oracle is **git**, not the working tree.
#
# Three questions, in order:
#
#   1. Is every accepted-payload file the byte the manifest says it is? Checked twice
#      — against the working tree, and against the COMMITTED blob (`git cat-file
#      blob HEAD:<path>`). The second is the reviewed artifact; the first catches an
#      uncommitted edit that would otherwise be published as green.
#   2. Are the four provenance artifacts the four that were pinned, and are their
#      committed blobs the pinned bytes? Those four are the oracle. Pinned by hash in
#      test/lib-vendor.sh, so a rewritten manifest fails here instead of re-exempting
#      a modified file. This gate NEVER writes or regenerates them — it only reads,
#      and asserts that the manifest's hash is unchanged across its own run.
#   3. Do the negatives still bite? A modified member, a manifest doctored to cover
#      it, and an unlisted new patch are each built in a throwaway copy and required
#      to be REJECTED. A provenance check that cannot fail is a description.
#
# Needs git and a real payload; does not need network. Never touches the host.
set -uo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
# shellcheck source=lib-vendor.sh
. "$REPO_ROOT/test/lib-vendor.sh"

fail=0
ok()  { printf '  ok   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*"; fail=1; }

manifest="$VENDOR_ACCEPTED_REL"
if [ ! -f "$manifest" ]; then
  echo "gate FAILED: $manifest is missing — there is no oracle to check against" >&2
  exit 1
fi

before="$(vendor_sha256_file "$manifest")"

# ---------------------------------------------------------------- 1. members --
echo "== accepted payload vs the manifest, in the working tree and in git =="
members=0; wt_bad=0; git_bad=0
while read -r want path; do
  [ -n "$want" ] || continue
  members=$((members + 1))
  got="$(vendor_sha256_file "$VENDOR_PAYLOAD_REL/$path")"
  [ "$got" = "$want" ] || { wt_bad=$((wt_bad + 1)); bad "$path: working tree differs from the manifest"; }
  committed="$(git cat-file blob "HEAD:$VENDOR_PAYLOAD_REL/$path" 2>/dev/null | sha256sum | cut -d' ' -f1)"
  [ "$committed" = "$want" ] || { git_bad=$((git_bad + 1)); bad "$path: committed blob differs from the manifest"; }
done < "$manifest"

count="$(grep -c . "$manifest" || true)"
[ "$members" = "$count" ] || bad "manifest lists $count line(s) but only $members were checked"
[ "$members" -eq 106 ] || bad "expected the reviewed 106 members, read $members — do not regenerate this list here"
[ "$wt_bad" = 0 ] && [ "$git_bad" = 0 ] && ok "all $members members are byte-identical to the manifest, working tree and committed blob"

# No extra payload files beyond the manifest + the provenance directory this repo adds.
payload_real="$(find "$VENDOR_PAYLOAD_REL" -type f -not -path "$VENDOR_PAYLOAD_REL/ft20-provenance/*" | sed "s|^$VENDOR_PAYLOAD_REL/||" | LC_ALL=C sort)"
listed="$(awk 'NF { print $2 }' "$manifest" | LC_ALL=C sort)"
extra="$(comm -13 <(printf '%s\n' "$listed") <(printf '%s\n' "$payload_real") | grep -c . || true)"
missing="$(comm -23 <(printf '%s\n' "$listed") <(printf '%s\n' "$payload_real") | grep -c . || true)"
[ "$extra" = 0 ] || bad "$extra payload file(s) are not in the manifest (unprovenanced bytes in the accepted tree)"
[ "$missing" = 0 ] || bad "$missing manifest member(s) are absent from the payload tree"
[ "$extra" = 0 ] && [ "$missing" = 0 ] && ok "the payload tree holds exactly the manifest's files, plus ft20-provenance/"

# ------------------------------------------------------- 2. the oracle pins --
echo
echo "== the four provenance artifacts, pinned and committed =="
while IFS= read -r pin; do
  [ -n "$pin" ] || continue
  rel="${pin% *}"
  want="${pin##* }"
  got="$(vendor_sha256_file "$rel")"
  if [ "$got" = "$want" ]; then
    if [ "$(git cat-file blob "HEAD:$rel" 2>/dev/null | sha256sum | cut -d' ' -f1)" = "$want" ]; then
      ok "$rel is the pinned artifact, committed"
    else
      bad "$rel: working tree matches the pin but the committed blob does not — commit it or restore it"
    fi
  else
    bad "$rel: does not match its pin (expected ${want:0:12}…, got ${got:0:12}…). Update the pin deliberately if the artifact really changed."
  fi
done <<< "$VENDOR_ORACLE_PINS"

echo
echo "== the single exempt recorded patch =="
patch_rel="${VENDOR_PATCH_EXEMPT_PIN% *}"
patch_hash="${VENDOR_PATCH_EXEMPT_PIN##* }"
if [ "$(vendor_sha256_file "$patch_rel")" = "$patch_hash" ]; then
  ok "$(basename "$patch_rel") is the named, hash-pinned patch"
else
  bad "$patch_rel does not match its pin — an edited patch is a new record, not this one"
fi
# Everything else under patches/ is unprovenanced until someone names it. It is not
# an error to have more patches; it is an error for one to inherit an exemption.
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ "$p" != "$patch_rel" ] && vendor_exempt "$REPO_ROOT" "$p"; then
    bad "$p is exempt but is not the named patch — patches/ is not a blanket exemption"
  fi
done < <(find "$VENDOR_PAYLOAD_REL/ft20-provenance/patches" -type f -name '*.patch' | LC_ALL=C sort)
ok "no patch other than the named one inherits an exemption"

# ----------------------------------------------------------- 3. negatives --
echo
echo "== negatives: the checks must be able to fail =="
P="$(mktemp -d)"
trap 'rm -rf -- "$P"' EXIT
mkdir -p "$P/$VENDOR_PAYLOAD_REL/scripts" "$P/$VENDOR_PAYLOAD_REL/ft20-provenance/patches"
cp "$VENDOR_ACCEPTED_REL" "$P/$VENDOR_ACCEPTED_REL"
cp "$VENDOR_PAYLOAD_REL/scripts/verify.sh" "$P/$VENDOR_PAYLOAD_REL/scripts/verify.sh"
cp "$patch_rel" "$P/$patch_rel"

# (a) an unmodified member is exempt — otherwise the negatives below prove nothing
if is_accepted_vendor "$P" "$VENDOR_PAYLOAD_REL/scripts/verify.sh"; then
  ok "an unmodified member is exempt (the baseline the negatives remove)"
else
  bad "the fixture member is not exempt when it should be — the negatives below would prove nothing"
fi

# (b) a MODIFIED member loses its exemption
printf 'WorkingDirectory=%s/%s/Code/tampered\n' /home intruder >> "$P/$VENDOR_PAYLOAD_REL/scripts/verify.sh"
if is_accepted_vendor "$P" "$VENDOR_PAYLOAD_REL/scripts/verify.sh"; then
  bad "a modified member is still 'accepted' — membership is being used without the hash"
else
  ok "a modified member loses its exemption (hash, not path)"
fi
cp "$VENDOR_PAYLOAD_REL/scripts/verify.sh" "$P/$VENDOR_PAYLOAD_REL/scripts/verify.sh"

# (c) a doctored manifest cannot re-exempt it
printf 'WorkingDirectory=%s/%s/Code/tampered\n' /home intruder >> "$P/$VENDOR_PAYLOAD_REL/scripts/verify.sh"
printf '%s  scripts/verify.sh\n' "$(vendor_sha256_file "$P/$VENDOR_PAYLOAD_REL/scripts/verify.sh")" >> "$P/$VENDOR_ACCEPTED_REL"
if vendor_pin_matches "$P" "$VENDOR_ACCEPTED_REL $(vendor_oracle_pin "$VENDOR_ACCEPTED_REL")"; then
  bad "a regenerated manifest passed its pin — the oracle is not binding"
else
  ok "a regenerated manifest fails its pin, so it cannot re-exempt the edit it covers"
fi
cp "$VENDOR_ACCEPTED_REL" "$P/$VENDOR_ACCEPTED_REL"
cp "$VENDOR_PAYLOAD_REL/scripts/verify.sh" "$P/$VENDOR_PAYLOAD_REL/scripts/verify.sh"

# (d) an unlisted patch inherits nothing
printf 'WorkingDirectory=%s/%s/Code/unlisted\n' /home stranger > "$P/$VENDOR_PAYLOAD_REL/ft20-provenance/patches/0005-unreviewed.patch"
if is_provenance_patch_exempt "$P" "$VENDOR_PAYLOAD_REL/ft20-provenance/patches/0005-unreviewed.patch"; then
  bad "an unlisted patch is exempt — patches/ is still a blanket rule"
else
  ok "an unlisted new patch inherits no exemption"
fi

# (e) the accepted member's exemption is restored once the bytes are
if is_accepted_vendor "$P" "$VENDOR_PAYLOAD_REL/scripts/verify.sh"; then
  ok "restoring the exact bytes restores the exemption (so (b) failed for the right reason)"
else
  bad "the restored member is not exempt — the hash check is not reading the file correctly"
fi

# ------------------------------------------------------- wrote nothing -------
echo
echo "== this gate only reads =="
after="$(vendor_sha256_file "$manifest")"
if [ "$before" = "$after" ]; then
  ok "the accepted manifest is unchanged by this run (never regenerated here)"
else
  bad "the accepted manifest changed during the run — this gate must never write it"
fi
if [ -z "$(git status --porcelain -- "$VENDOR_PAYLOAD_REL" 2>/dev/null)" ]; then
  ok "the payload tree is untouched in git status"
else
  bad "the payload tree has uncommitted changes after the run"
fi

echo
if [ "$fail" = 0 ]; then
  echo "gate passed: $members accepted members match the manifest in git and on disk, 4 pins hold, and the negatives still fail closed"
else
  echo "gate FAILED: the accepted payload's provenance does not hold" >&2
fi
exit "$fail"
