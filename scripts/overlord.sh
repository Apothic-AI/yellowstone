#!/usr/bin/env bash
# overlord.sh — set up the overlord space and its context directory.
#
#   overlord.sh install   create ~/.overlord, install AGENTS.md/README.md,
#                         create the `overlord` and `sysops` herdr workspaces if
#                         absent, then ensure their agent tabs
#   overlord.sh status    does the directory, the spaces, and the tabs exist
#
# Two spaces ship by default:
#
#   overlord  tab:  "overlord" (pi)
#             the parent orchestrator, cwd ~/.overlord
#   sysops    tab:  "sysop-leader" (pi)
#             machine and service operations, separate from project orchestration
#
# Each space is looked up by label before creation: `herdr workspace create` does
# not deduplicate, and two spaces with the same name split attention silently.
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

# The second default space. `sysops` is deliberately separate from `overlord`:
# machine operations (host config, disks, services, network) are a different job
# from coordinating project agents, and mixing them puts ops noise in the
# orchestrator's context.
SYSOPS_LABEL="${SYSOPS_WORKSPACE_LABEL:-sysops}"
SYSOPS_TAB="${SYSOPS_TAB_LABEL:-sysop-leader}"

# $OVERLORD_DIR and $SYSOPS_DIR are the destinations of home/.overlord and of an
# empty directory respectively; both are declared in scripts/lib.sh beside every
# other destination, so this script does not re-derive them.

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

find_sysops_workspace() {
  workspaces 2>/dev/null | awk -F'\t' -v want="$SYSOPS_LABEL" '$2 == want { print $1; exit }'
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

find_tab() { # find_tab <workspace> <label> — exact label match
  tabs_in "$1" 2>/dev/null | awk -F'\t' -v want="$2" '$2 == want { print $1; exit }'
}

# find_tab_lenient <workspace> <label>
#
# A tab's label belongs to the operator and gets renamed in practice:
# `sysop-leader` became `sysops-leader`, `flyio-migration` became `cost-control`.
# Reporting a healthy system as broken because a human renamed a tab is worse
# than useless, so this matches labels loosely and lets the caller print the
# label it actually found.
#
# The normalization lowercases, strips non-alphanumerics, and then drops every
# "s", so `sysop-leader` == `sysops-leader` == `sysop_leader`, and `overlord` ==
# `overlords`. Dropping all "s" is deliberately crude: this only ever *finds* an
# existing tab (never creates, renames, or closes one) and prefers a tab that
# hosts an agent, so a false match costs a misread status line, not a wrong
# mutation.
_norm_label() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]' | tr -d 's'; }

find_tab_lenient() {
  local ws="$1" want_slug
  want_slug="$(_norm_label "$2")"
  local id label host
  while IFS=$'\t' read -r id label; do
    [ -n "$id" ] || continue
    [ "$(_norm_label "$label")" = "$want_slug" ] || continue
    host="$(panes_in_tab "$ws" "$id" | awk -F'\t' '$2 != "-"' | head -1)"
    printf '%s\t%s\t%s\n' "$id" "$label" "${host:+yes}"
  done < <(tabs_in "$ws") | sort -t$'\t' -k3,3r | head -1 | cut -f1
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
  local ws="$1" label="$2" kind="$3" name="$4" cwd="${5:-$OVERLORD_DIR}" tab_id panes pane agent

  tab_id="$(find_tab_lenient "$ws" "$label" || true)"
  if [ -z "$tab_id" ]; then
    if [ "${DRY_RUN:-0}" = 1 ]; then
      dryrun "herdr tab create --workspace $ws --label $label --cwd $cwd --no-focus"
      dryrun "herdr agent start $name --kind $kind --pane <new pane>"
      return 0
    fi
    local out
    out="$(herdr tab create --workspace "$ws" --label "$label" --cwd "$cwd" --no-focus 2>&1)"
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
  step "Agent tabs"
  if ! have herdr; then
    warn "herdr not installed — skipping tabs"
    return 0
  fi
  if ! needs_herdr_server; then
    warn "no herdr server is running — skipping tabs"
    info "  start one with: herdr        (then re-run: ./install.sh overlord)"
    return 0
  fi

  local failed=0 over sys

  over="$(find_overlord_workspace || true)"
  if [ -z "$over" ]; then
    warn "no '$OVERLORD_LABEL' workspace — skipping its tabs"
    failed=$((failed + 1))
  else
    # One tab: this space hosts the orchestrator. The operator-facing channel is
    # NOT a tab here — it is its own space, with its own cwd and its own leader
    # lane, and creating a "comms" tab in this workspace would put a second agent
    # on the same channels under a second identity. An older version of this
    # script did exactly that, so a machine installed from it may still have one.
    ensure_agent_tab "$over" overlord pi overlord "$OVERLORD_DIR" || failed=$((failed + 1))
  fi

  sys="$(find_sysops_workspace || true)"
  if [ -z "$sys" ]; then
    warn "no '$SYSOPS_LABEL' workspace — skipping its tab"
    failed=$((failed + 1))
  else
    ensure_agent_tab "$sys" "$SYSOPS_TAB" pi "$SYSOPS_TAB" "$SYSOPS_DIR" || failed=$((failed + 1))
  fi

  return $failed
}

