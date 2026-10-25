#!/usr/bin/env bash
# overlord.sh — set up the overlord space and its context directory.
#
#   overlord.sh install   create ~/.overlord, install AGENTS.md/README.md,
#                         create the `overlord` herdr workspace if absent,
#                         then ensure its two agent tabs: `overlord` and `comms`
#   overlord.sh status    does the directory, the space, and both tabs exist
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

# Tabs in the overlord workspace, as "tab_id<TAB>label".
tabs_in() {
  local ws="$1"
  have herdr || return 1
  herdr tab list --workspace "$ws" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        for (const t of JSON.parse(s).result?.tabs ?? []) console.log(`${t.tab_id}\t${t.label}`);
      } catch {}
    });
  '
}

find_tab() { # find_tab <workspace> <label>
  tabs_in "$1" 2>/dev/null | awk -F'\t' -v want="$2" '$2 == want { print $1; exit }'
}

# Panes in a tab, with the agent kind hosted there ("-" when it is a bare shell).
panes_in_tab() {
  local ws="$1" tab="$2"
  herdr pane list --workspace "$ws" 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        for (const p of JSON.parse(s).result?.panes ?? []) {
          if (process.argv[1] && p.tab_id !== process.argv[1]) continue;
          console.log(`${p.pane_id}\t${p.agent || "-"}\t${p.agent_status || ""}`);
        }
      } catch {}
    });
  ' "$tab"
}

# ensure_agent_tab <workspace> <label> <agent-kind> <name>
#
# Creates the tab if missing, then makes sure a live agent of the right kind is
# hosted in one of its panes. A tab that already holds a pi agent is left alone:
# starting a second agent in the same pane would replace the operator's session,
# and `agent start` refuses a pane that is not at a shell prompt anyway.
ensure_agent_tab() {
  local ws="$1" label="$2" kind="$3" name="$4" tab_id panes pane agent

  tab_id="$(find_tab "$ws" "$label")"
  if [ -z "$tab_id" ]; then
    if [ "${DRY_RUN:-0}" = 1 ]; then
      dryrun "herdr tab create --workspace $ws --label $label --cwd $OVERLORD_DIR --no-focus"
      dryrun "herdr agent start $name --kind $kind --pane <new pane>"
      return 0
    fi
    local out
    out="$(herdr tab create --workspace "$ws" --label "$label" --cwd "$OVERLORD_DIR" --no-focus 2>&1)"
    tab_id="$(printf '%s' "$out" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { process.stdout.write(JSON.parse(s).result.tab.tab_id); } catch {}
      });
    ' 2>/dev/null)"
    if [ -z "$tab_id" ]; then
      warn "$label: could not create tab"
      printf '%s\n' "$out" | head -2 | sed 's/^/    /'
      return 1
    fi
    info "$label: created tab $tab_id"
  else
    info "$label: tab $tab_id already exists"
  fi

  panes="$(panes_in_tab "$ws" "$tab_id")"
  if printf '%s\n' "$panes" | awk -F'\t' '$2 != "-" { found=1 } END { exit !found }'; then
    agent="$(printf '%s\n' "$panes" | awk -F'\t' '$2 != "-" { print $2; exit }')"
    info "$label: already hosts a $agent agent — leaving it alone"
    return 0
  fi

  pane="$(printf '%s\n' "$panes" | awk -F'\t' 'NR==1 { print $1; exit }')"
  if [ -z "$pane" ]; then
    warn "$label: tab $tab_id has no pane to host the agent"
    return 1
  fi

  if [ "${DRY_RUN:-0}" = 1 ]; then
    dryrun "herdr agent start $name --kind $kind --pane $pane"
    return 0
  fi

  # After creating a tab herdr is still spinning up the shell; starting the
  # agent before the prompt exists fails with agent_not_ready.
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if herdr agent start "$name" --kind "$kind" --pane "$pane" >/dev/null 2>&1; then
      info "$label: started $kind agent '$name' in $pane"
      return 0
    fi
    sleep 2
  done

  warn "$label: could not start $kind in $pane yet"
  info "  run it by hand when the pane is at a prompt:"
  info "    herdr agent start $name --kind $kind --pane $pane"
  return 1
}

