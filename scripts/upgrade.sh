#!/usr/bin/env bash
# upgrade.sh — bring every Yellowstone component up to date.
#
#   ./scripts/upgrade.sh              upgrade everything, interactive
#   ./scripts/upgrade.sh --yes        no prompts
#   ./scripts/upgrade.sh --dry-run    print the plan only
#   ./scripts/upgrade.sh herdr pi plugins skills
#                                     upgrade only the named components
#
# Order matters and is deliberate:
#   1. herdr binary  — plugins declare min_herdr_version, so the host comes first
#   2. herdr server  — a restarted server picks up the new binary
#   3. plugins       — re-fetched at the refs pinned in herdr/plugins.toml
#   4. pi            — the agent itself
#   5. pi packages   — third-party and forked extensions
#   6. skills        — our own symlinked skills need no update; this reports them
#
# Everything here is a command you could type yourself; the script exists so the
# order and the failure handling are not re-derived each time.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

COMPONENTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    herdr|pi|plugins|skills|all) COMPONENTS+=("$1") ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done
[ ${#COMPONENTS[@]} -eq 0 ] && COMPONENTS=(all)

want_comp() {
  local c
  for c in "${COMPONENTS[@]}"; do
    [ "$c" = "all" ] && return 0
    [ "$c" = "$1" ] && return 0
  done
  return 1
}

did_anything=0

# ------------------------------------------------------------------- herdr --
upgrade_herdr() {
  step "Herdr binary"
  if ! have herdr; then warn "herdr not installed — skipping"; return 0; fi

  local cur channel
  cur="$(herdr --version 2>/dev/null | awk '{print $2}')"
  channel="$(herdr channel show 2>/dev/null || echo unknown)"
  info "installed: $cur (channel $channel)"

  if [ "${DRY_RUN:-0}" = 1 ]; then dryrun "herdr update --handoff"; return 0; fi

  # `herdr update` is the only supported path for a direct install; brew/mise/nix
  # installs refuse it and tell you the package manager to use instead.
  #
  # `herdr update` installs the binary and leaves the running server (and its
  # pane processes) alone; client-side changes apply immediately. --handoff
  # additionally transfers live agent status to a restarted server, which is
  # what makes it safe to move the server forward without losing session state.
  local out status
  out="$(herdr update --handoff 2>&1)"; status=$?
  printf '%s\n' "$out" | sed 's/^/    /'
  if [ $status -ne 0 ]; then
    warn "herdr update failed — if herdr came from brew/mise/nix, update it there"
    return 1
  fi

  local new; new="$(herdr --version 2>/dev/null | awk '{print $2}')"
  if [ "$new" != "$cur" ]; then
    did_anything=1
    info "herdr $cur -> $new"
  else
    info "herdr binary already current"
  fi

  # A running server keeps the old binary in memory. A new *client* is fine, but
  # server-side features stay unavailable until the server runs the new build.
  if herdr status 2>/dev/null | grep -qE 'server_binary_stale: yes|restart_needed: yes'; then
    warn "the running herdr server is still on the old binary"
    info "  let herdr restart it during handoff, or later with: herdr server stop"
    info "  (server stop also ends the panes it owns — agents running there die)"
  fi
}

# ----------------------------------------------------------------- plugins --
upgrade_plugins() {
  step "Herdr plugins"
  if ! have herdr; then warn "herdr not installed — skipping"; return 0; fi
  if ! "$REPO_ROOT/scripts/herdr-plugins.sh" status >/dev/null 2>&1; then
    info "installing missing plugins first"
    "$REPO_ROOT/scripts/herdr-plugins.sh" install || warn "some plugins still missing"
  fi
  DRY_RUN="${DRY_RUN:-0}" "$REPO_ROOT/scripts/herdr-plugins.sh" update
  did_anything=1
}

# ---------------------------------------------------------------------- pi --
upgrade_pi() {
  step "Pi"
  if ! have pi; then warn "pi not installed — skipping"; return 0; fi
  local cur; cur="$(version_of pi)"
  info "installed: $cur"
  if [ "${DRY_RUN:-0}" = 1 ]; then
    dryrun "pi update --all"
    dryrun "node scripts/pi-patches.js"
    return 0
  fi

  # --all is (pi itself, then every installed package). Output is verbose and
  # npm-audit-noisy, so keep only the lines that report an outcome.
  local out status
  out="$(pi update --all --no-approve 2>&1)"; status=$?
  printf '%s\n' "$out" | grep -viE 'npm (audit|fund)|^$|up to date, audited|packages are looking' | sed 's/^/    /' || true
  if [ $status -ne 0 ]; then
    warn "pi update reported a failure; run 'pi update --all' by hand to see the full log"
    return 1
  fi
  local new; new="$(version_of pi)"
  [ "$new" != "$cur" ] && { did_anything=1; info "pi $cur -> $new"; } || info "pi already current"

  # An npm-installed package is owned by npm: `pi update` replaces the files, so
  # a patch applied once is gone after any package release. Re-apply ours here,
  # where the thing that removes them already runs. See docs/forks.md.
  step "Pi local patches"
  if ! node "$REPO_ROOT/scripts/pi-patches.js"; then
    warn "a local patch no longer applies — check whether upstream fixed the cause"
    did_anything=1
  fi
}

# ------------------------------------------------------------------ skills --
upgrade_skills() {
  step "Agent skills"
  # Our skills are symlinked into ~/.agents/skills from this repo, so updating
  # them is `git pull` here, not a copy. Report drift instead of silently
  # rewriting an operator's own copy: they may have edited it, or it may be a
  # checkout of another project.
  local skill src dest
  for skill in herdr yellowstone hotshot dagr-producer unblock; do
    src="$REPO_ROOT/skills/$skill"
    [ -d "$src" ] || src="$REPO_ROOT/herdr/skills/$skill"
    [ -d "$src" ] || src="$REPO_ROOT/yellowstone-skill"
    [ -d "$src" ] || continue
    dest="$AGENTS_SKILLS/$skill"
    if [ ! -e "$dest" ]; then
      warn "$skill: not installed — run ./install.sh skills"
    elif [ -L "$dest" ]; then
      if [ "$(readlink -f -- "$dest")" = "$(readlink -f -- "$src")" ]; then
        info "$skill: linked to this repo (updates with git pull)"
      else
        info "$skill: linked to $(short "$(readlink -f -- "$dest")") — not managed here"
      fi
    elif diff -rq -- "$src" "$dest" >/dev/null 2>&1; then
      info "$skill: a copy identical to this repo — ./install.sh skills will link it"
    else
      warn "$skill: a real directory that differs from this repo — left untouched"
      info "  compare: diff -r $(short "$src") $(short "$dest")"
    fi
  done
}

# --------------------------------------------------------- third-party forks --
# The parts of this stack that are our own forks rather than upstream releases.
# Each one has an upstream and a different update mechanism, so they get their
# own report instead of a blanket `pi update`.
report_forks() {
  step "Forks and pinned components"

  # pi-cache-optimizer: installed from git, so pi reconciles it; the fork's own
  # upstream is jiangge/pi-cache-optimizer.
  # `pi list` prints the resolved path of each package on the indented line
  # under its source line.
  local pco
  pco="$(pi list 2>/dev/null | grep -A1 -F -- 'pi-cache-optimizer' | grep -m1 -E '^    /' | sed 's/^    //')"
  if [ -n "$pco" ] && [ -d "$pco/.git" ]; then
    local branch head
    branch="$(git -C "$pco" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    head="$(git -C "$pco" log --oneline -1 2>/dev/null)"
    info "pi-cache-optimizer @ $branch: $head"
    if [ -n "$(git -C "$pco" status --porcelain 2>/dev/null)" ]; then
      info "  working tree has local changes; 'pi update' will not touch them"
    fi
  else
    info "pi-cache-optimizer: not installed"
  fi

  # bizzy: git source, upstream patty-io/pi-patty-bg-tasks
  local bizzy="$PI_DIR/git/github.com/Apothic-AI/bizzy"
  if [ -d "$bizzy/.git" ]; then
    info "bizzy @ $(git -C "$bizzy" log --oneline -1 2>/dev/null)"
  else
    info "bizzy: not installed"
  fi

  # pi-pretty-tui: a fork installed as a git package, so `pi update` moves it.
  local ptui="$PI_DIR/git/github.com/Apothic-AI/pi-pretty-tui"
  if [ -d "$ptui/.git" ]; then
    info "pi-pretty-tui @ $(git -C "$ptui" log --oneline -1 2>/dev/null)"
  else
    info "pi-pretty-tui: not installed (git:github.com/Apothic-AI/pi-pretty-tui)"
  fi

  # unblock: local checkout linked into herdr; the CLI is npm-linked from it.
  local unblock_path
  unblock_path="$(node "$REPO_ROOT/scripts/plugins-manifest.js" get "$REPO_ROOT/herdr/plugins.toml" unblock link_path)"
  unblock_path="${unblock_path/#\~/$HOME}"
  if [ -d "$unblock_path/.git" ]; then
    local ub
    ub="$(git -C "$unblock_path" log --oneline -1 2>/dev/null)"
    info "unblock @ $(short "$unblock_path"): $ub"
  fi
}

# ------------------------------------------------------------------ report --
want_comp herdr   && upgrade_herdr
want_comp plugins && upgrade_plugins
want_comp pi      && upgrade_pi
want_comp skills  && upgrade_skills
report_forks

step "Post-upgrade check"
if [ "${DRY_RUN:-0}" = 1 ]; then
  dryrun "scripts/doctor.sh"
else
  "$REPO_ROOT/scripts/doctor.sh" || warn "doctor reports open issues (see above)"
fi