install_dir() {
  step "Overlord context directory"

  # ~/.sysops is created and left empty: nothing is shipped for it, which is why
  # it appears in home_generated_dirs() rather than under home/.
  if [ "${DRY_RUN:-0}" = 1 ]; then
    dryrun "mkdir -p $(short "$OVERLORD_DIR") $(short "$SYSOPS_DIR")"
  else
    mkdir -p -- "$OVERLORD_DIR" "$SYSOPS_DIR"
  fi

  # home/.overlord is the literal mirror of $OVERLORD_DIR, and both files are
  # policy-bound in scripts/lib.sh rather than special-cased here:
  #
  #   AGENTS.md  a *template* of the role. An operator's live copy accretes state
  #              that must not be lost — reservations keyed to tab ids, tool
  #              paths, per-lane history — so it is installed once and drift is
  #              reported rather than replaced.
  #   README.md  the live workspace index, which the operator updates as spaces
  #              come and go. Never overwritten: it is the only map.
  install_home_tree .overlord
}

# ensure_workspace <label> <cwd> — create the workspace only when the label is
# absent. `herdr workspace create` does not deduplicate by label or cwd (verified:
# identical arguments produced two workspaces), so a blind create splits attention
# between two spaces with the same name and no diagnostic.
ensure_workspace() {
  local label="$1" dir="$2"

  if ! have herdr; then
    warn "herdr not installed — skipping workspace '$label'"
    info "  install it: curl -fsSL https://herdr.dev/install.sh | sh"
    return 0
  fi
  if ! needs_herdr_server; then
    warn "no herdr server is running — cannot inspect or create workspace '$label'"
    info "  start one with: herdr        (then re-run: ./install.sh overlord)"
    return 0
  fi

  local existing
  existing="$(workspaces 2>/dev/null | awk -F'\t' -v want="$label" '$2 == want { print $1; exit }' || true)"

  if [ -n "$existing" ]; then
    info "workspace '$label' already exists ($existing) — not creating another"
    if [ -d "$dir" ]; then
      info "  its cwd is whatever the operator set; this script does not move it"
    fi
    return 0
  fi

  if [ "${DRY_RUN:-0}" = 1 ]; then
    dryrun "herdr workspace create --cwd $dir --label $label --no-focus"
    return 0
  fi

  local out id
  out="$(herdr workspace create --cwd "$dir" --label "$label" --no-focus 2>&1)"
  id="$(printf '%s' "$out" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.stdout.write(JSON.parse(s).result.workspace.workspace_id); } catch {}
    });
  ' 2>/dev/null)"

  if [ -n "$id" ]; then
    info "created workspace '$label' ($id) at $(short "$dir")"
  else
    warn "workspace create failed for '$label'; run it by hand:"
    info "  herdr workspace create --cwd $(short "$dir") --label $label"
    printf '%s\n' "$out" | head -3 | sed 's/^/    /'
    return 1
  fi
}

install_workspace() {
  step "Herdr spaces"
  ensure_workspace "$OVERLORD_LABEL" "$OVERLORD_DIR"
  ensure_workspace "$SYSOPS_LABEL" "$SYSOPS_DIR"
  return 0
}

