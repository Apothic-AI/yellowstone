#!/usr/bin/env bash
# verify-extensions-git-mode.sh — the production half of FT-01 Objective 2.
#
# Objective 2 says a fresh install must mirror this machine's pi extensions. On a
# development machine `install.sh` satisfies it in local mode — `pi install
# <repo>/src/pi-extensions/<c>` — and `verify-monorepo-install.sh` checks that every
# package resolves inside the checkout.
#
# A fresh machine has no checkout to point at. It runs `PI_EXTENSIONS_FROM=git`, where
# each component installs as `git:Apothic-AI/<repo>@<sha>` and the sha comes from the
# component's own `.gitrepo`. That is the mode this repository exists to serve, and
# until now **nothing exercised it**: `PI_EXTENSIONS_FROM` appeared only in install.sh,
# in no test and no gate. Local mode was verified; production mode was implemented and
# therefore assumed. The distinction matters because the failures are silent:
#
#   - a malformed spec is a bad `pi install` argument, discovered on a new machine
#     with no working fleet to diagnose it from;
#   - a sha the remote does not advertise is an install that fails after the network
#     round trip, or worse, resolves nothing and leaves the component absent;
#   - a component missing from install.sh's hardcoded loop installs on this machine
#     (local mode resolves by directory) and is silently never installed in production.
#     That last one is the closed-list defect: the loop is a list, the tree is a
#     directory, and only one of them notices a tenth component.
#
# So this gate reads the component list **out of install.sh** rather than restating it,
# compares it against the tree, then asks install.sh itself — via --dry-run — what spec
# it would hand to `pi install`, and finally asks each remote whether the pinned sha is
# advertised. It never writes to the host.
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/lib.sh
source "$REPO_ROOT/scripts/lib.sh"

fail=0
note() { printf '       %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*"; fail=1; }
good() { printf '       ok   %s\n' "$*"; }

echo "  == the component list install.sh iterates =="
# Read the loop that install_extensions() actually runs. Anchoring on `for c in` and
# stopping at `; do` keeps this honest: if the loop is rewritten, this gate breaks
# loudly instead of comparing against a list nobody uses any more.
# The awk join also pulls in the shell's line-continuation backslashes; strip them, or
# they parse as a component named \ and fail the comparison for the wrong reason.
listed="$(awk '/for c in/{f=1} f{printf "%s", $0} f&&/; do/{exit}' "$REPO_ROOT/install.sh" \
  | sed 's/.*for c in//; s/; do.*//' \
  | tr -d '\\' \
  | tr -s ' \t' '\n' | grep -v '^$' | sort -u)"

if [ -z "$listed" ]; then
  bad "could not read the component loop out of install.sh — this gate would be vacuous"
fi

present="$(find "$REPO_ROOT/src/pi-extensions" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -u)"

# One component is deliberately NOT in the install loop, and the gate must know that by
# name rather than by assuming the tree and the loop are the same set. install.sh says
# why: pi-profile-switch creates the instance dir and spawns pi, so it cannot be a
# package and is installed by install_launcher() instead. The exception is verified
# below against install_launcher, so it cannot rot into a silent gap: if the launcher
# ever stops being handled there, this gate fails instead of excusing it.
NOT_A_PACKAGE="pi-profile-switch"
if ! sed -n '/^install_launcher()/,/^}/p' "$REPO_ROOT/install.sh" | grep -q 'pi-profile-switch'; then
  bad "$NOT_A_PACKAGE is excluded from the install loop but install_launcher() does not install it — the exception is a gap"
fi

if [ -n "$listed" ] && [ -n "$present" ]; then
  only_tree="$(comm -13 <(printf '%s\n' "$listed") <(printf '%s\n' "$present") | grep -vx "$NOT_A_PACKAGE" || true)"
  only_list="$(comm -23 <(printf '%s\n' "$listed") <(printf '%s\n' "$present"))"
  if [ -n "$only_tree" ]; then
    bad "in src/pi-extensions/ but absent from install.sh's loop — never installed in production: $(echo "$only_tree" | tr '\n' ' ')"
  fi
  if [ -n "$only_list" ]; then
    bad "in install.sh's loop but absent from src/pi-extensions/ — skipped at install time: $(echo "$only_list" | tr '\n' ' ')"
  fi
  if [ -z "$only_tree" ] && [ -z "$only_list" ]; then
    good "$(printf '%s\n' "$listed" | wc -l) component(s) — the loop and the tree agree"
  fi
fi

echo
echo "  == the spec install.sh would hand to pi install (production mode) =="
out="$(cd "$REPO_ROOT" && PI_EXTENSIONS_FROM=git PI_LAUNCHER_SKIP_GLOBAL=1 \
  ./install.sh --dry-run extensions 2>&1)"
specs="$(printf '%s\n' "$out" | sed -n 's/.*pi install \(git:[^ ]*\).*/\1/p' | sort -u)"

if [ -z "$specs" ]; then
  bad "production mode produced no git: specs — install.sh dry-run said:"
  printf '%s\n' "$out" | tail -5 | sed 's/^/       /'
fi

count=$(printf '%s\n' "$specs" | grep -c . || true)
# The launcher is installed by install_launcher(), not as a package, so the right
# denominator is the loop minus that one deliberate exception.
expected=$(printf '%s\n' "$listed" | grep -vx "$NOT_A_PACKAGE" | grep -c . || true)
if [ "$count" != "$expected" ]; then
  bad "production mode produced $count spec(s) for $expected listed component(s)"
fi

# Every spec must be a full, fetchable form. A short or abbreviated sha is the
# difference between "installs the commit this tree pins" and "installs whatever the
# remote's default branch is today", which is why the 40-hex check is not cosmetic.
bad_spec=0
while read -r s; do
  [ -n "$s" ] || continue
  if [[ ! "$s" =~ ^git:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}$ ]]; then
    bad "malformed spec: $s  (want git:<owner>/<repo>@<40-hex sha>)"
    bad_spec=1
  fi
