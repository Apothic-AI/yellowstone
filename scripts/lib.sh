#!/usr/bin/env bash
# lib.sh — shared helpers for the Yellowstone installer.
#
# Sourced, never executed. Everything here is safe to call twice: Yellowstone
# installs over a working setup without destroying it, and every file it
# touches is backed up first.

set -euo pipefail

# ------------------------------------------------------------------ logging --
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_BOLD=''
fi

log()   { printf '%s\n' "$*"; }
step()  { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info()  { printf '    %s\n' "$*"; }
warn()  { printf '%swarn:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()   { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()   { err "$*"; exit 1; }
dryrun() { printf '%s  would:%s %s\n' "$C_DIM" "$C_RESET" "$*"; }

# ------------------------------------------------------------------- layout --
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HERDR_DIR="${HERDR_CONFIG_DIR:-$HOME/.config/herdr}"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
LOCAL_BIN="${LOCAL_BIN_DIR:-$HOME/.local/bin}"

DRY_RUN=0
ASSUME_YES=0
INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0

# Where backups of skill directories go. It is deliberately NOT beside the
# original: pi and other Agent Skills hosts discover skills recursively, so a
# `dagr-producer.bak-...` directory sitting next to `dagr-producer` loads as a
# second skill with the same name and produces a collision warning.
BACKUP_HOME="${YELLOWSTONE_BACKUP_DIR:-$HOME/.local/state/yellowstone/backups}"

backup_path() {
  # backup_path <path> [tag] — copy an existing file/dir aside, return its path.
  local p="$1" tag="${2:-yellowstone}" stamp dest
  [ -e "$p" ] || return 0
  stamp="$(date +%Y%m%dT%H%M%S)"
  case "$p" in
    "$AGENTS_SKILLS"/*|"$PI_DIR"/skills/*)
      mkdir -p -- "$BACKUP_HOME"
      dest="$BACKUP_HOME/$(basename -- "$p").bak-${tag}-${stamp}"
      ;;
    *)
      dest="${p}.bak-${tag}-${stamp}"
      ;;
  esac
  [ -e "$dest" ] && return 0
  cp -a -- "$p" "$dest"
  info "backed up $(short "$p") -> $(short "$dest")"
}

short() { printf '%s' "${1/#$HOME/~}"; }

have() { command -v -- "$1" >/dev/null 2>&1; }

# Is a herdr *server* reachable, not just the client binary?
#
# `herdr` installs its client regardless of whether a server is running, and
# every workspace/tab/pane call then exits 1 with a server_not_running error on
# stderr. A script that only checks `have herdr` proceeds, gets empty output, and
# prints a heading followed by nothing — a silent no-op that reads like success.
needs_herdr_server() {
  have herdr || return 1
  herdr workspace list >/dev/null 2>&1
}

version_of() { "$1" --version 2>/dev/null | head -n1 || true; }

require() {
  have "$1" || die "required command not found: $1${2:+ ($2)}"
}

# install_file <src> <dest> — copy with backup, preserving mode; no-op when equal.
install_file() {
  local src="$1" dest="$2" mode="${3:-}"
  if [ -f "$dest" ] && cmp -s -- "$src" "$dest"; then
    info "unchanged $(short "$dest")"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then dryrun "install $(short "$src") -> $(short "$dest")"; return 0; fi
  mkdir -p -- "$(dirname -- "$dest")"
  backup_path "$dest"
  cp -- "$src" "$dest"
  [ -n "$mode" ] && chmod "$mode" "$dest"
  info "installed $(short "$dest")"
}

# link_dir <src-dir> <dest-link> — symlink a skill directory into place.
#
# Replacing somebody's own real directory is destructive enough to ask about:
# they may have edited that copy, or it may be a checkout of another project.
# The default answer is yes (the repo is the source of truth), but the backup
# is taken first and its location is printed.
link_dir() {
  local src="$1" dest="$2"
  if [ -L "$dest" ] && [ "$(readlink -f -- "$dest")" = "$(readlink -f -- "$src")" ]; then
    info "unchanged $(short "$dest") -> $(short "$src")"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then dryrun "link $(short "$dest") -> $(short "$src")"; return 0; fi
  mkdir -p -- "$(dirname -- "$dest")"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    warn "$(short "$dest") is a real directory, not a symlink"
    info "  it will be moved aside (not deleted) and replaced with a link to $(short "$src")"
    if ! confirm "Replace it?"; then
      info "kept $(short "$dest") — no change"
      return 0
    fi
    backup_path "$dest"
    rm -rf -- "$dest"
  fi
  ln -sfn -- "$src" "$dest"
  info "linked $(short "$dest") -> $(short "$src")"
}

confirm() {
  # confirm <question> — yes by default when non-interactive & --yes.
  local q="$1"
  if [ "$ASSUME_YES" = 1 ] || [ "$INTERACTIVE" = 0 ]; then return 0; fi
  local reply
  printf '%s [Y/n] ' "$q"
  read -r reply || true
  case "${reply:-y}" in [nN]*) return 1 ;; *) return 0 ;; esac
}

# --------------------------------------------------------------- json utils --
# node is a hard prerequisite (pi itself runs on it), so JSON work is delegated
# to scripts/json-edit.js instead of shell string surgery.
json_edit() { node "$REPO_ROOT/scripts/json-edit.js" "$@"; }

node_required_message() {
  cat <<'EOF'
Node.js 22.19 or newer is required. Install it with your package manager,
mise (`mise use -g node@22`), or nvm, then re-run this script.
EOF
}
