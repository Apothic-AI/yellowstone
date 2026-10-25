#!/usr/bin/env bash
# install.sh — install the Yellowstone herdr + pi setup on this machine.
#
#   ./install.sh                 interactive, safe to re-run
#   ./install.sh --yes           no prompts (CI, provisioning)
#   ./install.sh --dry-run       print every change, touch nothing
#   ./install.sh herdr|pi|plugins|skills --yes
#                                 run only selected stages
#
# Every file it overwrites is backed up first with a .bak-yellowstone-<stamp>
# suffix. Nothing is deleted. Re-running after an upstream change reconciles.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/scripts/lib.sh"

STAGES=()

usage() {
  cat <<'EOF'
Usage: ./install.sh [--yes] [--dry-run] [--help] [stage...]

Stages (default: all, in this order):
  herdr      config.toml, plugins, pi integration, herdr skill, herdr-agy.sh
  pi         settings.json, models.json, extensions, packages
  skills     hotshot / dagr-producer / unblock / herdr agent skills
  secrets    create empty ~/.pi/agent/secrets/<provider> files to fill in
  verify     report what is installed, outdated, or missing

Options:
  -y, --yes      do not prompt
  -n, --dry-run  print planned changes without applying them
  -h, --help     this text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    herdr|pi|plugins|skills|secrets|verify) STAGES+=("$1") ;;
    *) err "unknown argument: $1"; usage; exit 2 ;;
  esac
  shift
done

