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

# Everything the installer puts in $HOME is mirrored in home/, one for one: a
# file's path under home/ *is* its path under $HOME. The five documented roots
# keep their environment overrides — that is how a test harness installs
# somewhere harmless — but the path below a root is never remapped, so the
# destination of a new file is derived rather than decided.
HOME_SRC="$REPO_ROOT/home"
HERDR_DIR="${HERDR_CONFIG_DIR:-$HOME/.config/herdr}"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
LOCAL_BIN="${LOCAL_BIN_DIR:-$HOME/.local/bin}"
OVERLORD_DIR="${OVERLORD_DIR:-$HOME/.overlord}"
SYSOPS_DIR="${SYSOPS_DIR:-$HOME/.sysops}"

# The fleet instruction core, shipped to $HOME/AGENTS.md. Deliberately NOT this
# repository's own AGENTS.md: that file is instructions for working *here*, and
# serving one file in both roles is how it became a copy of the global core and
# then silently stopped matching it. The install destination is the same; the
# source is not.
FLEET_AGENTS="$HOME_SRC/AGENTS.md"

# Where the pi-goal fork lives. It must be a checkout because the fork is a
# package inside a Bun workspace with no Pi manifest at its root, so `pi` cannot
# load it as a git package. Overridable for a different checkout location.
PI_EXTENSIONS_APOTHIC="${PI_EXTENSIONS_APOTHIC:-$HOME/Code/pi-extensions-apothic}"

# The keys in home/.pi/agent/settings.json this repository owns. Everything else
# in a user's file is theirs, and a merge never changes a value that is already
# set — the model they picked survives a reinstall.
SETTINGS_OWNED_KEYS=(defaultTools theme terminal steeringMode transport retry
  collapseChangelog enableInstallTelemetry defaultProjectTrust enableSkillCommands
  autocompleteMaxVisible defaultThinkingLevel)

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

# Render a path relative to $HOME for display. The replacement is escaped: bash
# tilde-expands an unescaped `~` inside ${var/…/~}, which expanded straight back
# to $HOME and made this function silently return its argument unchanged — every
# "installed ~/…" line in this repo's output was printing the absolute path.
short() { printf '%s' "${1/#$HOME/\~}"; }

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

# ------------------------------------------------------------ home/ mirror --

