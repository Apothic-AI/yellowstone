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
  herdr      home/.config/herdr (config.toml), plugins, pi
             integration, home/.local/bin
  pi         home/.pi/agent — settings, models, extensions, configs — then the
             packages those settings declare; also install the Behold reporter
  behold     Behold CLI and Python package into ~/.local/bin and ~/.local/share
  parameter-tools  the model/thinking parameter-tools package from src/
  skills     link every agent skill the manifest selects from home/.agents/skills
             and from the repositories that own the rest
  agents     ~/AGENTS.md — the fleet instruction core (home/AGENTS.md)
  overlord   home/.overlord, the ~/.sysops directory, the two herdr spaces and
             their tabs
  secrets    create empty ~/.pi/agent/secrets/<provider> files to fill in
  verify     report what is installed, outdated, or missing

Every file above is a path under home/ whose destination is the same path under
$HOME, so a file added to home/ is installed by the stage that owns its root.
The installer's own files — scripts/, docs/, test/, yellowstone-skill/, the
skill and plugin manifests — stay at the top level: they are not installed
content.

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
    herdr|launcher|pi|behold|parameter-tools|plugins|skills|agents|extensions|spaces|overlord|secrets|verify) STAGES+=("$1") ;;
    *) err "unknown argument: $1"; usage; exit 2 ;;
  esac
  shift
done