cmd_status() {
  local rc=0

  if ! have herdr; then
    printf '%s--%s    %-24s herdr not installed\n' "$C_DIM" "$C_RESET" "spaces"
  elif ! needs_herdr_server; then
    printf '%s--%s    %-24s no herdr server running (cannot check spaces or tabs)\n' \
      "$C_DIM" "$C_RESET" "spaces"
  fi

  # Both default spaces, each with the tabs it is supposed to host.
  local spec name rest label dir tabs_csv wsid tab pane agent
  for spec in "overlord:$OVERLORD_LABEL:$OVERLORD_DIR:overlord" \
              "sysops:$SYSOPS_LABEL:$SYSOPS_DIR:$SYSOPS_TAB"; do
    name="${spec%%:*}"
    rest="${spec#*:}"
    label="${rest%%:*}"
    rest="${rest#*:}"
    dir="${rest%%:*}"
    tabs_csv="${rest#*:}"

    if [ -d "$dir" ]; then
      printf '%sok%s    %-24s present at %s\n' "$C_GREEN" "$C_RESET" "$name-dir" "$(short "$dir")"
      if [ "$name" = overlord ] && [ -L "$HOME/.agent-context" ]; then
        printf '%s--%s    %-24s legacy path is a symlink to %s\n' \
          "$C_DIM" "$C_RESET" "overlord-legacy" "$(readlink -f "$HOME/.agent-context")"
      fi
    else
      printf '%smiss%s  %-24s %s does not exist\n' "$C_YELLOW" "$C_RESET" "$name-dir" "$(short "$dir")"
      rc=1
    fi

    wsid="$(workspaces 2>/dev/null | awk -F'\t' -v want="$label" '$2 == want { print $1; exit }' || true)"
    if [ -z "$wsid" ]; then
      printf '%smiss%s  %-24s no workspace labelled '%s'\n' "$C_YELLOW" "$C_RESET" "$name-space" "$label"
      rc=1
      continue
    fi
    printf '%sok%s    %-24s workspace '%s' = %s\n' "$C_GREEN" "$C_RESET" "$name-space" "$label" "$wsid"

    # Report every tab this script did not provision. A hand-made tab that is
    # nearly the same name (sysop-lead beside sysop-leader) is how an operator
    # ends up driving the wrong pane, and half-clever prefix matching misses
    # it in either direction. Listing the extras is honest and catches both.
    local known t extra=""
    known="$(tabs_in "$wsid" | awk -F'\t' '{print $2}' | sort -u)"
    while IFS= read -r t; do
      [ -n "$t" ] || continue
      case " $tabs_csv " in
        *" $t "*) continue ;;
      esac
      extra="$extra${extra:+, }$t"
    done <<< "$known"
    if [ -n "$extra" ]; then
      printf '%s--%s    %-24s other tabs present (not provisioned here): %s\n' \
        "$C_DIM" "$C_RESET" "$name-extra" "$extra"
    fi

    for t in $tabs_csv; do
      other="$(printf '%s\n' "$known" | while IFS= read -r cand; do
        case "$cand" in
          "$t") : ;;
          "$t"-*|"$t"s|"$t"-s) printf '%s\n' "$cand" ;;
        esac
      done | head -1)"
      if [ -n "$other" ]; then
        printf '%s--%s    %-24s also has a similar tab '%s' — not created by this script\n' \
          "$C_DIM" "$C_RESET" "$name-extra" "$other"
      fi
    done

    for t in $tabs_csv; do
      tab="$(find_tab_lenient "$wsid" "$t" || true)"
      if [ -z "$tab" ]; then
        printf '%smiss%s  %-24s no '%s' tab in %s\n' "$C_YELLOW" "$C_RESET" "$name-tab:$t" "$t" "$label"
        rc=1
        continue
      fi
      agent="$(panes_in_tab "$wsid" "$tab" | awk -F'\t' '$2 != "-" { print $2; exit }')"
      pane="$(panes_in_tab "$wsid" "$tab" | awk -F'\t' '$2 != "-" { print $1; exit }')"
      actual_label="$(tabs_in "$wsid" | awk -F'\t' -v id="$tab" '$1 == id { print $2; exit }')"
      if [ -n "$agent" ]; then
        printf '%sok%s    %-24s tab %s (%s) hosts a %s agent (%s)\n' "$C_GREEN" "$C_RESET" "$name-tab:$t" "$tab" "$actual_label" "$agent" "$pane"
      else
        printf '%swarn%s  %-24s tab %s has no agent\n' "$C_YELLOW" "$C_RESET" "$name-tab:$t" "$tab"
        rc=1
      fi
    done
  done
  return $rc
}

cmd_install() {
  install_dir
  install_workspace
  install_tabs
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
