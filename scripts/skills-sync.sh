#!/usr/bin/env bash
# skills-sync.sh — install every agent skill from the tree that owns it.
#
#   skills-sync.sh install   install/link every enabled skill (default)
#   skills-sync.sh status    one line per skill: installed, kind, drift
#   skills-sync.sh list      print the manifest
#
# The manifest is skills/skills.tsv. Three kinds:
#
#   repo    the skill lives in a repository (usually our fork). Linked from a
#           checkout when one exists, otherwise fetched with `npx skills add`.
#           Never copied into this repo: the repo that owns the skill is the
#           place to change it, and a copy here would silently diverge.
#   dagr    the skill belongs to the herdr-dagr plugin. Generated with
#           `dagr --skill` into the plugin's own skills/ directory, so the
#           SKILL.md and the examples/ its links point at stay together, then
#           linked into ~/.agents/skills. Never bundled: the plugin is pinned in
#           home/.config/herdr/plugins.toml, and `dagr --skill` prints exactly
#           its copy.
#   bundle  no installable home exists. This repo is the source of truth, and
#           the files live under home/.agents/skills/ — the mirror of the
#           directory they are linked into.
#           Reported by `status` as debt so it cannot quietly accumulate.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# SKILLS_MANIFEST exists so the test suite can exercise the resolver logic
# against a synthetic manifest without touching the real one.
MANIFEST="${SKILLS_MANIFEST:-$REPO_ROOT/skills/skills.tsv}"
[ -f "$MANIFEST" ] || die "missing $MANIFEST"

# id <TAB> kind <TAB> spec <TAB> why, skipping comments and blank lines.
rows() { grep -vE '^[[:space:]]*(#|$)' "$MANIFEST"; }

# ---------------------------------------------------------------- resolvers --

# Resolve the dagr binary the same way the dagr-producer skill tells agents to:
# $DAGR_BIN, then PATH, then the plugin's build output, then `herdr plugin list`.
resolve_dagr() {
  if [ -n "${DAGR_BIN:-}" ] && [ -x "${DAGR_BIN}" ]; then printf '%s\n' "$DAGR_BIN"; return 0; fi
  if have dagr; then command -v dagr; return 0; fi
  local root
  root="$(dagr_plugin_root)"
  if [ -n "$root" ] && [ -x "$root/bin/dagr" ]; then printf '%s\n' "$root/bin/dagr"; return 0; fi
  if [ -n "$root" ] && [ -x "$root/target/release/dagr" ]; then printf '%s\n' "$root/target/release/dagr"; return 0; fi
  return 1
}

# The installed herdr-dagr plugin root, from herdr itself.
dagr_plugin_root() {
  have herdr || return 1
  herdr plugin list --json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const p = (JSON.parse(s).result?.plugins ?? []).find((x) => x.plugin_id === "herdr-dagr");
        if (p?.plugin_root) process.stdout.write(p.plugin_root);
      } catch {}
    });
  '
}

