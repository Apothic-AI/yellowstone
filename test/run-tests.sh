#!/usr/bin/env bash
# run-tests.sh — exercise the Yellowstone installer in a throwaway HOME.
#
# Suites (pass one as $1, default "all"):
#   smoke     syntax, JSON, frontmatter, manifest parsing. No writes.
#   install   install.sh from scratch, then verify what landed.
#   idempotent re-run install.sh and assert nothing changes (byte-for-byte).
#   partial   install on a machine with pre-existing config: assert the
#             installer adds and never overwrites.
#   failures  no herdr / no pi / no network: assert clean, explained failures.
#   all       everything
#
# Every suite that writes runs against a fresh HOME under $SANDBOX, so the real
# HOME inside the container is only used for the tools themselves.

set -uo pipefail

REPO="${REPO:-/repo}"
SANDBOX="${SANDBOX:-/home/tester/sandbox}"
SUITE="${1:-all}"

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
[ -t 1 ] || { GREEN=''; RED=''; YELLOW=''; DIM=''; RESET=''; }

PASS=0; FAIL=0; FAILED_NAMES=()
CURRENT_SUITE=""

suite()   { CURRENT_SUITE="$1"; printf '\n%s== %s ==%s\n' "$DIM" "$1" "$RESET"; }
ok()      { PASS=$((PASS+1)); printf '  %sok%s   %s\n' "$GREEN" "$RESET" "$1"; }
bad()     { FAIL=$((FAIL+1)); FAILED_NAMES+=("[$CURRENT_SUITE] $1"); printf '  %sfail%s %s\n     %s\n' "$RED" "$RESET" "$1" "${2:-}"; }
check()   { # check <desc> <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc" "command failed: $*"; fi
}
check_eq() { # check_eq <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$2', got '$3'"; fi
}
check_ne() { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1" "expected anything but '$2'"; fi }
check_contains() { # check_contains <desc> <haystack> <needle>
  case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "missing '$3' in: $(printf '%s' "$2" | head -c 300)" ;; esac
}

new_home() {
  # Split the declarations: `local a="$1" b="$SANDBOX/$a"` expands $a before it
  # is set (bash creates every name in the local list first), which under
  # `set -u` is an unbound-variable error.
  local name="$1"
  local dir="$SANDBOX/$name"
  rm -rf "$dir"
  mkdir -p "$dir/.pi/agent" "$dir/.config" "$dir/.agents/skills" "$dir/.local/bin"
  printf '%s\n' "$dir"
}

# Run a script with HOME pointed at a sandbox, without the sandbox leaking into
# the caller. Keeps PATH so the real herdr/pi binaries are used.
in_home() {
  local home="$1"; shift
  HOME="$home" \
  XDG_CONFIG_HOME="$home/.config" \
  HERDR_CONFIG_DIR="$home/.config/herdr" \
  PI_CODING_AGENT_DIR="$home/.pi/agent" \
  AGENTS_SKILLS_DIR="$home/.agents/skills" \
  LOCAL_BIN_DIR="$home/.local/bin" \
  YELLOWSTONE_BACKUP_DIR="$home/.local/state/yellowstone/backups" \
  NO_COLOR=1 \
    "$@"
}

# A cheap fingerprint of everything a script could have written.
#
# Excludes two kinds of churn that a re-run legitimately produces and that are
# not config: the npm cache index (rewritten on any npm invocation) and git
# bookkeeping inside package checkouts (FETCH_HEAD after `pi update`). The
# assertion that matters -- package-lock.json and every config file are
# byte-identical -- is made on the rest of the tree.
fingerprint() {
  local home="$1"
  ( cd "$home" 2>/dev/null && find . \( -type f -o -type l \) \
      -not -path './.npm/*' -not -path './.npm-global/*' -not -path './.cache/*' \
      -not -path '*/.git/*' \
      2>/dev/null | sort |
      while IFS= read -r f; do
        if [ -L "$f" ]; then printf 'L %s -> %s\n' "$f" "$(readlink "$f")"
        else printf 'F %s %s\n' "$f" "$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)"; fi
      done )
}

# ---------------------------------------------------------------- smoke ------
suite_smoke() {
  suite smoke

  local bad_syntax=0
  while IFS= read -r f; do
    bash -n "$f" 2>/dev/null || { bad_syntax=1; bad "bash syntax: $f"; }
  done < <(find "$REPO" -name '*.sh' -not -path '*/.git/*')
  [ "$bad_syntax" = 0 ] && ok "every shell script parses"

  local bad_js=0
  while IFS= read -r f; do
    node --check "$f" 2>/dev/null || { bad_js=1; bad "node syntax: $f"; }
  done < <(find "$REPO" -name '*.js' -not -path '*/.git/*' -not -path '*/node_modules/*')
  [ "$bad_js" = 0 ] && ok "every JS script parses"

  # JSON that is meant to be JSON (tsconfig may be JSONC, but none ships now)
  local bad_json=0
  while IFS= read -r f; do
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null \
      || { bad_json=1; bad "invalid JSON: $f"; }
  done < <(find "$REPO" -name '*.json' -not -path '*/.git/*')
  [ "$bad_json" = 0 ] && ok "every JSON file parses"

  # Headings must be preceded by a blank line, or they render as part of the
  # previous paragraph. A doc is read by agents, so broken shape is a defect.
  local badmd=0 f
  while IFS= read -r f; do
    if awk 'prev!="" && /^(##|###) /{found=1} {prev=$0} END{exit !found}' "$f"; then
      badmd=1; bad "heading without a preceding blank line: $f"
    fi
  done < <(find "$REPO" -name '*.md' -not -path '*/.git/*')
  [ "$badmd" = 0 ] && ok "every Markdown heading has a preceding blank line"

  # Every SKILL.md needs name + description, or hosts refuse to load it.
  local bad_skill=0
  while IFS= read -r f; do
    if ! head -1 "$f" | grep -qx -- '---'; then bad_skill=1; bad "no frontmatter: $f"; continue; fi
    grep -qE '^name: *[a-z0-9-]+$' "$f" || { bad_skill=1; bad "no name: $f"; }
    grep -qE '^description: *' "$f"   || { bad_skill=1; bad "no description: $f"; }
  done < <(find "$REPO" -name 'SKILL.md' -not -path '*/.git/*')
  [ "$bad_skill" = 0 ] && ok "every SKILL.md has valid frontmatter"

  # The skill manifest must be parseable and internally consistent.
  local manifest="$REPO/skills/skills.tsv"
  if [ -f "$manifest" ]; then
    local rows
    rows="$(grep -vE '^[[:space:]]*(#|$)' "$manifest")"
    ok "skills.tsv parses ($(printf '%s\n' "$rows" | wc -l) rows)"

    local badkind=0
    while IFS=$'\t' read -r id kind spec why; do
      [ -n "$id" ] || continue
      case "$kind" in
        repo|dagr|bundle) ;;
        *) badkind=1; bad "skills.tsv: $id has unknown kind '$kind'" ;;
      esac
      [ -n "$why" ] || bad "skills.tsv: $id has no why"
      [ "$kind" = bundle ] && [ ! -d "$REPO/${spec#./}" ] && bad "skills.tsv: $id bundle path missing: $spec"
    done <<< "$rows"
    [ "$badkind" = 0 ] && ok "skills.tsv kinds are all valid"
  else
    bad "missing skills/skills.tsv"
  fi

  # The shipped overlord docs: present, and free of any one operator's projects.
  for f in overlord/AGENTS.md overlord/README.md; do
    check "ships $f" test -f "$REPO/$f"
  done
  local leaks
  leaks="$(grep -riE 'apothic|autopod|subtoken|starla|sibyl|solid-lynx|omebian|mycord|vpn2proxy|surreal|account-management' \
           "$REPO/overlord/" 2>/dev/null | wc -l)"
  check_eq "no operator project names in the shipped overlord docs" 0 "$leaks"

  # mycord: five skills, one repository, resolved from a checkout at the repo
  # root rather than npx (which finds nothing there).
  local mycord_rows
  mycord_rows="$(grep -vE '^[[:space:]]*(#|$)' "$REPO/skills/skills.tsv" | awk -F'\t' '$3 == "Apothic-AI/mycord"')"
  # Count is derived, not asserted: the repo grows (router, Slack, Ferdium all
  # appeared later), so a hardcoded total is a test that fails for good reasons.
  local mycord_n
  mycord_n="$(printf '%s\n' "$mycord_rows" | grep -c .)"
  [ "$mycord_n" -ge 5 ] && ok "skills.tsv declares $mycord_n mycord skills" \
    || bad "skills.tsv declares only $mycord_n mycord skills (expected >=5)"
  local mycord_bad
  mycord_bad="$(printf '%s\n' "$mycord_rows" | awk -F'\t' '$2 != "repo"' | grep -c .)"
  check_eq "every mycord skill is a repo-kind skill" 0 "$mycord_bad"

  # Theme provenance: a [theme.custom] block is a derived palette, not a package.
  # Documenting it as "comes from <plugin>" is wrong unless the plugin's own
  # mapping reproduces it, so the tree must not claim a shipped source for it.
  if grep -q 'theme.custom' "$REPO/herdr/config.toml"; then
    ok "herdr ships a [theme.custom] palette (derived, not a package)"
    local misclaim
    misclaim="$(grep -riE 'palette (comes|ships) from|theme.*(shipped|packaged) (by|with) the .*plugin' \
                "$REPO"/yellowstone-skill/SKILL.md "$REPO"/docs 2>/dev/null | wc -l)"
    check_eq "docs do not claim a packaged source for the custom palette" 0 "$misclaim"
  fi
  # And the skill must name a way to verify, not just assert.
  check "skill documents verifying palette provenance" \
    grep -q 'palette_to_tokens' "$REPO/yellowstone-skill/SKILL.md"

  # The two default spaces and their tabs are a contract; assert they are taught.
  check "skill documents the overlord tab" grep -q 'sysop-leader' "$REPO/yellowstone-skill/SKILL.md"
  check "skill documents the sysops space" grep -q '\~/.sysops' "$REPO/yellowstone-skill/SKILL.md"
  check "script provisions sysops" grep -q 'SYSOPS_LABEL' "$REPO/scripts/overlord.sh"
  check "mycord router skill declared" \
    awk -F'\t' '$1=="mycord-skill" && $2=="repo" && $3=="Apothic-AI/mycord"' "$REPO/skills/skills.tsv" | grep -q .

  # The goal feature and its traps are documented, and the shipped orchestrator
  # doc carries the sections an orchestrator actually needs.
  check "skill documents pi-goal" grep -q '@signalridge/pi-goal' "$REPO/yellowstone-skill/SKILL.md"
  check "skill warns it is NOT pi-codex-goal" grep -q 'not.*pi-codex-goal' "$REPO/yellowstone-skill/SKILL.md"
  check "skill documents the Replace goal modal trap" \
    grep -q 'Replace goal' "$REPO/yellowstone-skill/SKILL.md"
  local sec
  for sec in '## Intake' '### Goal-driven lanes' '### Reserved right now'; do
    check "overlord doc carries '$sec'" grep -qF "$sec" "$REPO/overlord/AGENTS.md"
  done
  # Goal state is footer-only: the claim must stay true, or the doc is wrong.
  if command -v herdr >/dev/null 2>&1 && herdr workspace list >/dev/null 2>&1; then
    local any_pane goal_keys
    any_pane="$(herdr agent list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).result.agents||[];if(a[0])process.stdout.write(a[0].pane_id)})')"
    goal_keys="$(herdr agent get "$any_pane" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).result.agent;process.stdout.write(Object.keys(a).filter(k=>/goal/i.test(k)).join(","))}catch{}})')"
    check_eq "herdr agent API still carries no goal fields" "" "$goal_keys"
  fi

  # A tab the operator renamed must still be found: sysop-leader -> sysops-leader
  # and flyio-migration -> cost-control both happened live, and a status command
  # that calls a healthy system broken is worse than no status command.
  check "tab matching tolerates a renamed label" \
    bash -c 'grep -q "_norm_label" "'"$REPO"'/scripts/overlord.sh"'
  check "tab matching prefers a tab with an agent" \
    awk '/^find_tab_lenient/,/^}/' "$REPO/scripts/overlord.sh" | grep -q 'host'
  # Dagr run-file hygiene is documented where an operator will look for it.
  check "skill documents the closed-run archive rule" \
    grep -q 'dagr/archive' "$REPO/yellowstone-skill/SKILL.md"
  check "skill documents locator hygiene" \
    grep -q 'pane gone' "$REPO/yellowstone-skill/SKILL.md"

  # The two plugin-management plugins ship as a pair, and their keybinds live in
  # config.toml because neither manifest declares keys: plugin without bind is
  # unreachable, bind without plugin does nothing.
  check "manifest declares herdr-bar" \
    awk -F'\t' '$1=="herdr-bar"' "$REPO/herdr/plugins.toml" >/dev/null 2>&1 || \
    node "$REPO/scripts/plugins-manifest.js" ids "$REPO/herdr/plugins.toml" | grep -qx herdr-bar
  check "manifest declares the plugin manager" \
    node "$REPO/scripts/plugins-manifest.js" ids "$REPO/herdr/plugins.toml" | grep -qx ray.plugin-manager
  check "config ships the command-bar bind" grep -q 'command = "herdr-bar.open"' "$REPO/herdr/config.toml"
  check "config ships the plugin-manager bind" grep -q 'command = "ray.plugin-manager.open"' "$REPO/herdr/config.toml"
  # Every plugin whose manifest declares a keybind must have that bind in
  # config.toml — a manifest-only pin is not reachable.
  local missing_bind="" id kind_tab src ref link_path optional why repo note
  while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
    [ -n "$id" ] || continue
    # read the bind recorded in the manifest's keybind field, if any
    bind="$(node "$REPO/scripts/plugins-manifest.js" get "$REPO/herdr/plugins.toml" "$id" keybind)"
    [ -n "$bind" ] || continue
    # A plugin may declare several binds in one field, comma-separated
    # ("prefix+v -> dictate.toggle, prefix+shift+v -> dictate.toggle-send").
    while IFS= read -r one; do
      [ -n "$one" ] || continue
      action="${one#*-> }"
      action="${action%% *}"
      [ -n "$action" ] || continue
      grep -q "command = \"$action\"" "$REPO/herdr/config.toml" \
        || missing_bind="$missing_bind$id($action) "
    done < <(printf '%s' "$bind" | tr ',' '\n')
  done < <(node "$REPO/scripts/plugins-manifest.js" rows "$REPO/herdr/plugins.toml")
  check_eq "every declared keybind is present in config.toml" "" "$missing_bind"

  # The non-blocking invariant must be enforced at a call site, not just written
  # down: an agent that forgets does not get the benefit of a paragraph.
  check "nonblock extension ships" test -f "$REPO/pi/extensions/nonblock.ts"
  check "nonblock defaults to disabled" grep -q 'function enabled' "$REPO/pi/extensions/nonblock.ts"
  check "nonblock targets the attach trap" grep -q 'action !== "attach"' "$REPO/pi/extensions/nonblock.ts"
  check "skill documents the blocking table" \
    grep -q "jobs action='attach'" "$REPO/yellowstone-skill/SKILL.md"
  check "overlord doc carries the invariants" grep -qF '## Operational invariants' "$REPO/overlord/AGENTS.md"

  # Plugin manifest.
  local n
  n="$(node "$REPO/scripts/plugins-manifest.js" ids "$REPO/herdr/plugins.toml" 2>/dev/null | wc -l)"
  [ "${n:-0}" -ge 5 ] && ok "herdr/plugins.toml declares $n plugins" || bad "plugins.toml parsed $n plugins (expected >=5)"

  # Every plugin entry needs a pinned ref or a local link path.
  local badpin=0
  while IFS=$'\x1f' read -r id source ref link_path optional why repo note; do
    [ -n "$id" ] || continue
    if [ "$source" = local ]; then
      [ -n "$link_path" ] || { badpin=1; bad "plugins.toml: $id is local but has no link_path"; }
    else
      [ -n "$ref" ] || { badpin=1; bad "plugins.toml: $id has no pinned ref"; }
    fi
  done < <(node "$REPO/scripts/plugins-manifest.js" rows "$REPO/herdr/plugins.toml")
  [ "$badpin" = 0 ] && ok "every plugin is pinned or locally linked"

  # No secrets and no absolute home paths in the tree.
  local hits
  hits="$(grep -rniE '(sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|gho_[a-z0-9]{20,}|AIza[0-9a-z_-]{30,}|BEGIN [A-Z ]*PRIVATE KEY)' \
          --exclude-dir=.git "$REPO" 2>/dev/null | grep -v 'test/run-tests.sh' | wc -l)"
  check_eq "no credentials in the tree" 0 "$hits"

  # Match any concrete developer home directory rather than one literal path,
  # so this check cannot be satisfied or defeated by its own text.
  hits="$(grep -rnE '/home/(bitnom|ubuntu|runner|[a-z]+)/Code/' --exclude-dir=.git "$REPO" 2>/dev/null | wc -l)"
  check_eq "no absolute developer paths in the tree" 0 "$hits"
}