done <<< "$specs"
[ "$bad_spec" = 0 ] && [ -n "$specs" ] && good "all $count spec(s) are git:<owner>/<repo>@<40-hex>"

dup=$(printf '%s\n' "$specs" | sed 's/@.*//' | sort | uniq -d)
if [ -n "$dup" ]; then
  bad "two components resolve to the same repository — one of them never installs: $(echo "$dup" | tr '\n' ' ')"
fi

echo
echo "  == does each remote advertise the sha the spec pins? =="
# This is the only check that needs the network, and the distinction it draws matters:
# a remote we cannot reach is NOT a remote missing the commit. Conflating them turns an
# outage into a false accusation against the repo, or worse, a green gate on nothing.
checked=0
unreachable=0
while read -r s; do
  [ -n "$s" ] || continue
  slug="${s#git:}"; slug="${slug%@*}"
  sha="${s##*@}"
  remote="https://github.com/${slug}"
  heads="$(git ls-remote "$remote" 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$heads" ]; then
    bad "$slug: cannot read $remote — sha $sha is UNVERIFIED, not missing"
    unreachable=$((unreachable + 1))
    continue
  fi
  if printf '%s\n' "$heads" | grep -q "^${sha}[[:space:]]"; then
    good "$slug @ ${sha:0:9} is advertised by the remote"
    checked=$((checked + 1))
  else
    bad "$slug: sha ${sha:0:9} is NOT advertised by $remote — production install would resolve nothing"
  fi
done <<< "$specs"

echo
if [ "$fail" = 0 ]; then
  echo "  gate passed: production mode resolves $checked/$count component(s) to a pinned, advertised git: spec, and the loop matches the tree"
else
  echo "  gate FAILED"
  [ "$unreachable" -gt 0 ] && echo "       ($unreachable remote(s) unreachable — those shas are unverified, not wrong)"
fi
exit "$fail"