# Find an existing checkout of a GitHub repo, so a repo-owned skill can be
# linked (and therefore update with `git pull`) instead of re-fetched.
#
# The monorepo is asked first. Every `src/**/.gitrepo` records the remote it
# tracks, so a match there is the same commit the extension itself is pinned to —
# a skill and the code it documents cannot drift apart. That matters because the
# loose checkouts below are what FT-01 retires: without this branch, deleting
# `~/Code/apothic-monorepo-workspace/tooling/unblock` would silently send every
# unblock skill to a fresh duplicate clone under `~/Code`, which is the scatter
# the monorepo exists to end.
find_checkout() {
  local repo="$1" name="${1#*/}" dir gitrepo remote want
  want="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
  for gitrepo in "$REPO_ROOT"/src/*/*/.gitrepo; do
    [ -f "$gitrepo" ] || continue
    remote="$(git config -f "$gitrepo" subrepo.remote 2>/dev/null || true)"
    [ -n "$remote" ] || continue
    case "$(printf '%s' "$remote" | tr '[:upper:]' '[:lower:]')" in
      *"$want"*) printf '%s\n' "$(dirname "$gitrepo")"; return 0 ;;
    esac
  done
  local roots=("$HOME/Code" "$HOME/src" "$HOME/projects" "$HOME/dev" "$HOME/git" "$HOME/Code/apothic-monorepo-workspace/tooling")
  for dir in "${roots[@]}"; do
    [ -d "$dir" ] || continue
    for candidate in "$dir/$name" "$dir"/*/"$name"; do
      [ -d "$candidate/.git" ] || [ -d "$candidate/.jj" ] || continue
      remote="$(git -C "$candidate" remote get-url origin 2>/dev/null || true)"
      case "$remote" in
        *"$repo"*) printf '%s\n' "$candidate"; return 0 ;;
      esac
    done
  done
  return 1
}

# -------------------------------------------------------------------- kinds --

install_bundle() {
  local id="$1" path="$2" src
  src="$REPO_ROOT/${path#./}"
  [ -d "$src" ] || { warn "$id: bundled path missing: $path"; return 1; }
  link_dir "$src" "$AGENTS_SKILLS/$id"
}

install_dagr() {
  local id="$1" plugin_id="$2" dagr root dest

  if ! dagr="$(resolve_dagr)"; then
    warn "$id: no dagr binary yet — install the herdr-dagr plugin first:"
    info "  scripts/herdr-plugins.sh install"
    return 1
  fi
  if ! root="$(dagr_plugin_root)" || [ -z "$root" ]; then
    warn "$id: herdr-dagr plugin not installed — run scripts/herdr-plugins.sh install"
    return 1
  fi

  dest="$root/skills/$id"
  # `dagr --skill` prints the copy of the skill bundled with that binary. Its
  # relative links point at examples/ beside it, so generate in place rather
  # than extracting somewhere detached where every link would dangle.
  if [ "${DRY_RUN:-0}" = 1 ]; then
    dryrun "$(short "$dagr") --skill > $(short "$dest")/SKILL.md"
    dryrun "link $(short "$AGENTS_SKILLS/$id") -> $(short "$dest")"
    return 0
  fi

  mkdir -p -- "$dest"
  if ! "$dagr" --skill > "$dest/SKILL.md.tmp" 2>/dev/null; then
    rm -f -- "$dest/SKILL.md.tmp"
    warn "$id: '$dagr --skill' failed"
    return 1
  fi
  # Same transaction the dagr-producer contract uses: validate, then move.
  if ! head -n1 "$dest/SKILL.md.tmp" | grep -qx -- '---'; then
    rm -f -- "$dest/SKILL.md.tmp"
    warn "$id: 'dagr --skill' did not print a SKILL.md (no frontmatter)"
    return 1
  fi
  mv -- "$dest/SKILL.md.tmp" "$dest/SKILL.md"
  info "$id: generated from $(short "$dagr") ($(wc -l < "$dest/SKILL.md") lines)"
  link_dir "$dest" "$AGENTS_SKILLS/$id"
}

# A skill directory inside a checkout. Repositories put skills in either
# `skills/<id>/` (unblock) or at the top level (mycord's sibling skills), and a
# resolver that only knows one layout silently falls through to the network.
skill_dir_in() {
  local checkout="$1" id="$2"
  for candidate in "$checkout/skills/$id" "$checkout/$id"; do
    [ -f "$candidate/SKILL.md" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

install_repo() {
  local id="$1" repo="$2" checkout dir

  if checkout="$(find_checkout "$repo")"; then
    if dir="$(skill_dir_in "$checkout" "$id")"; then
      info "$id: using checkout $(short "$checkout")"
      link_dir "$dir" "$AGENTS_SKILLS/$id"
      return 0
    fi
    warn "$id: checkout $(short "$checkout") has neither skills/$id nor $id — falling back to fetch"
  fi

  # No checkout. Cloning the owning repo is the reliable path, and it is what
  # makes later updates a `git pull`; the skills CLI is only a convenience and
  # does not discover every layout (it misses our unblock fork's skills/unblock).
  local clone_to="$HOME/Code/${repo#*/}"

  if [ "${DRY_RUN:-0}" = 1 ]; then
    dryrun "npx --yes skills add $repo --skill $id -g   (or clone to $(short "$clone_to") and link)"
    return 0
  fi

  local out status
  # </dev/null: the skills CLI reads stdin. Inside this `while read` loop the
  # loop's stdin *is* the manifest, so an inherited stdin lets the first
  # fetched skill swallow every row after it — the install then reports success
  # having silently skipped the second half of skills/skills.tsv.
  out="$(npx --yes skills add "$repo" --skill "$id" -g 2>&1 </dev/null)"; status=$?
  if [ $status -eq 0 ] && ! printf '%s' "$out" | grep -qiE 'no (valid )?(matching )?skills found|No skills found'; then
    if [ -f "$AGENTS_SKILLS/$id/SKILL.md" ] || [ -L "$AGENTS_SKILLS/$id" ]; then
      info "$id: installed from $repo via the skills CLI"
      return 0
    fi
  fi

  warn "$id: no local checkout of $repo, and the skills CLI did not install it"
  info "  clone it, then re-run this script (the skill is then linked, and"
  info "  updates arrive with 'git pull'):"
  info "    gh repo clone $repo $(short "$clone_to")"
  info "    $0 install"
  return 1
}

