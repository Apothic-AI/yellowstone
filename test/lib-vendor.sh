#!/usr/bin/env bash
# lib-vendor.sh — ONE authority for "may this file inherit a lint exemption?"
#
# Sourced, never executed: test/run-tests.sh runs it in the container and
# test/verify-vendor-provenance.sh runs it on the host with git available. Two
# copies of this rule would drift, and the drift would always be in the direction
# of the exemption getting wider.
#
# Three things grant an exemption, and none of them is "the path starts with
# vendor/". A prefix rule is precisely the defect this replaces: the first version
# exempted a manifest MEMBER by name only, so appending a credential to an accepted
# file kept the exemption, and a blanket `patches/*` exempted a patch nobody had
# reviewed. Membership is now membership *and* bytes.
#
#   1. accepted payload member — the exact path is listed in the accepted manifest
#      AND the file's sha256 equals the hash that manifest records for it.
#   2. provenance record — one of exactly four pinned artifacts (the two sha256
#      manifests, the tested-bytes json and REBUILD.md), each matched by its own
#      sha256. These are the oracle; pinning them is what stops a rewritten manifest
#      from re-exempting a modified file.
#   3. the one recorded patch that must quote an accepted developer path, named
#      explicitly with its hash. A NEW file under patches/ inherits nothing.
#
# Vendored credential sentinels are exempted by exact TOKEN in test/run-tests.sh,
# not here: a path exemption on the credential side is how a real secret in an
# accepted file would go unnoticed, and that scan deliberately has none.

VENDOR_PAYLOAD_REL="vendor/pi-hermes-memory-0.10.0-ft20"
VENDOR_ACCEPTED_REL="$VENDOR_PAYLOAD_REL/ft20-provenance/ACCEPTED-13ce3cc6a.sha256"

# Exactly four. Each is a provenance artifact, so each is pinned here rather than
# trusted by location. Hashes were taken from the reviewed candidate and are
# asserted equal to the COMMITTED blob by test/verify-vendor-provenance.sh, which is
# what makes "reviewed" a git fact instead of a claim in a comment. Update a pin in
# the same change that changes the artifact, deliberately, in review.
VENDOR_ORACLE_PINS='vendor/pi-hermes-memory-0.10.0-ft20/BASE-MANIFEST.sha256 4b0c2ac3f97458a41305bc6494970e05d81d61f7be43bd4314c501dabba4680b
vendor/pi-hermes-memory-0.10.0-ft20/ft20-provenance/ACCEPTED-13ce3cc6a.sha256 7af9dde54f0aa3619bd8171cd5ad8bad7878155de611aa0b2f0019c3c5fb9cbd
vendor/pi-hermes-memory-0.10.0-ft20/ft20-provenance/ACCEPTED-13ce3cc6a-tested-bytes.json 0dd56092829baf42f41a2695c1fd1c71305ff1ff805f70e1798de8cc3d4cbffa
vendor/pi-hermes-memory-0.10.0-ft20/ft20-provenance/REBUILD.md 5fe440a569534d342cacbef2c13580914052ecef3bfdeabddbcda62369ac0c5f'

# Exactly one patch, by name and hash: it records the accepted line whose TSC_BIN
# default names a developer checkout. Exempting `patches/*` instead would exempt
# patch 0005 the day somebody adds one, unread.
VENDOR_PATCH_EXEMPT_PIN="vendor/pi-hermes-memory-0.10.0-ft20/ft20-provenance/patches/0001-fail-closed-parser-redacted-diagnostics.patch 89812d8078e61810da2997ecbcb508ee9d1c27c08085ba5612af40661154b7af"

vendor_sha256_file() {  # $1 = file
  [ -f "$1" ] || return 1
  sha256sum -- "$1" 2>/dev/null | cut -d' ' -f1
}

vendor_manifest_hash() {  # $1 = root, $2 = payload-relative path; prints recorded hash
  local manifest="$1/$VENDOR_ACCEPTED_REL"
  [ -f "$manifest" ] || return 1
  awk -v p="$2" '$2 == p { print $1; exit }' "$manifest"
}

vendor_pin_matches() {  # $1 = root, $2 = "path hash" line
  local root="$1" rel want got
  rel="${2% *}"; want="${2##* }"
  got="$(vendor_sha256_file "$root/$rel")" || return 1
  [ "$got" = "$want" ]
}

vendor_oracle_pin() {  # $1 = repo-relative path; prints its pinned hash, or nothing
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ "${line% *}" = "${1:-}" ] || continue
    printf '%s\n' "${line##* }"
    return 0
  done <<< "$VENDOR_ORACLE_PINS"
  return 1
}

is_accepted_vendor() {  # $1 = root, $2 = repo-relative path
  local root="$1" rel="$2" want got
  case "$rel" in "$VENDOR_PAYLOAD_REL"/*) ;; *) return 1 ;; esac
  want="$(vendor_manifest_hash "$root" "${rel#"$VENDOR_PAYLOAD_REL"/}")" || return 1
  [ -n "$want" ] || return 1          # not listed: not a member
  got="$(vendor_sha256_file "$root/$rel")" || return 1
  [ "$got" = "$want" ]                # listed AND byte-identical to the accepted hash
}

is_provenance_oracle() {  # $1 = root, $2 = repo-relative path
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ "${line% *}" = "${2:-}" ] || continue
    vendor_pin_matches "$1" "$line" && return 0
    return 1
  done <<< "$VENDOR_ORACLE_PINS"
  return 1
}

is_provenance_patch_exempt() {  # $1 = root, $2 = repo-relative path
  [ "${2:-}" = "${VENDOR_PATCH_EXEMPT_PIN% *}" ] || return 1
  vendor_pin_matches "$1" "$VENDOR_PATCH_EXEMPT_PIN"
}

vendor_exempt() {  # $1 = root, $2 = repo-relative path
  is_accepted_vendor "$1" "$2" && return 0
  is_provenance_oracle "$1" "$2" && return 0
  is_provenance_patch_exempt "$1" "$2" && return 0
  return 1
}
