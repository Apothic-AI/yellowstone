#!/usr/bin/env bash
# doctor.sh — report what Yellowstone has on this machine, and what is behind.
#
# Read-only. Exit 0 when the stack is complete, 1 when something is missing or
# outdated (so it can gate a cron job or a provisioning step).
#
#   ./scripts/doctor.sh            human-readable report
#   ./scripts/doctor.sh --json     machine-readable
#   ./scripts/doctor.sh --quiet    exit status only

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE=text
case "${1:-}" in
  --json) MODE=json ;;
  --quiet) MODE=quiet ;;
  --help|-h) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  '') : ;;
  *) die "unknown option: $1 (try --json, --quiet, --help)" ;;
esac

# Inspect exactly the agent directory whose files we read below. Without this,
# `pi list` would answer for the real ~/.pi/agent while setting PI_CODING_AGENT_DIR
# (or running under a different HOME) pointed the file checks somewhere else —
# and a report that mixes two directories is worse than no report.
export PI_CODING_AGENT_DIR="$PI_DIR"

FINDINGS=()      # human lines, also the JSON body
PROBLEMS=0

record() {  # record <status: ok|warn|fail|info> <component> <detail>
  local status="$1" component="$2" detail="$3"
  if [ "$MODE" = text ]; then
    case "$status" in
      ok)   printf '%sok%s    %-26s %s\n' "$C_GREEN"  "$C_RESET" "$component" "$detail" ;;
      warn) printf '%swarn%s  %-26s %s\n' "$C_YELLOW" "$C_RESET" "$component" "$detail" ;;
      fail) printf '%sfail%s  %-26s %s\n' "$C_RED"    "$C_RESET" "$component" "$detail" ;;
      info) printf '%s--%s    %-26s %s\n' "$C_DIM"    "$C_RESET" "$component" "$detail" ;;
    esac
  fi
  case "$status" in
    warn|fail) PROBLEMS=$((PROBLEMS + 1)) ;;
  esac
  FINDINGS+=("$status|$component|$detail")
}

section() { [ "$MODE" = text ] && printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"; return 0; }

# Compare two version strings; echoes "newer", "equal" or "older" for $1 vs $2.
vercmp() {
  if [ "$1" = "$2" ]; then printf 'equal\n'; return 0; fi
  if [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]; then
    printf 'newer\n'
  else
    printf 'older\n'
  fi
}

# --------------------------------------------------------------- prerequisites
section "Prerequisites"

if have node; then
  NODE_V="$(node --version | sed 's/^v//')"
  if [ "$(vercmp "$NODE_V" "22.19.0")" = "older" ]; then
    record fail node "$NODE_V — need >= 22.19"
  else
    record ok node "$NODE_V"
  fi
else
  record fail node "not found (pi requires >= 22.19)"
fi

for tool in git python3; do
  if have "$tool"; then record ok "$tool" "$(command -v "$tool")"
  else record warn "$tool" "not found (needed by some plugins/skills)"; fi
done

# ------------------------------------------------------------------- herdr
section "Herdr"

if ! have herdr; then
  record fail herdr "not installed — curl -fsSL https://herdr.dev/install.sh | sh"
else
  HVER="$(herdr --version 2>/dev/null | awk '{print $2}')"
  record ok herdr "$HVER (channel $(herdr channel show 2>/dev/null || echo unknown))"

  # A stale server does not pick up a new binary until it restarts.
  if herdr status 2>/dev/null | grep -q 'restart_needed: yes'; then
    record warn herdr-server "binary updated; 'herdr server stop' then reattach to load it"
  fi
  if herdr status 2>/dev/null | grep -q 'server_binary_stale: yes'; then
    record warn herdr-server "server binary is stale — reattach or: herdr server stop"
  fi

  # config.toml
  if [ -e "$HERDR_DIR/config.toml" ]; then
    if herdr config check >/dev/null 2>&1; then
      if cmp -s "$REPO_ROOT/herdr/config.toml" "$HERDR_DIR/config.toml"; then
        record ok herdr-config "in sync with repo"
      else
        record warn herdr-config "differs from repo — review: diff $(short "$REPO_ROOT/herdr/config.toml") $(short "$HERDR_DIR/config.toml")"
      fi
    else
      record fail herdr-config "config.toml fails 'herdr config check'"
    fi
  else
    record fail herdr-config "missing $(short "$HERDR_DIR/config.toml")"
  fi

  # plugins declared in the manifest
  if command -v "$REPO_ROOT/scripts/herdr-plugins.sh" >/dev/null 2>&1 || [ -x "$REPO_ROOT/scripts/herdr-plugins.sh" ]; then
    local_rows="$(node "$REPO_ROOT/scripts/plugins-manifest.js" rows "$REPO_ROOT/herdr/plugins.toml")"
    present="$(herdr plugin list --json 2>/dev/null | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { for (const p of JSON.parse(s).result?.plugins ?? []) console.log(p.plugin_id); } catch {}
      });
    ')"
    while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
      [ -n "$id" ] || continue
      if printf '%s\n' "$present" | grep -qx -- "$id"; then
        record ok "plugin:$id" "installed"
      elif [ "$optional" = "true" ]; then
        record info "plugin:$id" "not installed (optional)"
      else
        record fail "plugin:$id" "missing — run scripts/herdr-plugins.sh install"
      fi
    done <<< "$local_rows"
  fi

  # agent integrations: these are what put live state in the sidebar
  if have herdr; then
    integrations="$(herdr integration status 2>/dev/null || true)"
    for agent in pi droid opencode agy grok claude codex; do
      line="$(printf '%s\n' "$integrations" | grep -E "^$agent(:| \()" | head -n1 || true)"
      [ -n "$line" ] || continue
      case "$line" in
        *current*)  record ok "integration:$agent" "current" ;;
        *outdated*) record warn "integration:$agent" "outdated — herdr integration install $agent" ;;
        *"not installed"*) record info "integration:$agent" "not installed" ;;
        *)          record info "integration:$agent" "$line" ;;
      esac
    done
  fi