if [ ${#STAGES[@]} -eq 0 ]; then
  STAGES=(herdr launcher pi behold parameter-tools skills agents extensions plugins spaces overlord secrets verify)
fi

# Where the pi-goal fork lives (PI_EXTENSIONS_APOTHIC) is a layout path, so its
# default sits in scripts/lib.sh with the rest: the fork is a package inside a Bun
# workspace with no Pi manifest at its root, so `pi` cannot load it as a git
# package and it has to be a checkout.
#
# The two below are the other checkouts pi loads a package from, exported because
# json-edit.js resolves the @PI_EXTENSIONS_1@ and @PI_FLEET_HOOKS@ placeholders
# from the environment rather than from an argument, so one variable per checkout
# is enough and a moved checkout needs no code change.
PI_EXTENSIONS_1="${PI_EXTENSIONS_1:-$HOME/Code/apothic-pi-extensions}"
PI_FLEET_HOOKS="${PI_FLEET_HOOKS:-$HOME/Code/pi-fleet-hooks}"
export PI_EXTENSIONS_1 PI_FLEET_HOOKS

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

for f in home/.pi/agent/settings.json home/.pi/agent/models.json \
         home/.config/herdr/config.toml herdr/plugins.toml \
         home/AGENTS.md scripts/json-edit.js; do
  [ -e "$REPO_ROOT/$f" ] || die "repository is incomplete: missing $f"
done
node "$REPO_ROOT/scripts/json-edit.js" validate \
  "$REPO_ROOT/home/.pi/agent/settings.json" "$REPO_ROOT/home/.pi/agent/models.json" >/dev/null
info "repository at $(short "$REPO_ROOT") is valid"

have herdr || warn "herdr not on PATH — the herdr stages will be skipped"
have pi    || warn "pi not on PATH — the pi stages will be skipped"
[ "$DRY_RUN" = 1 ] && warn "dry run: no files will be written"

# ------------------------------------------------------------------- herdr --
install_herdr() {
  have herdr || { warn "skipping herdr stage: herdr not installed"; return 0; }
  step "Herdr"

  info "herdr $(version_of herdr) (channel: $(herdr channel show 2>/dev/null || echo unknown))"

  # config.toml is the one file this stack owns in herdr's config directory, so
  # home/.config/herdr/ installs it by path and replaces it (the backup is the
  # escape hatch). The plugin *declaration* is deliberately NOT a $HOME file:
  # herdr/plugins.toml lives at the repo root, because a manifest this installer
  # reads to decide what to apply is not content that lands on a machine —
  # writing a copy into ~/.config/herdr/ would invent a destination nothing
  # reads, which is the same mistake as treating a lockfile as a config.
  install_home_tree .config/herdr
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

  # The plugin set is declarative and its own stage (see install_plugins), because
  # `./install.sh plugins` is advertised in the usage line and must do what it says.
  install_plugins

  # The herdr skill is not linked here: it is a skill like any other, so
  # home/.agents/skills/herdr is installed by the skills stage from
  # skills/skills.tsv — one membership test for every skill, one owner.

  # herdr-agy.sh: reliability wrapper for kind=agy/grok agents (herdr#3530).
  # home/.local/bin is the literal mirror of $LOCAL_BIN, mode preserved.
  install_home_tree .local/bin
}

# ---------------------------------------------------------------------- pi --
install_pi() {
  have pi || { warn "skipping pi stage: pi not installed"; return 0; }
  step "Pi"
  info "pi $(version_of pi) (agent dir: $(short "$PI_DIR"))"

  # Every file home/.pi/agent/ carries, installed by its policy: settings.json
  # and models.json merge, the three personal files install only when absent,
  # everything else is copied. A new per-feature file needs no code here — only
  # a path under home/.pi/agent/ — which is what the mirror is for.
  install_home_tree .pi/agent
  # Standalone reporter is auto-discovered in the agent extensions directory.
  install_file "$REPO_ROOT/src/pi-extensions/behold/pi-extension/behold-state.ts" \
    "$PI_DIR/extensions/behold-state.ts"

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

# ------------------------------------------------------------------ behold --
install_behold() {
  step "Behold CLI"
  # The entry point resolves its real path, so a symlink into the installed
  # component preserves its relative Python import without depending on checkout.
  local src="$REPO_ROOT/src/pi-extensions/behold" dest="$HOME/.local/share/yellowstone/behold" f
  while IFS= read -r -d '' f; do
    install_file "$f" "$dest/${f#"$src"/}"
  done < <(find "$src/behold" -type f -name '*.py' -print0)
  install_file "$src/bin/behold" "$dest/bin/behold" 755
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "link $(short "$LOCAL_BIN/behold") -> $(short "$dest/bin/behold")"
  else
    mkdir -p -- "$LOCAL_BIN"
    if [ "$(readlink "$LOCAL_BIN/behold" 2>/dev/null || true)" != "$dest/bin/behold" ]; then
      backup_path "$LOCAL_BIN/behold"
      ln -sfn -- "$dest/bin/behold" "$LOCAL_BIN/behold"
    fi
  fi
}

# --------------------------------------------------------- parameter-tools --
install_parameter_tools() {
  step "parameter-tools (model/thinking)"
  # A pi package, but it lives in a workspace subdirectory of our pi-extensions fork, and
  # `pi install git:<repo>@<sha>` has no way to name a subdirectory — it would install the
  # monorepo root, which declares no `pi.extensions`. It is installed from the checkout
  # instead, exactly as Behold is, and the package is recorded by pi itself so
  # `pi update --extensions` stays coherent.
  local spec="$REPO_ROOT/src/pi-extensions/pi-parameter-tools"
  if ! have pi; then
    warn "pi is not on PATH — parameter-tools not installed"
    return 0
  fi
  if [ ! -f "$spec/package.json" ]; then
    warn "parameter-tools: $spec carries no package.json — skipped"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "pi install $(short "$spec")"
    return 0
  fi
  if pi install "$spec" >/tmp/pi-install-parameter-tools.log 2>&1; then
    :
  else
    warn "parameter-tools: pi install failed — run: pi install $spec"
    tail -3 /tmp/pi-install-parameter-tools.log | sed 's/^/    /'
  fi
}

# ------------------------------------------------------------------ skills --
install_skills() {
  step "Agent skills"
  # Each skill is installed from the tree that owns it, per skills/skills.tsv.
  # Nothing is copied into this repo that already has a home elsewhere: a
  # bundled copy of a skill that a plugin or fork ships is a silent fork of a
  # file somebody else maintains.
  #
  # A skill that cannot be resolved is a report, not a reason to abandon the
  # install — and the same is true under --dry-run, where this call used to be
  # the one unguarded stage: a machine with no dagr binary aborted the plan
  # before agents, overlord, secrets and verify were ever printed.
  if [ "$DRY_RUN" = 1 ]; then
    "$REPO_ROOT/scripts/skills-sync.sh" install --dry-run || warn "some skills need attention"
  else
    "$REPO_ROOT/scripts/skills-sync.sh" install || warn "some skills need attention"
  fi

  # hotshot reads model ids from .env beside its SKILL.md; our copy ships empty
  # values on purpose, so a fresh install asks the operator once.
  if [ -e "$AGENTS_SKILLS/hotshot/.env" ]; then
    info "hotshot config: $(short "$AGENTS_SKILLS/hotshot/.env")"
  fi
}

# ------------------------------------------------------------------ agents --
install_agents() {
  step "Agent instructions"
  # pi (and other harnesses) load AGENTS.md from the agent directory and from the
  # working directory's ancestors. This file is the shared instruction set, so it
  # lives at $HOME: every project under $HOME inherits it.
  #
  # The source is home/AGENTS.md, not the repo's own AGENTS.md. The two are
  # different documents with different readers: this repo's AGENTS.md tells an
  # agent how to work in this tree, while the fleet core is what every project
  # under $HOME inherits. They were one file while they were byte-identical, and
  # installing the repo copy once that stopped being true would have replaced the
  # core with a pointer to itself.
  #
  # A local AGENTS.md is often hand-edited. install_file copies over it but backs
  # it up first and says so — silently replacing someone's instructions is worse
  # than a stale file.
  install_home_tree AGENTS.md

  # Each fleet space carries its own scaffolding — AGENTS.md and .pi/modes, which pi
  # reads from the working directory it starts in. That is configuration, so it ships
  # in home/ and installs like any other file. Documents/ holds four of the seven
  # spaces; .sysops is walked only once it has been authored, because install_home_tree
  # dies on a subtree that is absent rather than no-opping.
  install_home_tree Documents
  if [ -e "$HOME_SRC/.sysops" ]; then
    install_home_tree .sysops
  fi
}

# ---------------------------------------------------------------- overlord --
install_overlord() {
  step "Overlord space"
  # The parent-orchestrator surface: a directory of Markdown plus the herdr
  # workspace whose cwd is that directory. Keeping it behind its own script
  # means the workspace-existence check travels with it — `herdr workspace
  # create` does not deduplicate, so creating a second `overlord` space is the
  # failure mode to design against.
  if [ "$DRY_RUN" = 1 ]; then
    "$REPO_ROOT/scripts/overlord.sh" install --dry-run
  else
    "$REPO_ROOT/scripts/overlord.sh" install || warn "overlord setup needs attention"
  fi
}

# ---------------------------------------------------------------- launcher --
install_launcher() {
  step "Launcher (pi-profile-switch)"
  # This is the one component that cannot be a `packages[]` entry: it creates the
  # instance directory, writes settings.json and pi-profile.json, writes the liveness
  # token, then spawns pi. A package cannot bootstrap the process that installs packages.
  #
  # It cannot come from npm either: the registry name `pi-profile-switch` belongs to
  # upstream (maintainer vincentff), and our fork kept the name — so `npm i -g` would
  # install someone else's code. Our only address for it is the git URL at the pin.
  #
  # Installed into a fixed prefix rather than with `npm install -g`, because a global
  # install of this package aborts on its rename-based swap (ENOTDIR) and leaves a
  # dangling symlink into ~/.npm/_cacache/tmp/git-cloneXXXX, which turns `pi-profile`
  # into an invalid mise shim and takes every future lane with it.
  #
  # EVERY failure here is a warning, never `return 1`. This stage runs before `pi`, so
  # a hard failure aborts the install before settings.json is written — and the
  # acceptance gate then reports "a machine installed from this tree would not run the
  # fleet", which is a true statement about the wrong thing. A missing launcher is a
  # broken lane; a missing settings.json is a broken install.
  #
  # PI_LAUNCHER_SKIP_GLOBAL=1 installs to the prefix but does NOT touch npm's global
  # bin dir. The acceptance gate sets it: a sandboxed install must not repoint the real
  # machine's launcher (it did, and broke it).
  local pin repo prefix
  pin="$(grep -m1 'commit = ' "$REPO_ROOT/src/pi-extensions/pi-profile-switch/.gitrepo" 2>/dev/null | cut -d= -f2 | tr -d ' ')"
  repo="$(grep -m1 'remote = ' "$REPO_ROOT/src/pi-extensions/pi-profile-switch/.gitrepo" 2>/dev/null | cut -d= -f2 | tr -d ' ')"
  prefix="${PI_LAUNCHER_PREFIX:-$HOME/.local/share/yellowstone/pi-profile-switch}"
  if [ -z "$pin" ] || [ -z "$repo" ]; then
    warn "cannot read the pi-profile-switch pin from its .gitrepo — launcher not installed"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "npm install --prefix $(short "$prefix") git+${repo}#${pin}"
    [ "${PI_LAUNCHER_SKIP_GLOBAL:-0}" = 1 ] \
      && dryrun "skip global link (PI_LAUNCHER_SKIP_GLOBAL=1)" \
      || dryrun "npm link $(short "$prefix")/node_modules/pi-profile-switch"
    return 0
  fi
  if ! have npm; then
    warn "npm is not available — launcher not installed"
    return 0
  fi
  if ! mkdir -p "$prefix" || ! npm install --prefix "$prefix" --no-audit --no-fund "git+${repo}#${pin}" >/tmp/launcher-install.log 2>&1; then
    warn "launcher install failed — run: npm install --prefix $prefix git+${repo}#${pin}"
    tail -5 /tmp/launcher-install.log 2>/dev/null | sed 's/^/    /'
    return 0
  fi
  info "installed pi-profile-switch @ ${pin:0:9} from ${repo##*/} into $(short "$prefix")"

  if [ "${PI_LAUNCHER_SKIP_GLOBAL:-0}" = 1 ]; then
    info "skipping the global link (PI_LAUNCHER_SKIP_GLOBAL=1 — sandboxed install)"
    return 0
  fi
  # Clear any prior global entry — a link, or the debris of a failed `-g` install —
  # before pointing the name at the prefix.
  npm unlink -g pi-profile-switch >/dev/null 2>&1 || true
  rm -f "$(npm root -g 2>/dev/null)/pi-profile-switch" 2>/dev/null || true
  if ! npm link --silent "$prefix/node_modules/pi-profile-switch" >/dev/null 2>&1; then
    warn "could not link the launcher into npm's global bin dir — do it by hand:"
    info "  npm link $prefix/node_modules/pi-profile-switch"
    return 0
  fi
  if command -v pi-profile >/dev/null 2>&1 && pi-profile --version >/dev/null 2>&1; then
    info "pi-profile resolves to $(short "$(readlink -f "$(command -v pi-profile)" 2>/dev/null)")"
  else
    warn "pi-profile does not run after installing — check PATH and npm's global bin dir"
  fi
  return 0
}

# -------------------------------------------------------------- extensions --
install_extensions() {
  step "Pi extensions (pi install)"
  # How the nine yellowstone components are declared and installed, in two modes:
  #
  #   PI_EXTENSIONS_FROM=local  (default on a development machine)
  #       pi install <repo>/src/pi-extensions/<component>
  #       pi records the local package and reads it from the working tree, so an
  #       edit is live in the next lane. That is the point of a development machine.
  #
  #   PI_EXTENSIONS_FROM=git    (a fresh production machine)
  #       pi install git:github.com/Apothic-AI/<repo>@<sha>
  #       the sha comes from each subrepo's .gitrepo, so production runs exactly the
  #       commit the tree pins — no checkout of the component is needed at all.
  #
  # `pi install` is the right tool in both cases: it is pi's own package mechanism,
  # it writes the declaration and performs the install, and it is the only path that
  # keeps `pi update --extensions` coherent. Hand-writing absolute paths into
  # settings.json — what this repo did — bypasses all of that.
  #
  # The launcher is NOT here: `pi-profile-switch` creates the instance dir and spawns
  # pi, so it cannot be a package. See install_launcher.
  local from="${PI_EXTENSIONS_FROM:-local}" c spec repo sha ok=0 skipped=0
  if ! have pi; then
    warn "pi is not on PATH — cannot install extensions"
    return 0
  fi
  for c in bizzy pi-cache-optimizer pi-pretty-tui pi-rooms apothic-todo \
           pi-persist pi-fleet-hooks pi-goal pi-modes; do
    [ -d "$REPO_ROOT/src/pi-extensions/$c" ] || { skipped=$((skipped + 1)); continue; }
    case "$from" in
      local)
        spec="$REPO_ROOT/src/pi-extensions/$c"
        ;;
      git)
        repo="$(grep -m1 'remote = ' "$REPO_ROOT/src/pi-extensions/$c/.gitrepo" 2>/dev/null | cut -d= -f2 | tr -d ' ')"
        sha="$(grep -m1 'commit = ' "$REPO_ROOT/src/pi-extensions/$c/.gitrepo" 2>/dev/null | cut -d= -f2 | tr -d ' ')"
        if [ -z "$repo" ] || [ -z "$sha" ]; then
          warn "$c: no remote/sha in its .gitrepo — skipped"
          skipped=$((skipped + 1)); continue
        fi
        spec="git:${repo#https://github.com/}@${sha}"
        ;;
      *)
        warn "PI_EXTENSIONS_FROM='$from' is not local or git — nothing installed"
        return 0
        ;;
    esac
    if [ "$DRY_RUN" = 1 ]; then
      dryrun "pi install $(short "$spec")"
      ok=$((ok + 1)); continue
    fi
    if pi install "$spec" >/tmp/pi-install-ext.log 2>&1; then
      ok=$((ok + 1))
    else
      warn "$c: pi install failed — run: pi install $spec"
      tail -3 /tmp/pi-install-ext.log | sed 's/^/    /'
    fi
  done
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "$ok extension(s) would install from $from, $skipped skipped"
  else
    info "$ok extension(s) installed from $from, $skipped skipped"
  fi
  return 0
}