# -------------------------------------------------------------- install -----
suite_install() {
  suite install
  local home; home="$(new_home install)"

  local out rc
  out="$(in_home "$home" bash "$REPO/install.sh" pi skills agents overlord secrets --yes 2>&1)"; rc=$?
  check_eq "install.sh exits 0" 0 "$rc"
  check_contains "reports completion" "$out" "Done"

  check "settings.json created" test -f "$home/.pi/agent/settings.json"
  check "models.json created" test -f "$home/.pi/agent/models.json"
  check "transient-error-retry installed" test -f "$home/.pi/agent/extensions/transient-error-retry.ts"

  # Packages: all declared, and the fork is present as a git source.
  local npkg
  npkg="$(node -e 'const s=require(process.argv[1]);console.log(s.packages.length)' "$home/.pi/agent/settings.json")"
  # Counts are derived from the repo, not asserted at a literal: they change
  # whenever a package is added, and a literal turns that into a test failure
  # that says nothing about correctness.
  local want_pkg
  want_pkg="$(node -e 'console.log(require(process.argv[1]).packages.length)' "$REPO/pi/settings.json")"
  check_eq "all $want_pkg declared packages present" "$want_pkg" "$npkg"
  check "pi-pretty-tui installed from its fork repo" \
    grep -q 'Apothic-AI/pi-pretty-tui' "$home/.pi/agent/settings.json"

  # Providers, and no secret values in models.json.
  local nprov
  nprov="$(node -e 'const m=require(process.argv[1]);console.log(Object.keys(m.providers).length)' "$home/.pi/agent/models.json")"
  local want_prov
  want_prov="$(node -e 'console.log(Object.keys(require(process.argv[1]).providers).length)' "$REPO/pi/models.json")"
  check_eq "$want_prov providers merged" "$want_prov" "$nprov"
  check "apiKey values are commands, not literals" \
    bash -c "! grep -qE '\"apiKey\": *\"(sk-|pk-)' '$home/.pi/agent/models.json'"

  # Credential files created empty, mode 600.
  check "credential file created for relayfast" test -f "$home/.pi/agent/secrets/relayfast"
  local mode
  mode="$(stat -c '%a' "$home/.pi/agent/secrets/relayfast" 2>/dev/null)"
  check_eq "credential file is not group/world readable" 600 "$mode"

  # Skills: bundle kinds linked, dagr generated + linked.
  check "yellowstone skill linked" test -L "$home/.agents/skills/yellowstone"
  # The dagr skill is generated into the *installed plugin*, which the sandbox
  # cannot have (plugins are global to the user, not to HOME). Assert on the
  # generation step instead: either it produced the file, or skills-sync said
  # plainly that the plugin is missing and how to install it.
  local dagr_line
  dagr_line="$(printf '%s\n' "$out" | grep -E 'dagr-producer' || true)"
  if [ -n "$dagr_line" ]; then ok "dagr-producer reported: $(printf '%s' "$dagr_line" | sed 's/^ *//')"
  else bad "dagr-producer not mentioned in install output"; fi

  # Overlord: the directory and its two documents. The workspace itself cannot
  # be created in the sandbox because herdr workspaces are per-user, so this
  # asserts the directory side and that the script reports the workspace gap.
  check "~/AGENTS.md installed" test -f "$home/AGENTS.md"
  check "~/AGENTS.md matches the repo" cmp -s "$REPO/AGENTS.md" "$home/AGENTS.md"
  check "~/.sysops created" test -d "$home/.sysops"
  check "overlord AGENTS.md installed" test -f "$home/.overlord/AGENTS.md"
  check "overlord README.md installed" test -f "$home/.overlord/README.md"
  check_contains "overlord stage ran" "$out" "Overlord"
  check_contains "overlord reports the tab/space situation" "$out" "workspace"
  # The two agent tabs are part of the contract; without herdr the script must
  # say so rather than pretend success.
  # check_contains is glob-based, so alternation needs two separate assertions.
  # In the container herdr has no running server, so the tab stage legitimately
  # reports a gap; either it names the tabs or it explains why it could not.
  tab_line="$(printf '%s\n' "$out" | grep -iE 'overlord:|comms:|herdr not installed|no herdr server|could not create tab' | head -1)"
  if [ -n "$tab_line" ]; then ok "overlord tab stage reports: $(printf '%s' "$tab_line" | sed 's/^ *//')"
  else bad "overlord tab stage said nothing about tabs"; fi

  # doctor must run to completion and be honest about the unconfigured key.
  local dout
  dout="$(in_home "$home" bash "$REPO/scripts/doctor.sh" 2>&1)"
  check_contains "doctor reports missing credentials" "$dout" "pi-secrets"
  check_contains "doctor reports missing herdr config" "$dout" "herdr-config"
}

