#!/usr/bin/env bash
# scratch-guard.sh — canonical, fail-closed containment check for scratch roots.
#
# The portable gate *uses* paths (rm -rf, cp -a, builds, a scratch HOME), so a
# scratch root that resolves into the repository, into a live configuration
# directory, or through a symlink is not a wrong argument — it is a way to
# destroy the thing being verified. This guard is the enforceable boundary, and
# it fails closed on anything it cannot prove:
#
#   * the path must be absolute (a relative path resolves against a cwd nobody
#     validated);
#   * no component of the path may be a symlink, and the canonical realpath must
#     equal the lexical path (a symlinked ancestor is how a path that *looks*
#     outside the repo ends up inside it);
#   * the canonical path must not be, or be inside, the repository (resolved via
#     `git rev-parse --show-toplevel`, so a symlinked checkout counts), $HOME, or
#     any live configuration directory ($HOME/.pi, .config, .pi-profile-switch,
#     .agents, .local/state, .local/share, and PI_CODING_AGENT_DIR);
#   * it must be *fresh*: absent, or an existing empty directory. Stale scratch
#     contents are how a "clean" run silently reuses last run's tree;
#   * it must be specific: a bare `/`, `/tmp`, `/var/tmp` or `/dev/shm` is a
#     shared root, not a scratch directory.
#
# Usage (sourced):
#   . lib/scratch-guard.sh
#   root=$(ft20_require_scratch "$FT20_WORK" "$HERE") || exit 2
#
# Usage (standalone, prints the canonical root or refuses):
#   ./lib/scratch-guard.sh /var/tmp/ft20-run-1
#
# Refusals go to stderr as `REFUSED: …` and return 2. Nothing is created here.
set -uo pipefail

ft20_refuse() { printf 'REFUSED: %s\n' "$*" >&2; return 2; }