# home_dest <path relative to home/> — the absolute destination, or failure.
#
# A destination is derived from a path, never declared beside it: there is no
# second table to keep in step, which is the point of the layout. `AGENTS.md`
# lands at $HOME/AGENTS.md; any other file keeps its path below one of the
# roots above, under that root's overridable destination.
home_dest() {
  local rel="${1#./}"
  case "$rel" in
    AGENTS.md)        printf '%s/AGENTS.md\n' "$HOME" ;;
    .config/herdr/*)  printf '%s/%s\n' "$HERDR_DIR"     "${rel#.config/herdr/}" ;;
    .pi/agent/*)      printf '%s/%s\n' "$PI_DIR"        "${rel#.pi/agent/}" ;;
    .agents/skills/*) printf '%s/%s\n' "$AGENTS_SKILLS" "${rel#.agents/skills/}" ;;
    .local/bin/*)     printf '%s/%s\n' "$LOCAL_BIN"     "${rel#.local/bin/}" ;;
    .overlord/*)      printf '%s/%s\n' "$OVERLORD_DIR"  "${rel#.overlord/}" ;;
    .sysops/*)        printf '%s/%s\n' "$SYSOPS_DIR"    "${rel#.sysops/}" ;;
    *) return 1 ;;
  esac
}

# Every destination the installer writes, as "<mirror root>|<destination>".
# Read in both directions: each file under home/ must map through home_dest, and
# each root here must carry content in home/ unless its contents are generated.
home_dest_roots() {
  printf '%s\n' \
    "AGENTS.md|$HOME/AGENTS.md" \
    ".config/herdr|$HERDR_DIR" \
    ".pi/agent|$PI_DIR" \
    ".agents/skills|$AGENTS_SKILLS" \
    ".local/bin|$LOCAL_BIN" \
    ".overlord|$OVERLORD_DIR" \
    ".sysops|$SYSOPS_DIR"
}

# Destinations that exist on the machine and deliberately have no file under
# home/, because what lands there is generated, not shipped:
#
#   $PI_DIR/secrets  empty <provider> files for the operator to fill in. A mirror
#                    copy of a credential is the one thing that must never exist.
#   $SYSOPS_DIR      an empty working directory for the sysops space.
home_generated_dirs() {
  printf '%s\n' "$PI_DIR/secrets" "$SYSOPS_DIR"
}

# Every file under home/<subtree>, as a path relative to home/.
home_files() {
  local subtree="${1#./}"
  ( cd -- "$HOME_SRC" && find "$subtree" -type f 2>/dev/null | sed 's|^\./||' | LC_ALL=C sort )
}

# home_policy <path relative to home/> — how that file is installed.
#
# The default is a copy, so a file added to home/ is installed with no rule
# written for it — that is what makes a sixth file easy to add. The exceptions
# are all cases where overwriting would destroy something the file does not own:
#
#   merge-settings   union the keys and packages this repo owns into the user's
#   merge-models     add providers, never replace one the user already has
#   keep             install only when absent; the file holds personal state
#   template         install once, then report drift and never replace it
#   skill            linked by scripts/skills-sync.sh from skills/skills.tsv
#   copy-exec        a plain copy that must stay executable
home_policy() {
  local rel="${1#./}"
  case "$rel" in
    .pi/agent/settings.json)     printf 'merge-settings\n' ;;
    .pi/agent/models.json)       printf 'merge-models\n' ;;
    .pi/agent/pi-persist.json)   printf 'keep\n' ;;
    .pi/agent/model-picker.json) printf 'keep\n' ;;
    .pi/agent/web-search.json)   printf 'keep\n' ;;
    .overlord/AGENTS.md)         printf 'template\n' ;;
    .overlord/README.md)         printf 'keep\n' ;;
    # The fleet's own tooling: every script here is invoked directly, and four of
    # them had lost their exec bit in the live directory, so a plain copy would
    # have shipped files that only run when called through an interpreter.
    .overlord/tools/*)           printf 'copy-exec\n' ;;
    .overlord/bin/*)             printf 'copy-exec\n' ;;
    .agents/skills/*)            printf 'skill\n' ;;
    .local/bin/*)                printf 'copy-exec\n' ;;
    *)                           printf 'copy\n' ;;
  esac
}

# Why a `keep` file is kept, in the words the installer prints.
home_keep_reason() {
  case "${1#./}" in
    .pi/agent/pi-persist.json)   printf 'holds your own trailing reminders' ;;
    .pi/agent/model-picker.json) printf 'the MRU list is personal' ;;
    .pi/agent/web-search.json)   printf 'it names a browser profile' ;;
    .overlord/README.md)         printf 'it holds the live workspace index' ;;
    *)                           printf 'it holds state this repo does not own' ;;
  esac
}

# install_kept <src> <dest> <why> — install only when absent.
install_kept() {
  local src="$1" dest="$2" why="$3"
  if [ -e "$dest" ]; then info "kept $(short "$dest") ($why)"; return 0; fi
  install_file "$src" "$dest"
}

# install_template <src> <dest> — install once, then never replace.
#
# A live copy of a template accretes state that must not be lost: reservations
# keyed to tab ids, tool paths, per-lane history. Silent replacement would
# discard the operator's work, so drift is reported and left alone.
install_template() {
  local src="$1" dest="$2"
  if [ -e "$dest" ]; then
    if cmp -s -- "$src" "$dest"; then
      info "unchanged $(short "$dest")"
    else
      info "kept $(short "$dest") — it has local edits the template does not"
      info "  compare: diff $(short "$src") $(short "$dest")"
      info "  replace it deliberately with: cp $src $dest"
    fi
    return 0
  fi
  install_file "$src" "$dest"
}

# install_settings <src> <dest> — the settings.json policy.
#
# First install renders the template's package placeholders to the checkouts
# they name, because a copied `@PI_EXTENSIONS_APOTHIC@/packages/pi-goal` is a
# package entry pi cannot load — and the template's own keys (defaultProvider,
# $schema, ...) are what a fresh machine needs. After that it is a union: owned
# keys are filled in when absent, and packages are matched by identity so a
# second run is a no-op.
install_settings() {
  local src="$1" dest="$2"
  if [ "$DRY_RUN" = 1 ]; then
    if [ -e "$dest" ]; then
      dryrun "merge owned keys + package union into $(short "$dest")"
    else
      dryrun "install $(short "$dest") (package placeholders rendered)"
    fi
    return 0
  fi
  if [ ! -e "$dest" ]; then
    json_edit render-settings "$src" "$dest" "$REPO_ROOT" "$PI_EXTENSIONS_APOTHIC"
    info "installed $(short "$dest")"
    return 0
  fi
  json_edit ensure-keys "$dest" "$src" "${SETTINGS_OWNED_KEYS[@]}"
  json_edit merge-packages "$dest" "$src" "$REPO_ROOT" "$PI_EXTENSIONS_APOTHIC"
}

# install_home_tree <subtree of home/> — install every file under that path.
#
# This walk is the only thing a stage needs to know about home/: the destination
# comes from home_dest and the behaviour from home_policy, so a stage installs a
# subtree rather than a hand-maintained file list.
install_home_tree() {
  local subtree="${1#./}" rel dest policy
  [ -e "$HOME_SRC/$subtree" ] || die "home/$subtree: no such path in the mirror"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    if ! dest="$(home_dest "$rel")"; then
      die "home/$rel has no destination — add it to home_dest() in scripts/lib.sh"
    fi
    policy="$(home_policy "$rel")"
    case "$policy" in
      copy)           install_file "$HOME_SRC/$rel" "$dest" ;;
      copy-exec)      install_file "$HOME_SRC/$rel" "$dest" 755 ;;
      merge-settings) install_settings "$HOME_SRC/$rel" "$dest" ;;
      merge-models)
        if [ "$DRY_RUN" = 1 ]; then dryrun "merge providers into $(short "$dest")"
        else json_edit merge-models "$dest" "$HOME_SRC/$rel"; fi ;;
      keep)           install_kept "$HOME_SRC/$rel" "$dest" "$(home_keep_reason "$rel")" ;;
      template)       install_template "$HOME_SRC/$rel" "$dest" ;;
      # One membership test for every skill, whichever repository owns it, so a
      # mirror file is never installed by two mechanisms at once.
      skill)          info "$(short "$dest"): linked by the skills stage" ;;
      *)              die "home/$rel: unknown policy '$policy'" ;;
    esac
  done < <(home_files "$subtree")
}