# ----------------------------------------------------------- idempotent -----
suite_idempotent() {
  suite idempotent
  local home; home="$(new_home idem)"

  in_home "$home" bash "$REPO/install.sh" pi skills agents overlord secrets --yes >/dev/null 2>&1
  local before; before="$(fingerprint "$home")"

  local out
  out="$(in_home "$home" bash "$REPO/install.sh" pi skills agents overlord secrets --yes 2>&1)"

  local after; after="$(fingerprint "$home")"
  if [ "$before" = "$after" ]; then
    ok "second run changes nothing on disk"
  else
    bad "second run changed files" "$(diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -10)"
  fi

  # A re-run must not duplicate a package or a provider.
  local n uniq
  n="$(node -e 'const s=require(process.argv[1]);console.log(s.packages.length)' "$home/.pi/agent/settings.json")"
  uniq="$(node -e 'const s=require(process.argv[1]);const n=s.packages.map(p=>typeof p==="string"?p:p.source);console.log(new Set(n).size)' "$home/.pi/agent/settings.json")"
  check_eq "no duplicate packages" "$n" "$uniq"
  check_contains "second run says already complete" "$out" "already"

  # The lock-file trap: installing an already-present package rewrites
  # npm/package-lock.json. Assert the installer does not do that on a no-op run.
  if [ -f "$home/.pi/agent/npm/package-lock.json" ]; then
    local lock_before lock_after
    lock_before="$(sha256sum "$home/.pi/agent/npm/package-lock.json" | cut -d' ' -f1)"
    in_home "$home" bash "$REPO/install.sh" pi --yes >/dev/null 2>&1
    lock_after="$(sha256sum "$home/.pi/agent/npm/package-lock.json" | cut -d' ' -f1)"
    check_eq "no-op re-run leaves package-lock.json alone" "$lock_before" "$lock_after"
  fi
}

