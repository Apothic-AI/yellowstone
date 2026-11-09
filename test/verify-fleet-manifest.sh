#!/usr/bin/env bash
# verify-fleet-manifest.sh — the two manifests that decide what a new machine gets.
#
# FT-01 Objective 2 says a fresh install must mirror this machine's skills, herdr
# plugins and pi extensions; Objective 4 says components install by their local
# yellowstone path. Both are properties of a manifest, and both failed silently
# before this test existed:
#
#   herdr/plugins.toml  had `link_path = "~/Code/..."` for both of its local
#                       plugins, so the installed fleet linked out of a checkout
#                       that retirement is about to delete, and `git subrepo pull`
#                       could never be the update path for those components.
#
#   scripts/lib.sh      fleet_space_paths() had three labels lowercased that the
#                       operator created capitalised. `herdr workspace create`
#                       does not deduplicate, so a lookup that misses creates a
#                       SECOND space with a near-identical name and no diagnostic.
#
# Neither is visible at runtime: a missing space and a stale link both look like
# success. So check them statically, here.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/lib.sh
source "$REPO_ROOT/scripts/lib.sh"

fail=0 ok=0

# ---------------------------------------------------------------- plugins --
manifest="$REPO_ROOT/herdr/plugins.toml"
if [ ! -f "$manifest" ]; then
  echo "  FAIL  herdr/plugins.toml is missing"
  exit 1
fi

local_count=0
while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
  [ -n "$id" ] || continue
  [ "$source" = "local" ] || continue
  local_count=$((local_count + 1))

  case "$link_path" in
    src/*)
      if [ -d "$REPO_ROOT/$link_path" ]; then
        echo "  ok    $id links out of the repo: $link_path"
        ok=$((ok + 1))
      else
        echo "  FAIL  $id: link_path '$link_path' does not exist in the repo"
        fail=$((fail + 1))
      fi
      ;;
    "~"*|/*)
      echo "  FAIL  $id: link_path '$link_path' points outside the repo"
      echo "        FT-01 Objective 4 wants src/herdr-plugins/<component>, so that"
      echo "        'git subrepo pull' is the update path for this component."
      fail=$((fail + 1))
      ;;
    "")
      echo "  FAIL  $id: source is 'local' but there is no link_path"
      fail=$((fail + 1))
      ;;
    *)
      echo "  FAIL  $id: link_path '$link_path' is neither repo-relative nor absolute"
      fail=$((fail + 1))
      ;;
  esac
done < <(node "$REPO_ROOT/scripts/plugins-manifest.js" rows "$manifest")

if [ "$local_count" -eq 0 ]; then
  echo "  FAIL  no local plugins found in the manifest — this test would pass vacuously"
  fail=$((fail + 1))
fi

# ----------------------------------------------------------------- spaces --
expected=7
rows="$(fleet_space_paths | grep -c . || true)"
if [ "$rows" -eq "$expected" ]; then
  echo "  ok    fleet_space_paths lists $rows spaces"
  ok=$((ok + 1))
else
  echo "  FAIL  fleet_space_paths lists $rows spaces, expected $expected"
  fail=$((fail + 1))
fi

dupes="$(fleet_space_paths | cut -d'|' -f1 | sort | uniq -d)"
if [ -z "$dupes" ]; then
  echo "  ok    every space label is unique"
  ok=$((ok + 1))
else
  echo "  FAIL  duplicate space label(s): $dupes"
  fail=$((fail + 1))
fi

# A space's workspace label must match the operator's exactly, including case.
# Recorded here so a future edit that "tidies" the capitalisation fails loudly.
for want in Assistant Comms overlord self-improvement sysops yellowstone Personal; do
  if fleet_space_paths | cut -d'|' -f1 | grep -qx -- "$want"; then :; else
    echo "  FAIL  space label '$want' is missing from fleet_space_paths"
    fail=$((fail + 1))
  fi
done
echo "  ok    all seven operator labels are present verbatim"
ok=$((ok + 1))

echo
if [ "$fail" -ne 0 ]; then
  echo "gate FAILED: $fail problem(s) in the fleet manifests"
  exit 1
fi
echo "gate passed: $ok manifest fact(s) hold — plugins link from the repo, seven spaces, labels exact"
