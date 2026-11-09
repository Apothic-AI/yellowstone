#!/usr/bin/env bash
# herdr-plugins.sh — apply herdr/plugins.toml to this machine.
#
#   herdr-plugins.sh install     install every plugin not present
#   herdr-plugins.sh update      refresh GitHub-managed plugins in place
#   herdr-plugins.sh status      one line per plugin: installed / missing / optional
#   herdr-plugins.sh list        print the manifest table
#
# herdr refuses to install over a locally linked plugin and `plugin link` is the
# only way to run a local checkout, so each entry declares either a GitHub source
# or link_path. Refs are pinned in the manifest: updating a plugin here is a
# commit that bumps `ref`, not a silent moving target.
#
# The manifest is read from home/ rather than from the installed copy, because
# this is the file a `git pull` updates; the installed copy exists so the machine
# records the declared set, and doctor compares the two.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MANIFEST="$REPO_ROOT/herdr/plugins.toml"
MANIFEST_JS="$REPO_ROOT/scripts/plugins-manifest.js"

have herdr || die "herdr is not installed; install it first (curl -fsSL https://herdr.dev/install.sh | sh)"

rows() { node "$MANIFEST_JS" rows "$MANIFEST"; }

# Plugin ids herdr currently knows about, one per line.
installed_ids() {
  herdr plugin list --json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        for (const p of JSON.parse(s).result?.plugins ?? []) console.log(p.plugin_id);
      } catch { /* --json unsupported: report nothing installed */ }
    });
  '
}

is_installed() { printf '%s\n' "$1" | grep -qx -- "$2"; }

# Without a server every plugin reads as "not installed", which is the wrong
# answer: the plugins are on disk, we simply cannot ask. Say so instead.
if ! needs_herdr_server; then
  case "${1:-install}" in
    status)
      printf '%s--%s    no herdr server running — cannot enumerate installed plugins\n' \
        "$C_DIM" "$C_RESET"
      # Still report what the manifest declares, so the output is useful.
      while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
        [ -n "$id" ] || continue
        printf '%s?%s      %-22s declared (%s)\n' "$C_DIM" "$C_RESET" "$id" "$source"
      done < <(rows)
      exit 0
      ;;
    install)
      warn "no herdr server running — plugins install per-user and need one"
      info "  start it: herdr        then re-run: $0 install"
      exit 1
      ;;
  esac
fi
[ -f "$MANIFEST" ] || die "missing $MANIFEST"

cmd_list() {
  printf '%-22s %-42s %-11s %s\n' ID SOURCE REF ROLE
  local id source ref link_path optional why repo note
  while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
    local shown="$source"
    [ "$source" = "local" ] && shown="local:$repo"
    local r="-"; [ -n "$ref" ] && r="${ref:0:9}"
    printf '%-22s %-42s %-11s %s\n' "$id" "$shown" "$r" "$why"
  done < <(rows)
}

cmd_status() {
  local ids rc=0 id source ref link_path optional why repo note
  ids="$(installed_ids)"
  while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
    if is_installed "$ids" "$id"; then
      printf '%sok%s    %-22s installed\n' "$C_GREEN" "$C_RESET" "$id"
    elif [ "$optional" = "true" ]; then
      printf '%sopt%s   %-22s not installed (optional)\n' "$C_DIM" "$C_RESET" "$id"
    else
      printf '%smiss%s  %-22s not installed\n' "$C_YELLOW" "$C_RESET" "$id"
      rc=1
    fi
  done < <(rows)
  return $rc
}

cmd_install() {
  local ids failed=0 id source ref link_path optional why repo note
  ids="$(installed_ids)"
  while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
    if is_installed "$ids" "$id"; then
      info "$id: present"
      continue
    fi

    if [ "$source" = "local" ]; then
      local path="${link_path/#\~/$HOME}"
      if [ ! -d "$path" ]; then
        if [ "$optional" = "true" ]; then
          warn "$id: optional, missing checkout at $(short "$path") — skipped"
        else
          warn "$id: missing local checkout at $(short "$path")"
          info "  clone it: gh repo clone ${repo:-$source} $(short "$path")"
          failed=$((failed + 1))
        fi
        continue
      fi
      if [ "${DRY_RUN:-0}" = 1 ]; then dryrun "herdr plugin link $(short "$path")"; continue; fi
      if herdr plugin link "$path" >/dev/null 2>&1; then
        info "$id: linked from $(short "$path")"
      else
        warn "$id: link failed — run: herdr plugin link $(short "$path")"
        failed=$((failed + 1))
      fi
      continue
    fi

    local args=("$source" --yes)
    [ -n "$ref" ] && args+=(--ref "$ref")
    if [ "${DRY_RUN:-0}" = 1 ]; then dryrun "herdr plugin install ${args[*]}"; continue; fi
    if herdr plugin install "${args[@]}" >/dev/null 2>&1; then
      info "$id: installed from $source${ref:+ @ ${ref:0:9}}"
    else
      warn "$id: install failed — run: herdr plugin install ${args[*]}"
      failed=$((failed + 1))
    fi
  done < <(rows)

  [ "$failed" = 0 ] || { warn "$failed plugin(s) need attention"; return 1; }
  return 0
}

cmd_update() {
  # `herdr plugin update` shipped in 0.9.4. On older servers, reinstall instead:
  # it re-fetches the pinned ref and replaces the managed copy in place.
  local ver lowest id source ref link_path optional why repo note
  ver="$(herdr --version 2>/dev/null | awk '{print $2}')"
  lowest="$(printf '%s\n0.9.4\n' "$ver" | sort -V | head -n1)"

  if [ "$lowest" = "0.9.4" ]; then
    if [ "${DRY_RUN:-0}" = 1 ]; then dryrun "herdr plugin update --yes"; return 0; fi
    herdr plugin update --yes 2>&1 | sed 's/^/    /'
    return 0
  fi

  warn "herdr ${ver:-unknown} predates 'plugin update' (needs 0.9.4); reinstalling pinned refs"
  local ids; ids="$(installed_ids)"
  while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
    [ "$source" = "local" ] && continue
    is_installed "$ids" "$id" || continue
    local args=("$source" --yes); [ -n "$ref" ] && args+=(--ref "$ref")
    if [ "${DRY_RUN:-0}" = 1 ]; then dryrun "herdr plugin install ${args[*]}"; continue; fi
    if herdr plugin install "${args[@]}" >/dev/null 2>&1; then
      info "$id: reconciled"
    else
      warn "$id: reconcile failed"
    fi
  done < <(rows)
}

case "${1:-install}" in
  install) cmd_install ;;
  update)  cmd_update ;;
  status)  cmd_status ;;
  list)    cmd_list ;;
  *) err "usage: $0 {install|update|status|list}"; exit 2 ;;
esac