# -------------------------------------------------------------- partial -----
suite_partial() {
  suite partial
  local home; home="$(new_home partial)"

  # A machine that has been lived in: its own theme, its own provider route,
  # its own package source for a package Yellowstone also declares.
  cat > "$home/.pi/agent/settings.json" <<'JSON'
{
  "theme": "my-theme",
  "defaultProvider": "myprovider",
  "packages": ["npm:pi-web-access", "git:github.com/bitnom/pi-cache-optimizer"],
  "customKey": "keep-me"
}
JSON
  mkdir -p "$home/.pi/agent/npm"
  cat > "$home/.pi/agent/models.json" <<'JSON'
{"providers":{"relayfast":{"baseUrl":"https://my.proxy/v1","api":"openai-completions","apiKey":"!cat /my/key","models":[{"id":"mine"}]}}}
JSON

  in_home "$home" bash "$REPO/install.sh" pi --yes >/dev/null 2>&1

  local theme provider custom
  theme="$(node -e 'console.log(require(process.argv[1]).theme)' "$home/.pi/agent/settings.json")"
  provider="$(node -e 'console.log(require(process.argv[1]).defaultProvider)' "$home/.pi/agent/settings.json")"
  custom="$(node -e 'console.log(require(process.argv[1]).customKey)' "$home/.pi/agent/settings.json")"
  check_eq "existing theme preserved" "my-theme" "$theme"
  check_eq "existing provider preserved" "myprovider" "$provider"
  check_eq "unknown user key preserved" "keep-me" "$custom"

  # The user's existing route must win over the template's.
  local base
  base="$(node -e 'console.log(require(process.argv[1]).providers.relayfast.baseUrl)' "$home/.pi/agent/models.json")"
  check_eq "existing provider block not overwritten" "https://my.proxy/v1" "$base"

  # Their pi-cache-optimizer source must not be doubled by the template's.
  local dupes
  dupes="$(node -e '
    const s=require(process.argv[1]);
    const n=s.packages.map(p=>typeof p==="string"?p:p.source);
    const c=n.filter(x=>String(x).includes("cache-optimizer")).length;
    console.log(c)' "$home/.pi/agent/settings.json")"
  check_eq "existing package source kept, not duplicated" 1 "$dupes"

  # But new packages still arrive.
  check "new packages still added" bash -c \
    "node -e 'const s=require(\"$home/.pi/agent/settings.json\");process.exit(s.packages.some(p=>String(p).includes(\"pi-rooms\"))?0:1)'"

  # A hand-edited ~/AGENTS.md must be backed up before the repo's version lands.
  printf '# my own instructions\ncustom rule\n' > "$home/AGENTS.md"
  in_home "$home" bash "$REPO/install.sh" agents --yes >/dev/null 2>&1
  check "hand-edited ~/AGENTS.md backed up" bash -c "ls '$home/AGENTS.md.bak-yellowstone-'* >/dev/null 2>&1"
  check "~/AGENTS.md replaced by the repo version" cmp -s "$REPO/AGENTS.md" "$home/AGENTS.md"

  # An operator's live workspace index must survive a reinstall.
  mkdir -p "$home/.overlord"
  printf '# my own index\nw1 somewhere\n' > "$home/.overlord/README.md"
  in_home "$home" bash "$REPO/install.sh" overlord --yes >/dev/null 2>&1
  local idx
  idx="$(cat "$home/.overlord/README.md")"
  check_contains "existing overlord README.md not overwritten" "$idx" "my own index"
  check "overlord AGENTS.md still installed" test -f "$home/.overlord/AGENTS.md"

  # A backup exists for every file that was modified.
  check "settings.json backed up before merge" bash -c "ls '$home/.pi/agent/settings.json.bak-yellowstone-'* >/dev/null 2>&1"
}

