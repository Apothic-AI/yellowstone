#!/usr/bin/env bash
# unit-path-refs.sh — which systemd units point INTO a directory, and will they still start?
#
# Why this exists. On 2026-11-10 the operator ordered a jj checkout cleaned up and deleted.
# The delete was blocked, in part, by processes whose cwd was inside it — and among them was
# the operator's live ask-queue daemon, because `unblock.service` had
#   WorkingDirectory=/home/bitnom/Code/apothic-monorepo-workspace/tooling/unblock
# So retiring a directory silently disarmed a unit nobody had thought to inspect. The daemon
# was killed with the checkout, exited 0, and `Restart=on-failure` correctly declined to
# resurrect it. Four other units reference the same workspace and would have failed the same
# way the first time anyone started them after the delete.
#
# The rule this encodes: BEFORE deleting a directory, enumerate the units whose fragments
# reference it, and check that every referenced path still exists. A unit whose ExecStart or
# WorkingDirectory points into a deleted tree is not "inactive" — it is unstartable, and after
# a reboot it never comes back.
#
# Usage:
#   ./unit-path-refs.sh [PATTERN] [--unit-dir DIR]... [--no-system]
#
#   PATTERN       path prefix to look for (default: apothic-monorepo-workspace)
#   --unit-dir    scan this directory for unit fragments instead of the live ones (self-test)
#   --no-system   skip /etc/systemd/system
#
# Exit: 0 if every referenced path exists, 1 if any reference is DANGLING, 2 on usage error.
#
# A DANGLING line means: this unit cannot start until the fragment is repointed. It is the
# only check here that survives the machine rebooting, which is why it drives the exit code.

set -uo pipefail

PATTERN="${1:-apothic-monorepo-workspace}"
case "$PATTERN" in --*) PATTERN="apothic-monorepo-workspace";; esac

declare -a DIRS=()
SCAN_SYSTEM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --unit-dir) DIRS+=("$2"); shift 2 ;;
    --no-system) SCAN_SYSTEM=0; shift ;;
    *) shift ;;
  esac
done

if [ "${#DIRS[@]}" -eq 0 ]; then
  [ -d "$HOME/.config/systemd/user" ] && DIRS+=("$HOME/.config/systemd/user")
  [ -d "$HOME/.config/systemd/system" ] && DIRS+=("$HOME/.config/systemd/system")
  [ "$SCAN_SYSTEM" -eq 1 ] && [ -d /etc/systemd/system ] && DIRS+=("/etc/systemd/system")
fi

scope_of() { case "$1" in "$HOME"/*) echo user;; *) echo system;; esac; }

printf '%-40s %-6s %-12s %s\n' "UNIT" "SCOPE" "STATE" "REFERENCE"
printf '%.0s-' $(seq 1 100); echo

units=0; live=0; dangling=0

for dir in "${DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r frag; do
    [ -n "$frag" ] || continue
    hits=$(grep -nE "^[[:space:]]*(ExecStart|ExecStartPre|ExecStartPost|WorkingDirectory|Environment|EnvironmentFile|ExecReload)=.*${PATTERN}" "$frag" 2>/dev/null)
    [ -n "$hits" ] || continue
    units=$((units + 1))
    name=$(basename "$frag")
    scope=$(scope_of "$frag")
    # live state is only meaningful for units systemd actually knows about
    state=$(systemctl --user is-active "$name" 2>/dev/null | head -1)
    [ -n "$state" ] || state=unknown
    [ "$state" = "active" ] && live=$((live + 1))
    while IFS= read -r line; do
      # extract the first absolute path that contains the pattern
      p=$(printf '%s' "$line" | grep -oE "/[^[:space:]\"']*${PATTERN}[^[:space:]\"']*" | head -1)
      # Only a path the unit must READ from has to exist. Environment= may name an output
      # directory (CARGO_TARGET_DIR) that the service creates on start, so flagging it would
      # be a false accusation — the same error this fleet keeps paying for.
      checkable=1
      case "$line" in Environment=*) checkable=0 ;; esac
      marker=""
      if [ "$checkable" -eq 1 ] && [ -n "$p" ] && [ ! -e "$p" ]; then
        marker="  <-- DANGLING"; dangling=$((dangling + 1))
      fi
      printf '%-40s %-6s %-12s %s%s\n' "$name" "$scope" "$state" "$p${marker:+ }${marker}"
    done <<< "$hits"
  done < <(find "${dir}" -maxdepth 2 -type f \( -name '*.service' -o -name '*.timer' -o -name '*.socket' -o -name '*.path' \) 2>/dev/null)
done

echo
echo "units=${units} live=${live} dangling=${dangling}  pattern='${PATTERN}'"
if [ "$dangling" -gt 0 ]; then
  echo "REFUSED TO CALL THIS CLEAN: ${dangling} reference(s) point into a path that does not exist."
  echo "Repoint those fragments before the directory is deleted, or they never start again."
  exit 1
fi
exit 0
