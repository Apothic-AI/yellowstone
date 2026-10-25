#!/usr/bin/env bash
# overlord.sh — set up the overlord space and its context directory.
#
#   overlord.sh install   create ~/.overlord, install AGENTS.md/README.md,
#                         create the `overlord` herdr workspace if absent
#   overlord.sh status    is the directory there, does the space exist
#
# The overlord space is the parent-orchestrator surface: one herdr workspace
# whose cwd is a directory of plain Markdown — the role instructions plus an
# index of the other spaces. Nothing in it is generated, so it round-trips
# through this repo without loss.
#
# Idempotence matters more here than anywhere else in the installer:
# `herdr workspace create` does NOT deduplicate by label or cwd. Calling it
# twice creates two workspaces with the same name (verified: it produced w1A
# and w1B from identical arguments), and a duplicate orchestrator space is the
# kind of mistake that silently splits attention. So the workspace is looked up
# first and only created when genuinely absent.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

OVERLORD_LABEL="${OVERLORD_WORKSPACE_LABEL:-overlord}"
OVERLORD_DIR="${OVERLORD_DIR:-$HOME/.overlord}"
SRC="$REPO_ROOT/overlord"

# workspace ids + labels, one "id<TAB>label" per line
workspaces() {
  have herdr || return 1
  # `workspace list` already emits JSON and rejects a --json flag.
  herdr workspace list 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        for (const w of JSON.parse(s).result?.workspaces ?? []) {
          console.log(`${w.workspace_id}\t${w.label}`);
        }
      } catch {}
    });
  '
}

find_overlord_workspace() {
  workspaces 2>/dev/null | awk -F'\t' -v want="$OVERLORD_LABEL" '$2 == want { print $1; exit }'
}

install_dir() {
  step "Overlord context directory"

  if [ "${DRY_RUN:-0}" = 1 ]; then
    dryrun "mkdir -p $OVERLORD_DIR and install AGENTS.md, README.md"
    return 0
  fi

  mkdir -p -- "$OVERLORD_DIR"
  install_file "$SRC/AGENTS.md" "$OVERLORD_DIR/AGENTS.md"
  # README.md holds the live workspace index, which the operator updates as
  # spaces come and go. Never overwrite an existing one: it is the only map.
  if [ -e "$OVERLORD_DIR/README.md" ]; then
    info "kept $(short "$OVERLORD_DIR/README.md") (it holds the live workspace index)"
  else
    install_file "$SRC/README.md" "$OVERLORD_DIR/README.md"
  fi
}

install_workspace() {
  step "Overlord herdr workspace"

  if ! have herdr; then
    warn "herdr not installed — skipping workspace creation"
    return 0
  fi

  local existing
  existing="$(find_overlord_workspace)"

  if [ -n "$existing" ]; then
    info "workspace '$OVERLORD_LABEL' already exists ($existing) — not creating another"
    if [ "${DRY_RUN:-0}" = 0 ] && [ -d "$OVERLORD_DIR" ]; then
      # Nudge the cwd only when it is plainly elsewhere; never rewrite a space
      # the operator has deliberately pointed somewhere.
      info "  its cwd is whatever the operator set; this script does not move it"
    fi
    return 0
  fi

  if [ "${DRY_RUN:-0}" = 1 ]; then
    dryrun "herdr workspace create --cwd $OVERLORD_DIR --label $OVERLORD_LABEL --no-focus"
    return 0
  fi

  local out id
  out="$(herdr workspace create --cwd "$OVERLORD_DIR" --label "$OVERLORD_LABEL" --no-focus 2>&1)"
  id="$(printf '%s' "$out" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.stdout.write(JSON.parse(s).result.workspace.workspace_id); } catch {}
    });
  ' 2>/dev/null)"

  if [ -n "$id" ]; then
    info "created workspace '$OVERLORD_LABEL' ($id) at $(short "$OVERLORD_DIR")"
  else
    warn "workspace create failed; run it by hand:"
    info "  herdr workspace create --cwd $(short "$OVERLORD_DIR") --label $OVERLORD_LABEL"
    printf '%s\n' "$out" | head -3 | sed 's/^/    /'
    return 1
  fi
}

cmd_status() {
  local rc=0

  if [ -d "$OVERLORD_DIR" ]; then
    printf '%sok%s    %-24s present at %s\n' "$C_GREEN" "$C_RESET" "overlord-dir" "$(short "$OVERLORD_DIR")"
    [ -f "$OVERLORD_DIR/AGENTS.md" ] \
      && printf '%sok%s    %-24s present\n' "$C_GREEN" "$C_RESET" "overlord-AGENTS.md" \
      || { printf '%smiss%s  %-24s missing\n' "$C_YELLOW" "$C_RESET" "overlord-AGENTS.md"; rc=1; }
    [ -f "$OVERLORD_DIR/README.md" ] \
      && printf '%sok%s    %-24s present\n' "$C_GREEN" "$C_RESET" "overlord-README.md" \
      || { printf '%smiss%s  %-24s missing\n' "$C_YELLOW" "$C_RESET" "overlord-README.md"; rc=1; }
    # A leftover from the pre-rename layout is worth naming, not hiding.
    if [ -L "$HOME/.agent-context" ]; then
      printf '%s--%s    %-24s legacy path is a symlink to %s\n' \
        "$C_DIM" "$C_RESET" "overlord-legacy" "$(readlink -f "$HOME/.agent-context")"
    fi
  else
    printf '%smiss%s  %-24s %s does not exist\n' "$C_YELLOW" "$C_RESET" "overlord-dir" "$(short "$OVERLORD_DIR")"
    rc=1
  fi

  if ! have herdr; then
    printf '%s--%s    %-24s herdr not installed\n' "$C_DIM" "$C_RESET" "overlord-space"
    return $rc
  fi

  local id; id="$(find_overlord_workspace)"
  if [ -n "$id" ]; then
    printf '%sok%s    %-24s workspace '%s' = %s\n' "$C_GREEN" "$C_RESET" "overlord-space" "$OVERLORD_LABEL" "$id"
  else
    printf '%smiss%s  %-24s no workspace labelled '%s'\n' "$C_YELLOW" "$C_RESET" "overlord-space" "$OVERLORD_LABEL"
    rc=1
  fi
  return $rc
}

cmd_install() {
  install_dir
  install_workspace
  return 0
}

CMD=install
while [ $# -gt 0 ]; do
  case "$1" in
    install|status) CMD="$1" ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

case "$CMD" in
  install) cmd_install ;;
  status)  cmd_status ;;
esac