# ------------------------------------------------------------- failures ----
suite_failures() {
  suite failures
  local home; home="$(new_home fail)"

  # No herdr on PATH: the pi stages must still work and the summary must print.
  # Build a PATH that has everything except herdr, so this tests the herdr gap
  # rather than removing pi as a side effect.
  local bare="$SANDBOX/bare-bin"
  rm -rf "$bare"; mkdir -p "$bare"
  # Symlink every coreutils binary the scripts call, so this suite tests the
  # absence of herdr alone rather than the absence of `dirname`.
  local t
  for t in bash sh dash env git node npm npx python3 awk sed grep egrep sort head tail \
           wc cut tr cat cp mv rm mkdir ln chmod cmp date basename dirname readlink \
           find sha256sum stat printf touch tee diff uname id; do
    if p="$(command -v "$t" 2>/dev/null)"; then ln -sf "$p" "$bare/$t"; fi
  done
  ln -sf "$(command -v pi)" "$bare/pi"

  local out rc
  out="$(PATH="$bare" in_home "$home" bash "$REPO/install.sh" --yes 2>&1)"; rc=$?
  check_contains "reports herdr missing rather than crashing" "$out" "herdr not installed"
  check_contains "explains the herdr installer" "$out" "herdr.dev/install.sh"
  check_contains "still reaches the summary" "$out" "Done"
  check "pi config still installed without herdr" test -f "$home/.pi/agent/settings.json"

  # A corrupt settings.json must be backed up, not silently replaced.
  local home2; home2="$(new_home corrupt)"
  printf '{ this is not json' > "$home2/.pi/agent/settings.json"
  out="$(in_home "$home2" bash "$REPO/install.sh" pi --yes 2>&1)"
  check "corrupt settings.json backed up" bash -c "ls '$home2/.pi/agent/settings.json.bak-yellowstone-'* >/dev/null 2>&1"
  check "repaired settings.json is valid JSON" \
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$home2/.pi/agent/settings.json"

  # doctor with nothing installed must fail loudly, not vacuously pass.
  local home3; home3="$(new_home empty)"
  out="$(in_home "$home3" bash "$REPO/scripts/doctor.sh" 2>&1)"; rc=$?
  check_eq "doctor exits non-zero on an empty machine" 1 "$rc"
  check_contains "doctor names the missing config" "$out" "missing"

  # skills-sync with no checkouts must explain the remedy, not just fail.
  out="$(in_home "$home3" bash "$REPO/scripts/skills-sync.sh" install 2>&1)"
  check_contains "skills-sync prints the clone command" "$out" "gh repo clone"
}