# ------------------------------------------------------------------ actions --

cmd_install() {
  local id kind spec why failed=0
  while IFS=$'\t' read -r id kind spec why; do
    [ -n "$id" ] || continue
    case "$kind" in
      bundle) install_bundle "$id" "$spec" || failed=$((failed + 1)) ;;
      dagr)   install_dagr   "$id" "$spec" || failed=$((failed + 1)) ;;
      repo)   install_repo   "$id" "$spec" || failed=$((failed + 1)) ;;
      *) warn "$id: unknown kind '$kind' in $MANIFEST"; failed=$((failed + 1)) ;;
    esac
  done < <(rows)

  [ "$failed" = 0 ] || { warn "$failed skill(s) need attention"; return 1; }
  return 0
}

cmd_status() {
  local id kind spec why rc=0 debt=0
  while IFS=$'\t' read -r id kind spec why; do
    [ -n "$id" ] || continue
    # A symlink is only evidence when its target resolves. `[ -L ]` alone reports
    # `linked` for a link into a directory that moved or was deleted underneath it
    # — which is what happened when the reorganisation moved herdr/skills/herdr to
    # home/.agents/skills/herdr: status stayed green while the link pointed at
    # nothing, and a proof lane found it only by running readlink by hand.
    local dest="$AGENTS_SKILLS/$id" state="missing" target=""
    if [ -L "$dest" ]; then
      target="$(readlink -f "$dest" 2>/dev/null || true)"
      if [ -n "$target" ] && [ -e "$target" ]; then state="linked"; else state="dangling"; fi
    elif [ -e "$dest" ]; then
      state="present"
    fi

    local detail="$kind"
    case "$kind" in
      dagr)
        if command -v dagr >/dev/null 2>&1; then detail="$kind ($(dagr --version 2>/dev/null | head -n1))"
        else detail="$kind (no dagr on PATH)"; fi
        ;;
      repo)
        if local ck; ck="$(find_checkout "$spec")"; then
          if skill_dir_in "$ck" "$id" >/dev/null; then detail="$kind (checkout $(short "$ck"))"
          else detail="$kind ($spec — checkout lacks this skill)"; fi
        else detail="$kind ($spec — no checkout; will fetch)"; fi
        ;;
      bundle) detail="$kind"; debt=$((debt + 1)) ;;
    esac

    local color="$C_GREEN"
    case "$state" in
      missing)  color="$C_YELLOW"; rc=1 ;;
      dangling) color="$C_RED"; rc=1; detail="$detail -> $(short "${target:-?}") (BROKEN)" ;;
      linked)   color="$C_GREEN" ;;
      present) color="$C_YELLOW"; rc=1 ;;   # a real dir where a link should be
    esac
    printf '%s%-8s%s %-16s %-9s %s\n' "$color" "$state" "$C_RESET" "$id" "$kind" "$detail"
  done < <(rows)

  printf '\n%s bundle(s) carry no installable home; see skills/skills.tsv for what would retire each.\n' "$debt"
  return $rc
}

cmd_list() {
  printf '%-16s %-8s %-44s %s\n' ID KIND SOURCE WHY
  local id kind spec why
  while IFS=$'\t' read -r id kind spec why; do
    [ -n "$id" ] || continue
    printf '%-16s %-8s %-44s %s\n' "$id" "$kind" "$spec" "${why:0:70}"
  done < <(rows)
}

CMD=install
while [ $# -gt 0 ]; do
  case "$1" in
    install|status|list) CMD="$1" ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown argument: $1"; err "usage: $0 {install|status|list} [--dry-run] [--yes]"; exit 2 ;;
  esac
  shift
done

case "$CMD" in
  install) cmd_install ;;
  status)  cmd_status ;;
  list)    cmd_list ;;
esac
