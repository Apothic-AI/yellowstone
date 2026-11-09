#!/usr/bin/env bash
# verify-space-scaffold.sh — each fleet space's scaffolding is mirrored in home/ and still matches
# the machine it was copied from.
#
# Scope is deliberately the scaffolding only: AGENTS.md, .pi/launch.env, .pi/pi-persist.json and
# .pi/modes/*.json. Those are config, and they are what a fresh clone must reproduce. The spaces
# also hold state — continuations, notes, captures, outbound logs, operator documents — which is
# never mirrored and is not this gate's business.
#
# This is not a "which file is newer" check. When a space's mirror copy disagrees with the live one,
# one of the two is wrong and only a person can say which: a copy in either direction destroys
# content, and the disagreement is the finding. So a difference FAILS here, and a difference that
# has been decided and recorded goes in test/space-scaffold.divergences with its reason.
#
# The yellowstone space is not listed: its scaffolding is this repository's own root, so mapping it
# into home/ would be a copy of the tree inside itself.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_HOME="${SPACE_SCAFFOLD_HOME:-$HOME}"
DIV="$ROOT/test/space-scaffold.divergences"

# name:path-relative-to-$HOME
SPACES=(
  "assistant:Documents/Assistant"
  "comms:Documents/Comms"
  "overlord:.overlord"
  "self-improvement:Documents/Fleet"
  "sysops:.sysops"
  "personal:Documents/Personal"
)

is_declared() {  # $1 = path relative to home/, e.g. .overlord/AGENTS.md
  [ -f "$DIV" ] || return 1
  awk -v p="$1" '!/^#/ && NF && $1 == p { found = 1 } END { exit !found }' "$DIV"
}

scaffold_files() {  # $1 = directory; prints paths relative to it
  [ -d "$1" ] || return 0
  {
    for f in AGENTS.md .pi/launch.env .pi/pi-persist.json; do
      [ -f "$1/$f" ] && printf '%s\n' "$f"
    done
    for f in "$1"/.pi/modes/*.json; do
      [ -f "$f" ] && printf '.pi/modes/%s\n' "$(basename "$f")"
    done
  } | sort -u
}

rc=0
identical=0
differing=0
one_sided=0
unauthored=0
declared_ok=0

for entry in "${SPACES[@]}"; do
  name="${entry%%:*}"
  rel="${entry#*:}"
  mirror="$ROOT/home/$rel"
  live="$LIVE_HOME/$rel"

  m_files="$(scaffold_files "$mirror")"
  l_files="$(scaffold_files "$live")"

  if [ -z "$m_files" ] && [ -z "$l_files" ]; then
    printf '  none  %-16s no scaffolding authored on this machine yet\n' "$name"
    unauthored=$((unauthored + 1))
    continue
  fi
  if [ -z "$m_files" ]; then
    printf '  FAIL  %-16s live has scaffolding, the mirror has none\n' "$name"
    printf '%s\n' "$l_files" | sed 's/^/          live only: /'
    one_sided=$((one_sided + 1)); rc=1
    continue
  fi
  if [ -z "$l_files" ]; then
    printf '  FAIL  %-16s the mirror has scaffolding, live has none\n' "$name"
    printf '%s\n' "$m_files" | sed 's/^/          mirror only: /'
    one_sided=$((one_sided + 1)); rc=1
    continue
  fi

  space_ok=1
  for f in $(printf '%s\n%s\n' "$m_files" "$l_files" | sort -u); do
    key="$rel/$f"
    if [ ! -f "$mirror/$f" ]; then
      printf '  FAIL  %-16s live only: %s\n' "$name" "$f"
      space_ok=0; one_sided=$((one_sided + 1)); rc=1
    elif [ ! -f "$live/$f" ]; then
      printf '  FAIL  %-16s mirror only: %s\n' "$name" "$f"
      space_ok=0; one_sided=$((one_sided + 1)); rc=1
    elif cmp -s "$mirror/$f" "$live/$f"; then
      identical=$((identical + 1))
    elif is_declared "$key"; then
      printf '  decl  %-16s %s differs — declared: %s\n' "$name" "$f" \
        "$(awk -v p="$key" '$1 == p { $1 = ""; sub(/^ +/, ""); print; exit }' "$DIV")"
      space_ok=0; declared_ok=$((declared_ok + 1))
    else
      printf '  FAIL  %-16s %s differs (%s lines live, %s in mirror)\n' "$name" "$f" \
        "$(wc -l < "$live/$f")" "$(wc -l < "$mirror/$f")"
      space_ok=0; differing=$((differing + 1)); rc=1
    fi
  done
  [ "$space_ok" = 1 ] && printf '  ok    %-16s %s file(s) match live\n' "$name" \
    "$(printf '%s\n' "$m_files" | grep -c .)"
done

echo
if [ "$rc" = 0 ]; then
  echo "gate passed: $identical scaffold file(s) match live · $declared_ok declared divergence(s)" \
       "· $unauthored space(s) not yet authored"
else
  echo "gate FAILED: $differing differing · $one_sided one-sided — a copy in either direction destroys" \
       "content, so decide each one and record it in test/space-scaffold.divergences"
fi
exit "$rc"