fi

# ---------------------------------------------------------------------- pi
section "Pi"

if ! have pi; then
  record fail pi "not installed — curl -fsSL https://pi.dev/install.sh | sh"
else
  record ok pi "$(version_of pi)"

  if [ -f "$PI_DIR/settings.json" ]; then
    if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$PI_DIR/settings.json" 2>/dev/null; then
      record ok pi-settings "$(short "$PI_DIR/settings.json") parses"
    else
      record fail pi-settings "$(short "$PI_DIR/settings.json") is not valid JSON"
    fi
    # Are the declared packages actually installed? `pi list` prints the
    # resolved source of every package it loaded, one per indented line, so
    # compare against that rather than guessing at install paths.
    declared="$(node -e '
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const p of s.packages || []) {
        const src = typeof p === "string" ? p : p.source;
        if (src) console.log(src);
      }
    ' "$PI_DIR/settings.json" 2>/dev/null)"
    if listed="$(pi list 2>/dev/null)"; then
      missing_pkgs=""
      while IFS= read -r want; do
        [ -n "$want" ] || continue
        # pi annotates filtered entries with " (filtered)"; match on the source.
        if ! printf '%s\n' "$listed" | sed 's/ (filtered)$//' | sed 's/^  //' | grep -Fxq -- "$want"; then
          missing_pkgs="${missing_pkgs}${want} "
        fi
      done <<< "$declared"
      if [ -z "$missing_pkgs" ]; then
        record ok pi-packages "all $(printf '%s\n' "$declared" | grep -c .) declared packages loaded"
      else
        record warn pi-packages "not loaded: ${missing_pkgs}— run: pi update --extensions"
      fi

      # pi-goal is served from our fork, not npm. The failure this guards is
      # quiet: reinstalling the npm package restores a code path that emits the
      # experimental-goals notice on every session start, and nothing else
      # would report the swap — `pi list` would just say it loaded pi-goal.
      goal_fork="$HOME/Code/pi-extensions-apothic/packages/pi-goal"
      goal_entry="$(printf '%s\n' "$declared" | grep -i 'pi-goal' | head -n1)"
      if [ -z "$goal_entry" ]; then
        record info pi-goal "not declared in settings"
      elif [ "$goal_entry" = "$goal_fork" ]; then
        record ok pi-goal "fork (local path)"
      elif [ "$goal_entry" != "${goal_entry#npm:}" ] || ! [ -d "$goal_entry" ]; then
        record warn pi-goal "served from $goal_entry — the fork is $goal_fork (see docs/forks.md)"
      fi
    else
      record info pi-packages "could not run 'pi list'"
    fi
  else
    record fail pi-settings "missing $(short "$PI_DIR/settings.json") — run ./install.sh pi"
  fi

  if [ -f "$PI_DIR/models.json" ]; then
    record ok pi-models "$(node -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const p = Object.keys(m.providers || {});
      const n = p.reduce((a, k) => a + (m.providers[k].models || []).length, 0);
      process.stdout.write(`${p.length} providers, ${n} models`);
    ' "$PI_DIR/models.json" 2>/dev/null || echo unparseable)"
  else
    record warn pi-models "missing $(short "$PI_DIR/models.json") — run ./install.sh pi"
  fi

  # credentials: check that every provider needing a file has a non-empty one.
  # Skipped (not "ok") when there is no models.json — otherwise a machine with no
  # config would report a clean credential check it never performed.
  missing_secrets=""
  have_secrets_check=0
  if [ -f "$PI_DIR/models.json" ]; then
    have_secrets_check=1
    missing_secrets="$(node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const dir = process.argv[2];
      for (const [id, p] of Object.entries(m.providers || {})) {
        const k = p && p.apiKey;
        if (typeof k !== "string" || !k.startsWith("!")) continue;
        const mm = k.match(/secrets\/([A-Za-z0-9._-]+)/);
        if (!mm) continue;
        const f = path.join(dir, mm[1]);
        if (!fs.existsSync(f) || fs.statSync(f).size === 0) console.log(id);
      }
    ' "$PI_DIR/models.json" "$PI_DIR/secrets" 2>/dev/null)"
  fi
  if [ "$have_secrets_check" = 1 ]; then
    if [ -z "$missing_secrets" ]; then
      record ok pi-secrets "every provider has a credential file"
    else
      record warn pi-secrets "empty/missing key for: $(printf '%s' "$missing_secrets" | tr '\n' ' ')"
    fi
  fi

  # does the default route actually authenticate? this is the one check that
  # catches a stale key rather than a missing one.
  if [ -f "$PI_DIR/settings.json" ]; then
    provider="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.defaultProvider||"")' "$PI_DIR/settings.json" 2>/dev/null)"
    if [ -n "$provider" ]; then
      if out="$(pi auth check --provider "$provider" --json 2>/dev/null)"; then
        record ok pi-auth "$provider: $(printf '%s' "$out" | node -e '
          let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.status||"unknown")}catch{process.stdout.write("unparseable")}})')"
      else
        record warn pi-auth "$provider: check failed — pi auth check --provider $provider --json"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- skills