if [ ${#STAGES[@]} -eq 0 ]; then
  STAGES=(herdr pi skills secrets verify)
fi

want() {
  local s
  for s in "${STAGES[@]}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}

# --------------------------------------------------------------- preflight --
step "Preflight"

if ! have node; then node_required_message; die "node not found"; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  node_required_message
  die "node $(node --version) is too old (need >= 22.19)"
fi
info "node $(node --version)"

for f in pi/settings.json pi/models.json herdr/config.toml herdr/plugins.toml scripts/json-edit.js; do
  [ -e "$REPO_ROOT/$f" ] || die "repository is incomplete: missing $f"
done
node "$REPO_ROOT/scripts/json-edit.js" validate \
  "$REPO_ROOT/pi/settings.json" "$REPO_ROOT/pi/models.json" >/dev/null
info "repository at $(short "$REPO_ROOT") is valid"

have herdr || warn "herdr not on PATH — the herdr stages will be skipped"
have pi    || warn "pi not on PATH — the pi stages will be skipped"
[ "$DRY_RUN" = 1 ] && warn "dry run: no files will be written"

# ------------------------------------------------------------------- herdr --
install_herdr() {
  have herdr || { warn "skipping herdr stage: herdr not installed"; return 0; }
  step "Herdr"

  info "herdr $(version_of herdr) (channel: $(herdr channel show 2>/dev/null || echo unknown))"

  # config.toml: ours is the whole file (theme, sidebar rows, keybinds), so it
  # replaces rather than merges. The backup is the escape hatch.
  mkdir -p -- "$HERDR_DIR"
  install_file "$REPO_ROOT/herdr/config.toml" "$HERDR_DIR/config.toml"
  if have herdr && [ "$DRY_RUN" = 0 ]; then
    if herdr config check >/dev/null 2>&1; then
      info "config.toml passes herdr config check"
    else
      warn "config.toml failed validation — run: herdr config check"
    fi
  fi

  # pi integration: lets herdr see this agent's live state in the sidebar.
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "herdr integration install pi"
  else
    herdr integration install pi >/dev/null 2>&1 \
      && info "herdr pi integration installed" \
      || warn "herdr integration install pi failed"
  fi

  # plugins.toml is declarative; apply it here.
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "herdr plugin install/update for every entry in herdr/plugins.toml"
  else
    "$REPO_ROOT/scripts/herdr-plugins.sh" install
  fi

  # The herdr skill teaches agents to drive panes. Herdr ships one; ours adds
  # the delegation and target-verification rules this setup depends on.
  link_dir "$REPO_ROOT/herdr/skills/herdr" "$AGENTS_SKILLS/herdr"

  # herdr-agy.sh: reliability wrapper for kind=agy/grok agents (herdr#3530).
  if [ -e "$REPO_ROOT/herdr/scripts/herdr-agy.sh" ]; then
    install_file "$REPO_ROOT/herdr/scripts/herdr-agy.sh" "$LOCAL_BIN/herdr-agy.sh" 755
  fi
}

# ---------------------------------------------------------------------- pi --
install_pi() {
  have pi || { warn "skipping pi stage: pi not installed"; return 0; }
  step "Pi"
  info "pi $(version_of pi) (agent dir: $(short "$PI_DIR"))"

  mkdir -p -- "$PI_DIR/extensions"

  # settings.json: merge only the keys Yellowstone owns, so a user's model
  # choice and packages survive.
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "merge packages + extension defaults into $(short "$PI_DIR/settings.json")"
  else
    if [ ! -e "$PI_DIR/settings.json" ]; then
      install_file "$REPO_ROOT/pi/settings.json" "$PI_DIR/settings.json"
    else
      json_edit ensure-keys "$PI_DIR/settings.json" "$REPO_ROOT/pi/settings.json" \
        defaultTools theme terminal steeringMode transport retry \
        collapseChangelog enableInstallTelemetry defaultProjectTrust \
        enableSkillCommands autocompleteMaxVisible defaultThinkingLevel
      json_edit merge-packages "$PI_DIR/settings.json" "$REPO_ROOT/pi/settings.json" "$REPO_ROOT"
    fi
  fi

  # models.json: providers Yellowstone knows how to route. Existing provider
  # blocks are never overwritten — that is where the user's keys and edits live.
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "merge providers into $(short "$PI_DIR/models.json")"
  else
    json_edit merge-models "$PI_DIR/models.json" "$REPO_ROOT/pi/models.json"
  fi

  # hand-written extensions (the herdr one is installed by herdr itself)
  install_file "$REPO_ROOT/pi/extensions/transient-error-retry.ts" \
               "$PI_DIR/extensions/transient-error-retry.ts"

  # cosmetic, non-functional state
  install_file "$REPO_ROOT/pi/pi-auto-compact.json" "$PI_DIR/pi-auto-compact.json"
  if [ ! -e "$PI_DIR/model-picker.json" ]; then
    install_file "$REPO_ROOT/pi/model-picker.json" "$PI_DIR/model-picker.json"
  else
    info "kept $(short "$PI_DIR/model-picker.json") (MRU state is personal)"
  fi
  if [ ! -e "$PI_DIR/web-search.json" ]; then
    install_file "$REPO_ROOT/pi/web-search.json" "$PI_DIR/web-search.json"
  else
    info "kept $(short "$PI_DIR/web-search.json")"
  fi

  # Now let pi install the packages the merged settings.json declares.
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "pi update --extensions"
  else
    info "installing packages declared in settings.json (this can take a minute)"
    if pi update --extensions --no-approve 2>&1 | sed 's/^/    /'; then
      info "packages reconciled"
    else
      warn "pi update --extensions reported a problem; run 'pi list' to inspect"
    fi
  fi
}

# ------------------------------------------------------------------ skills --
install_skills() {
  step "Agent skills"
  # `herdr` and `yellowstone` live in their own top-level dirs; the rest are in
  # skills/. Link both kinds so `~/.agents/skills` mirrors this repo.
  link_dir "$REPO_ROOT/yellowstone-skill" "$AGENTS_SKILLS/yellowstone"
  for skill in hotshot dagr-producer unblock; do
    [ -d "$REPO_ROOT/skills/$skill" ] || continue
    link_dir "$REPO_ROOT/skills/$skill" "$AGENTS_SKILLS/$skill"
  done
  # hotshot reads model ids from .env beside its SKILL.md; our copy ships empty
  # values on purpose, so a fresh install asks the operator once.
  if [ -e "$AGENTS_SKILLS/hotshot/.env" ]; then
    info "hotshot: $(short "$AGENTS_SKILLS/hotshot/.env")"
  fi
}

# ----------------------------------------------------------------- secrets --
install_secrets() {
  step "Provider credentials"
  local dir="$PI_DIR/secrets"
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "create empty credential files under $(short "$dir")"
    return 0
  fi
  mkdir -p -- "$dir"; chmod 700 "$dir"
  # Discover which providers models.json wants a file for, so this list cannot
  # drift from the config.
  local names
  names="$(node -e '
    const m = require(process.argv[1]);
    const out = new Set();
    for (const p of Object.values(m.providers || {})) {
      const k = p && p.apiKey;
      if (typeof k === "string" && k.startsWith("!")) {
        const m2 = k.match(/secrets\/([A-Za-z0-9._-]+)/);
        if (m2) out.add(m2[1]);
      }
    }
    console.log([...out].join(" "));
  ' "$PI_DIR/models.json")"

  local created=0
  for name in $names; do
    if [ ! -s "$dir/$name" ]; then
      if [ -e "$dir/$name" ]; then
        info "credential file exists but is empty: $(short "$dir/$name")"
      else
        : > "$dir/$name"; chmod 600 "$dir/$name"
        info "created $(short "$dir/$name") — fill it with the provider's API key"
        created=$((created+1))
      fi
    fi
  done
  if [ "$created" = 0 ]; then info "all credential files present"; fi
  cat <<EOF

    Credentials are read at request time by pi, one file per provider:

        printf '%s' 'sk-...' > $dir/relayfast
        chmod 600 $dir/relayfast

    Then check a route end to end:

        pi auth check --provider relayfast --json
EOF
}

# ------------------------------------------------------------------ verify --
install_verify() {
  step "Verification"
  "$REPO_ROOT/scripts/doctor.sh"
}

want herdr   && install_herdr
want pi      && install_pi
want skills  && install_skills
want secrets && install_secrets
if want verify; then
  if [ "$DRY_RUN" = 1 ]; then
    step "Verification"
    dryrun "scripts/doctor.sh"
  else
    install_verify
  fi
fi

step "Done"
cat <<EOF
Next:
  1. Put a key in each file under $(short "$PI_DIR/secrets/") (see above).
  2. Start herdr, open a project, and run: pi
  3. Re-check any time with: $REPO_ROOT/scripts/doctor.sh
EOF