# ft20_require_scratch <requested-path> <directory-inside-this-repo>
ft20_require_scratch() {
  local req="${1:-}" repo_hint="${2:-}"
  [ -n "$req" ] || { ft20_refuse "empty scratch path"; return 2; }
  case "$req" in
    /*) : ;;
    *) ft20_refuse "scratch path must be absolute, got '$req'"; return 2 ;;
  esac

  # Every component, symlink-free. Checked before canonicalisation so the
  # refusal can name the exact link rather than a resolved path.
  local rest="${req#/}" cur="" comp
  local IFS=/
  for comp in $rest; do
    [ -n "$comp" ] || continue
    cur="$cur/$comp"
    if [ -L "$cur" ]; then
      ft20_refuse "symlink component in scratch path: $cur -> $(readlink -- "$cur")"
      return 2
    fi
  done
  unset IFS

  local canon
  canon=$(realpath -m -- "$req" 2>/dev/null) || { ft20_refuse "cannot canonicalise '$req'"; return 2; }

  # Last line of defence: if canonicalisation moved the path at all, some
  # component was a link even though the walk above did not see one.
  local lex
  lex=$(realpath -ms -- "$req" 2>/dev/null) || lex="$req"
  [ "$canon" = "$lex" ] || { ft20_refuse "scratch path canonicalises to $canon (from $req); refusing a path that moves"; return 2; }

  case "$canon" in
    /|/tmp|/var/tmp|/dev/shm|/home|/root)
      ft20_refuse "shared root is not a scratch directory: $canon"; return 2 ;;
  esac
  local depth
  depth=$(printf '%s' "${canon#/}" | awk -F/ '{print NF}')
  [ "$depth" -ge 2 ] || { ft20_refuse "scratch path too shallow: $canon"; return 2; }

  # The repository, resolved the way git resolves it.
  local repo=""
  if [ -n "$repo_hint" ]; then
    repo=$(git -C "$repo_hint" rev-parse --show-toplevel 2>/dev/null) || repo=""
  fi
  [ -n "$repo" ] || { ft20_refuse "cannot resolve the repository root from '${repo_hint:-<none>}' (fail closed)"; return 2; }
  repo=$(realpath -e -- "$repo" 2>/dev/null) || { ft20_refuse "cannot canonicalise repository root"; return 2; }
  [ "$canon" = "$repo" ] && { ft20_refuse "scratch path is the repository root: $canon"; return 2; }
  case "$canon/" in
    "$repo/"*) ft20_refuse "scratch path is inside the repository ($repo): $canon"; return 2 ;;
  esac

  # Live configuration directories. Resolved lexically when absent so a prefix
  # check still works on a machine that has not created one.
  local home label path
  home=$(realpath -m -- "${HOME:-/nonexistent}" 2>/dev/null || printf '%s' "${HOME:-/nonexistent}")
  local labels=( "HOME" "HOME/.pi" "HOME/.config" "HOME/.pi-profile-switch" "HOME/.agents" "HOME/.local/state" "HOME/.local/share" )
  local paths=( "$home" "$home/.pi" "$home/.config" "$home/.pi-profile-switch" "$home/.agents" "$home/.local/state" "$home/.local/share" )
  if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
    labels+=( "PI_CODING_AGENT_DIR" )
    paths+=( "$(realpath -m -- "$PI_CODING_AGENT_DIR" 2>/dev/null || printf '%s' "$PI_CODING_AGENT_DIR")" )
  fi
  local i
  for i in "${!paths[@]}"; do
    label="${labels[$i]}"; path="${paths[$i]}"
    [ -n "$path" ] || continue
    path=$(realpath -m -- "$path" 2>/dev/null || printf '%s' "$path")
    case "$path" in /) continue ;; esac
    [ "$canon" = "$path" ] && { ft20_refuse "scratch path is live ($label): $canon"; return 2; }
    case "$canon/" in
      "$path/"*) ft20_refuse "scratch path is inside live $label ($path): $canon"; return 2 ;;
    esac
  done

  # Fresh, or empty. Reusing a populated root is how a clean run inherits state.
  if [ -e "$canon" ]; then
    [ -d "$canon" ] || { ft20_refuse "scratch path exists and is not a directory: $canon"; return 2; }
    if [ -n "$(find "$canon" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      ft20_refuse "scratch directory is not fresh (already has contents): $canon"
      return 2
    fi
  fi

  printf '%s\n' "$canon"
  return 0
}

# ft20_forbid_receipt_override — receipts have exactly one destination.
#
# The p1E rejection was a receipt-destination bypass: FT20_WORK was validated,
# then FT20_RECEIPT_DIR was accepted verbatim and mkdir -p'd, so a valid scratch
# root still allowed writes into a forbidden HOME/.pi tree. The repair is to
# remove the surface: there is no receipt override, and asking for one is an
# error rather than something quietly redirected.
ft20_forbid_receipt_override() {
  if [ -n "${FT20_RECEIPT_DIR:-}" ]; then
    ft20_refuse "FT20_RECEIPT_DIR is not supported (${FT20_RECEIPT_DIR}); every output is written under the validated scratch root, in receipts/"
    return 2
  fi
  return 0
}

# ft20_require_output_dir <validated-root> <single-component-name>
#
# Creates <root>/<name> and prints its canonical path. Refuses a name that is
# absolute, contains a separator or a dot segment, a destination that is already
# a symlink, and any destination whose canonical path is not strictly inside the
# canonical root. Called after the root itself has been validated.
ft20_require_output_dir() {
  local root="${1:-}" name="${2:-}"
  [ -n "$root" ] && [ -n "$name" ] || { ft20_refuse "require_output_dir: missing root or name"; return 2; }
  case "$name" in
    */*|.|..|"") ft20_refuse "output directory name must be a single component, got '$name'"; return 2 ;;
  esac
  mkdir -p -- "$root" 2>/dev/null || { ft20_refuse "cannot create scratch root $root"; return 2; }
  local dir="$root/$name"
  mkdir -p -- "$dir" 2>/dev/null || { ft20_refuse "cannot create output directory $dir"; return 2; }
  [ -L "$dir" ] && { ft20_refuse "output directory is a symlink: $dir"; return 2; }
  local canon_root canon_dir
  canon_root=$(realpath -e -- "$root" 2>/dev/null) || { ft20_refuse "cannot canonicalise root $root"; return 2; }
  canon_dir=$(realpath -e -- "$dir" 2>/dev/null) || { ft20_refuse "cannot canonicalise output directory $dir"; return 2; }
  [ "$canon_dir" != "$canon_root" ] || { ft20_refuse "output directory is the scratch root itself"; return 2; }
  case "$canon_dir/" in
    "$canon_root/"*) : ;;
    *) ft20_refuse "output directory escapes the scratch root ($canon_dir not under $canon_root)"; return 2 ;;
  esac
  printf '%s\n' "$canon_dir"
  return 0
}

# Executed directly: behave as a checker.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root=$(ft20_require_scratch "${1:-}" "$here") || exit 2
  printf 'OK: %s\n' "$root"
fi