section "Agent skills"

# The manifest decides what should be installed and from where; this just
# reports whether the installed set matches it, using the same resolver the
# installer uses.
if [ -x "$REPO_ROOT/scripts/skills-sync.sh" ]; then
  skills_report="$(NO_COLOR=1 "$REPO_ROOT/scripts/skills-sync.sh" status 2>/dev/null || true)"
  if [ -n "$skills_report" ]; then
    while IFS= read -r line; do
      case "$line" in
        linked*)   record ok   "skill:$(printf '%s' "$line" | awk '{print $2}')" "linked to its owning tree" ;;
        present*)  record warn "skill:$(printf '%s' "$line" | awk '{print $2}')" "a real directory, not a link — run install.sh skills" ;;
        missing*)  record fail "skill:$(printf '%s' "$line" | awk '{print $2}')" "missing — run ./install.sh skills" ;;
        "")  : ;;
        *bundle*)  : ;;   # the debt summary line, not a skill
        *)         record info skill "$line" ;;
      esac
    done <<< "$skills_report"

    # Bundled skills are debt, not a fault: they are skills with no installable
    # home yet. Count them from the manifests's own rows (the status output also
    # contains a summary line that mentions "bundle", which would double-count).
    bundles="$(grep -vE '^[[:space:]]*(#|$)' "$REPO_ROOT/skills/skills.tsv" 2>/dev/null \
               | awk -F'\t' '$2 == "bundle"' | wc -l)"
    if [ "${bundles:-0}" -gt 0 ]; then
      record info skills-bundled \
        "$bundles bundled because no repo ships them yet (see skills/skills.tsv)"
    fi
  fi
else
  record warn skills "scripts/skills-sync.sh is missing"
fi

# The non-blocking guard: opt-in, and worth surfacing because its absence is
# invisible until a turn blocks and queues an operator message behind it.
if [ -f "$PI_DIR/extensions/nonblock.ts" ]; then
  nb_state="installed, disabled"
  if [ "${PI_NONBLOCK:-}" = "1" ]; then
    nb_state="installed, enabled (PI_NONBLOCK=1)"
  elif [ -f "$PI_DIR/nonblock.json" ] && grep -q '"enabled"[[:space:]]*:[[:space:]]*true' "$PI_DIR/nonblock.json" 2>/dev/null; then
    nb_state="installed, enabled"
  fi
  record info nonblock "$nb_state"