# ----------------------------------------------------------------- plugins --
install_plugins() {
  # Once per run. The herdr stage calls this and the `plugins` stage calls it, so a
  # full install would otherwise apply the manifest twice. The guard is what makes
  # "own stage" and "called from herdr" compatible rather than double work.
  [ "${PLUGINS_DONE:-0}" = 1 ] && return 0
  PLUGINS_DONE=1
  step "Herdr plugins"
  # herdr/plugins.toml is the manifest; scripts/herdr-plugins.sh applies it. Kept as
  # its own stage so that `./install.sh plugins` is not a no-op: it was reachable
  # only from inside the herdr stage, while the usage line advertised it, so asking
  # for plugins alone printed a summary and changed nothing.
  #
  # A plugin whose local checkout is absent is a report, not a reason to abandon the
  # install: the later stages still have work to do, and under `set -e` an unguarded
  # failure here used to end the run before pi, skills, agents or overlord were
  # reached.
  if [ "$DRY_RUN" = 1 ]; then
    dryrun "herdr plugin install/update for every entry in herdr/plugins.toml"
    return 0
  fi
  "$REPO_ROOT/scripts/herdr-plugins.sh" install || warn "some herdr plugins need attention (see above)"
}

# ------------------------------------------------------------------ spaces --
install_spaces() {
  step "Herdr spaces"
  # FT-01 Objective 1: installing the fleet must leave all seven spaces present.
  # scripts/overlord.sh creates two of them (overlord, sysops) as part of its own
  # setup, so a label that already exists is looked up and skipped rather than
  # created twice — `herdr workspace create` does not deduplicate by label or cwd,
  # and a second space with the same name splits attention with no diagnostic.
  #
  # The table is in scripts/lib.sh beside every other destination, so a space's
  # workspace path and its scaffolding destination cannot drift apart.
  ensure_fleet_spaces || warn "some spaces need attention — see above"
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
  # A doctor failure is a report, not an install failure: everything above it
  # already ran. Swallow the status so the summary below still prints.
  "$REPO_ROOT/scripts/doctor.sh" || info "doctor reported open items (see above)"
}

want herdr   && install_herdr
want launcher && install_launcher
want pi      && install_pi
want behold  && install_behold
want parameter-tools && install_parameter_tools
want plugins && install_plugins
want extensions && install_extensions
want skills   && install_skills
want agents   && install_agents
want overlord && install_overlord
want spaces  && install_spaces
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