# ------------------------------------------------------------- resolvers ----
suite_resolvers() {
  suite resolvers

  # skills-sync must resolve a repo whose skills sit at the root (mycord's
  # layout) as well as one that uses skills/<id>/ (unblock's layout).
  local home; home="$(new_home resolvers)"
  local code="$home/Code"
  mkdir -p "$code/skills-repo/skills/alpha-skill" "$code/root-repo/beta-skill"
  printf -- '---\nname: alpha-skill\ndescription: a\n---\n' > "$code/skills-repo/skills/alpha-skill/SKILL.md"
  printf -- '---\nname: beta-skill\ndescription: b\n---\n' > "$code/root-repo/beta-skill/SKILL.md"
  git -C "$code/skills-repo" init -q; git -C "$code/skills-repo" remote add origin https://github.com/example/skills-repo
  git -C "$code/root-repo" init -q;    git -C "$code/root-repo" remote add origin https://github.com/example/root-repo

  # A throwaway manifest exercising both layouts.
  local mf="$home/manifest.tsv"
  printf 'alpha-skill\trepo\texample/skills-repo\tskills/ layout\n' > "$mf"
  printf 'beta-skill\trepo\texample/root-repo\troot layout\n' >> "$mf"

  local out
  # Run the real script from the real repo, pointed at a throwaway manifest —
  # copying it elsewhere would break its `lib.sh` sibling lookup.
  out="$(in_home "$home" env SKILLS_MANIFEST="$mf" bash "$REPO/scripts/skills-sync.sh" install 2>&1)"

  check_contains "resolves skills/<id>/ layout" "$out" "alpha-skill: using checkout"
  check_contains "resolves root-level skill layout" "$out" "beta-skill: using checkout"
  check "linked the skills/ layout skill" test -L "$home/.agents/skills/alpha-skill"
  check "linked the root layout skill" test -L "$home/.agents/skills/beta-skill"

  # And the negative: a checkout that has neither must not be silently linked.
  local home2; home2="$(new_home resolvers2)"
  mkdir -p "$home2/Code/empty-repo"; git -C "$home2/Code/empty-repo" init -q
  git -C "$home2/Code/empty-repo" remote add origin https://github.com/example/empty-repo
  printf 'gamma-skill\trepo\texample/empty-repo\tnothing there\n' > "$home2/m.tsv"
  out="$(in_home "$home2" env SKILLS_MANIFEST="$home2/m.tsv" bash "$REPO/scripts/skills-sync.sh" install 2>&1)"
  check_contains "warns when a checkout lacks the skill" "$out" "neither"
}