else
  record info nonblock "not installed (./install.sh pi)"
fi

# The shared agent instructions at $HOME.
if [ -f "$HOME/AGENTS.md" ]; then
  if cmp -s "$REPO_ROOT/AGENTS.md" "$HOME/AGENTS.md"; then
    record ok agents-md "in sync with repo"
  else
    record warn agents-md "differs from repo — review: diff $(short "$REPO_ROOT/AGENTS.md") ~/AGENTS.md"
  fi
else
  record warn agents-md "missing ~/AGENTS.md — run ./install.sh agents"
fi

# The overlord space: directory + the herdr workspace whose cwd is that directory.
if [ -x "$REPO_ROOT/scripts/overlord.sh" ]; then
  ol_report="$(NO_COLOR=1 "$REPO_ROOT/scripts/overlord.sh" status 2>/dev/null || true)"
  while IFS= read -r line; do
    # overlord.sh already prints "<status> <component> <detail>": take the
    # component as field 2 and the detail from field 4 on.
    ostatus="$(printf '%s' "$line" | awk '{print $1}')"
    ocomp="$(printf '%s' "$line" | awk '{print $2}')"
    odetail="$(printf '%s' "$line" | awk '{for(i=3;i<=NF;i++) printf "%s%s", $i, (i<NF?" ":"")}')"
    case "$ostatus" in
      ok)   record ok   "$ocomp" "$odetail" ;;
      miss) record fail "$ocomp" "$odetail" ;;
      --)   record info "$ocomp" "$odetail" ;;
      "")   : ;;
      *)    record info overlord "$line" ;;
    esac
  done <<< "$ol_report"
else
  record warn overlord "scripts/overlord.sh is missing"
fi

if [ -x "$LOCAL_BIN/herdr-agy.sh" ]; then
  record ok herdr-agy "$(short "$LOCAL_BIN/herdr-agy.sh")"
else
  record info herdr-agy "not installed (optional; needed for agy/grok wait reliability)"
fi

# --------------------------------------------------------------- updates
section "Updates available"

if have herdr && [ "$(vercmp "$(herdr --version 2>/dev/null | awk '{print $2}')" "0.0.0")" != "older" ]; then
  # `herdr update` has no dry-run; ask the release channel instead.
  latest="$(curl -fsSL --max-time 6 https://api.github.com/repos/herdrdev/herdr/releases/latest 2>/dev/null \
            | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tag_name.replace(/^v/,""))}catch{}})')"
  cur="$(herdr --version 2>/dev/null | awk '{print $2}')"
  if [ -z "$latest" ]; then
    record info herdr-update "could not reach GitHub to compare versions"
  elif [ "$(vercmp "$cur" "$latest")" = "older" ]; then
    record warn herdr-update "$cur -> $latest (herdr update)"
  else
    record ok herdr-update "current ($cur)"
  fi
fi

if have pi; then
  latest_pi="$(npm view @earendil-works/pi-coding-agent version 2>/dev/null || true)"
  cur_pi="$(pi --version 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$latest_pi" ]; then
    record info pi-update "could not reach npm to compare versions"
  elif [ "$(vercmp "$cur_pi" "$latest_pi")" = "older" ]; then
    record warn pi-update "$cur_pi -> $latest_pi (pi update)"
  else
    record ok pi-update "current ($cur_pi)"
  fi
fi

if have dagr; then
  record ok dagr "$(dagr --version 2>/dev/null | head -n1)"
else
  record info dagr "not on PATH (comes with the herdr-dagr plugin)"
fi

# --------------------------------------------------------------- summary
if [ "$MODE" = json ]; then
  printf '%s\n' "${FINDINGS[@]}" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const findings = s.trim().split("\n").filter(Boolean).map((l) => {
        const [status, component, ...rest] = l.split("|");
        return { status, component, detail: rest.join("|") };
      });
      process.stdout.write(JSON.stringify({ ok: findings.every((f) => f.status !== "fail"), findings }, null, 2) + "\n");
    });
  '
elif [ "$MODE" = text ]; then
  printf '\n'
  if [ "$PROBLEMS" = 0 ]; then
    printf '%sAll checks passed.%s\n' "$C_GREEN" "$C_RESET"
  else
    printf '%s%d check(s) need attention.%s\n' "$C_YELLOW" "$PROBLEMS" "$C_RESET"
  fi
fi

[ "$PROBLEMS" = 0 ] || exit 1
exit 0