install_tabs() {
  local ws="$1"
  step "Overlord agent tabs"
  if ! have herdr; then
    warn "herdr not installed — skipping tabs"
    return 0
  fi
  if ! needs_herdr_server; then
    warn "no herdr server is running — skipping tabs"
    info "  start one with: herdr        (then re-run: ./install.sh overlord)"
    return 0
  fi
  if [ -z "$ws" ]; then
    # Distinct from "the operator has no space yet": without a server there was
    # nothing to look up, and install_workspace already explained that. Reporting
    # a failure here would make a first install on a headless box look broken.
    if ! needs_herdr_server; then
      info "tabs: skipped (no herdr server)"
      return 0
    fi
    warn "no overlord workspace — skipping tabs"
    info "  re-run this stage once the workspace exists"
    return 1
  fi

  local failed=0
  # `overlord` hosts the orchestrator: the agent that reads this directory's
  # AGENTS.md and directs the other spaces.
  ensure_agent_tab "$ws" overlord pi overlord || failed=$((failed + 1))
  # `comms` hosts the operator-facing channel: Discord, Telegram, IRC, email and
  # SMS, driven through the mycord skills.
  ensure_agent_tab "$ws" comms pi comms || failed=$((failed + 1))
  return $failed
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
    info "  install it: curl -fsSL https://herdr.dev/install.sh | sh"
    return 0
  fi
  if ! needs_herdr_server; then
    warn "no herdr server is running — cannot inspect or create workspaces"
    info "  start one with: herdr        (then re-run: ./install.sh overlord)"
    info "  the context directory and its docs were still installed"
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
  if ! needs_herdr_server; then
    printf '%s--%s    %-24s no herdr server running (cannot check the space or tabs)\n' \
      "$C_DIM" "$C_RESET" "overlord-space"
    return $rc
  fi

  local id; id="$(find_overlord_workspace || true)"
  if [ -n "$id" ]; then
    printf '%sok%s    %-24s workspace '%s' = %s\n' "$C_GREEN" "$C_RESET" "overlord-space" "$OVERLORD_LABEL" "$id"
  else
    printf '%smiss%s  %-24s no workspace labelled '%s'\n' "$C_YELLOW" "$C_RESET" "overlord-space" "$OVERLORD_LABEL"
    return 1
  fi

  # Two agent tabs are part of the design, not decoration: `overlord` is where
  # the orchestrator runs, `comms` is the operator-facing channel.
  local role label tab pane agent kind
  for role in "overlord:overlord" "comms:comms"; do
    label="${role#*:}"
    tab="$(find_tab "$id" "$label")"
    if [ -z "$tab" ]; then
      printf '%smiss%s  %-24s no '%s' tab\n' "$C_YELLOW" "$C_RESET" "overlord-tab:$label" "$label"
      rc=1
      continue
    fi
    pane="$(panes_in_tab "$id" "$tab" | awk -F'\t' '$2 != "-" { print $1; exit }')"
    agent="$(panes_in_tab "$id" "$tab" | awk -F'\t' '$2 != "-" { print $2; exit }')"
    if [ -n "$agent" ]; then
      printf '%sok%s    %-24s tab %s hosts a %s agent (%s)\n' "$C_GREEN" "$C_RESET" "overlord-tab:$label" "$tab" "$agent" "$pane"
    else
      printf '%swarn%s  %-24s tab %s has no agent\n' "$C_YELLOW" "$C_RESET" "overlord-tab:$label" "$tab"
      rc=1
    fi
  done
  return $rc
}

cmd_install() {
  install_dir
  install_workspace
  local ws
  ws="$(find_overlord_workspace || true)"
  install_tabs "$ws"
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