# ------------------------------------------------------------------ main ----
main() {
  printf 'yellowstone test suite\nrepo: %s\nnode: %s\nherdr: %s\npi: %s\n' \
    "$REPO" "$(node --version)" "$(herdr --version 2>/dev/null | awk '{print $2}')" "$(pi --version 2>/dev/null)"

  # Prefer a mounted work tree when present.
  if [ -d /repo ] && [ -n "$(ls -A /repo 2>/dev/null)" ]; then REPO=/repo; fi

  # The image bakes the repo in, so a stale image silently tests old code. If the
  # caller mounted a work tree, it must match the baked copy; if the baked copy is
  # being tested, say when it was built so a stale run is obvious.
  if [ -f /repo/.git/HEAD ] && [ -d /worktree ]; then
    if ! diff -rq --exclude=.git /repo /worktree >/dev/null 2>&1; then
      printf '%sWARNING: /repo differs from the mounted work tree — rebuild the image%s\n' "$YELLOW" "$RESET"
      printf '  docker build -f test/Dockerfile -t yellowstone-test .\n'
    fi
  fi
  printf '%srepo snapshot: %s%s\n' "$DIM" "$(find "$REPO" -name '*.sh' -newer /repo/install.sh 2>/dev/null | head -1 || echo current)" "$RESET"

  mkdir -p "$SANDBOX"

  case "$SUITE" in
    smoke)      suite_smoke ;;
    install)    suite_install ;;
    idempotent) suite_idempotent ;;
    partial)    suite_partial ;;
    failures)   suite_failures ;;
    resolvers)  suite_resolvers ;;
    all)        suite_smoke; suite_install; suite_idempotent; suite_partial; suite_failures; suite_resolvers ;;
    *) printf 'unknown suite: %s\n' "$SUITE" >&2; exit 2 ;;
  esac

  printf '\n'
  if [ "$FAIL" -eq 0 ]; then
    printf '%s%d checks passed%s\n' "$GREEN" "$PASS" "$RESET"
    exit 0
  fi
  printf '%s%d passed, %d failed%s\n' "$RED" "$PASS" "$FAIL" "$RESET"
  printf 'failures:\n'
  printf '  - %s\n' "${FAILED_NAMES[@]}"
  exit 1
}

main
