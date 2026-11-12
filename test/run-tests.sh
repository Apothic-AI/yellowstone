#!/usr/bin/env bash
# run-tests.sh — exercise the Yellowstone installer in a throwaway HOME.
#
# Suites (pass one as $1, default "all"):
#   smoke     syntax, JSON, frontmatter, manifest parsing. No writes.
#   install   install.sh from scratch, then verify what landed.
#   mirror    home/ is a literal mirror: every file has a destination, the
#             destination lands byte-identical, doctor fails by path when one is
#             modified, and the personal files are never overwritten.
#   idempotent re-run install.sh and assert nothing changes (byte-for-byte).
#   partial   install on a machine with pre-existing config: assert the
#             installer adds and never overwrites.
#   failures  no herdr / no pi / no network: assert clean, explained failures.
#   resolvers linked-skill resolution across the two layouts.
#   builder   the box-side idleness verdict and the lease lock-fd fix.
#   behold    isolated Behold suite and offline installer path checks
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
  OVERLORD_DIR="$home/.overlord" \
  SYSOPS_DIR="$home/.sysops" \
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

# ------------------------------------------------------------ lint scope ----
# Which lint applies to which half of the tree, and the ONE authority for it: the
# predicate functions live in test/lib-vendor.sh, so the container suite here and
# the host gate test/verify-vendor-provenance.sh cannot drift apart. Read that file
# for the rule; the short form is that an exemption needs provenance *and* bytes —
# an accepted manifest member whose sha256 matches the recorded one, one of four
# pinned provenance artifacts, or the single recorded patch named in the lib.
#
# What this block owns is the credential side, which is deliberately exempt from
# path-based reasoning altogether (see CREDENTIAL_TOKEN_SYNTHETIC).
. "$REPO/test/lib-vendor.sh"

# The vendor fixtures stand in for a credential with this one literal token. The
# exemption is the token, never the file and never the directory: a real secret
# written into a fixture, into the accepted payload, or into a file added under
# vendor/ later still matches, and a modified member of the payload keeps no
# exemption to hide in. Findings are printed as paths only — in the failing case
# the match IS the credential, and a gate log is not the place for it.
CREDENTIAL_TOKEN_SYNTHETIC='sk-SYNTHETICCREDENT1AL0123456789'
CREDENTIAL_RE='sk-[a-z0-9]{20,}|ghp_[a-z0-9]{20,}|gho_[a-z0-9]{20,}|AIza[0-9a-z_-]{30,}|BEGIN [A-Z ]*PRIVATE KEY'

credential_findings() {  # $1 = root; prints each affected path once
  ( cd "$1" 2>/dev/null || return 0
    # No -h: the filename prefix is what makes the token check possible.
    grep -roiE "$CREDENTIAL_RE" --exclude-dir=.git --exclude-dir=src . 2>/dev/null \
      | awk -F: -v s="$CREDENTIAL_TOKEN_SYNTHETIC" '
          { t = $2; for (i = 3; i <= NF; i++) t = t ":" $i; if (t != s) print $1 }' \
      | sed 's|^\./||' | LC_ALL=C sort -u )
}

DEV_PATH_RE='/home/(bitnom|ubuntu|runner|[a-z][a-z0-9_-]*)/Code/'

developer_path_findings() {  # $1 = root; prints each unexempted path once
  local root="$1" rel
  ( cd "$root" 2>/dev/null || return 0
    grep -rnE "$DEV_PATH_RE" --exclude-dir=.git --exclude-dir=src . 2>/dev/null \
      | grep -v '^\./\.git:' | cut -d: -f1 | sed 's|^\./||' | LC_ALL=C sort -u ) \
  | while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      # Exact, named source exemptions. Both are tools that MEASURE a loose
      # checkout, so their text has to contain the prefix they search for;
      # excluding them by name keeps the exemption visible, where laundering the
      # pattern would hide it. Anything else that hardcodes a checkout is a defect.
      case "$rel" in
        home/.overlord/tools/relaunch-lane-monorepo.sh) continue ;;
        home/.overlord/tools/unit-path-refs.sh) continue ;;
      esac
      # Third-party and recorded provenance: membership AND matching bytes, from
      # the shared lib — not a directory prefix, and not a `patches/*` wildcard.
      is_accepted_vendor "$root" "$rel" && continue
      is_provenance_oracle "$root" "$rel" && continue
      is_provenance_patch_exempt "$root" "$rel" && continue
      printf '%s\n' "$rel"
    done
}

# ---------------------------------------------------------------- smoke ------
suite_smoke() {
  suite smoke

  local bad_syntax=0
  while IFS= read -r f; do
    bash -n "$f" 2>/dev/null || { bad_syntax=1; bad "bash syntax: $f"; }
  done < <(find "$REPO" -name '*.sh' -not -path '*/.git/*' -not -path '*/src/*')
  [ "$bad_syntax" = 0 ] && ok "every shell script parses"

  local bad_js=0
  while IFS= read -r f; do
    node --check "$f" 2>/dev/null || { bad_js=1; bad "node syntax: $f"; }
  done < <(find "$REPO" -name '*.js' -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/src/*')
  [ "$bad_js" = 0 ] && ok "every JS script parses"

  # JSON that is meant to be JSON (tsconfig may be JSONC, but none ships now)
  local bad_json=0
  while IFS= read -r f; do
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null \
      || { bad_json=1; bad "invalid JSON: $f"; }
  done < <(find "$REPO" -name '*.json' -not -path '*/.git/*' -not -path '*/src/*')
  [ "$bad_json" = 0 ] && ok "every JSON file parses"

  # Headings must be preceded by a blank line, or they render as part of the
  # previous paragraph. A doc is read by agents, so broken shape is a defect.
  #
  # Scoped by provenance, not by directory (see "lint scope" above): the accepted
  # third-party payload keeps its upstream bytes verbatim, so a shape rule we apply
  # to our own docs would be a demand to edit bytes `vendor/README.md` forbids
  # editing. Two payload files fail this rule today, which is exactly why the scope
  # has to be stated rather than discovered by removing the check.
  local badmd=0 f rel
  while IFS= read -r f; do
    rel="${f#"$REPO"/}"
    is_accepted_vendor "$REPO" "$rel" && continue
    if awk 'prev!="" && /^(##|###) /{found=1} {prev=$0} END{exit !found}' "$f"; then
      badmd=1; bad "heading without a preceding blank line: $f"
    fi
  done < <(find "$REPO" -name '*.md' -not -path '*/.git/*' -not -path '*/src/*')
  [ "$badmd" = 0 ] && ok "every source Markdown heading has a preceding blank line"

  # Every SKILL.md needs name + description, or hosts refuse to load it. Same scope:
  # a skill we import is not a skill we lint for frontmatter style.
  local bad_skill=0
  while IFS= read -r f; do
    rel="${f#"$REPO"/}"
    is_accepted_vendor "$REPO" "$rel" && continue
    if ! head -1 "$f" | grep -qx -- '---'; then bad_skill=1; bad "no frontmatter: $f"; continue; fi
    grep -qE '^name: *[a-z0-9-]+$' "$f" || { bad_skill=1; bad "no name: $f"; }
    grep -qE '^description: *' "$f"   || { bad_skill=1; bad "no description: $f"; }
  done < <(find "$REPO" -name 'SKILL.md' -not -path '*/.git/*' -not -path '*/src/*')
  [ "$bad_skill" = 0 ] && ok "every source SKILL.md has valid frontmatter"

  # The skill manifest must be parseable and internally consistent.
  local manifest="$REPO/skills/skills.tsv"
  if [ -f "$manifest" ]; then
    local rows
    rows="$(grep -vE '^[[:space:]]*(#|$)' "$manifest")"
    ok "skills.tsv parses ($(printf '%s\n' "$rows" | wc -l) rows)"

    local badkind=0 badbundle=0 badretired=0
    while IFS=$'\t' read -r id kind spec why; do
      [ -n "$id" ] || continue
      case "$kind" in
        repo|dagr|bundle) ;;
        *) badkind=1; bad "skills.tsv: $id has unknown kind '$kind'" ;;
      esac
      [ -n "$why" ] || bad "skills.tsv: $id has no why"
      # A bundle row claims this repo is the source of truth, so the bytes must be
      # here and must be a skill. An empty directory satisfies `-d` and installs
      # nothing, which is how a retired skill can keep reading as shipped.
      if [ "$kind" = bundle ]; then
        if [ ! -d "$REPO/${spec#./}" ]; then
          badbundle=1; bad "skills.tsv: $id bundle path missing: $spec"
        elif [ ! -f "$REPO/${spec#./}/SKILL.md" ]; then
          badbundle=1; bad "skills.tsv: $id bundle path has no SKILL.md: $spec"
        fi
      fi
      # A row may not point into a destination this repo has retired. The hotshot
      # row did exactly that for two days after its bytes were removed: the row was
      # the last thing asserting the skill still shipped. test/retired-paths.txt is
      # the list, so the manifest is checked against it rather than against prose.
      if [ -f "$REPO/test/retired-paths.txt" ]; then
        while IFS= read -r retired; do
          case "$retired" in ''|'#'*) continue ;; esac
          case "$spec" in
            *"${retired#\~/}"*) badretired=1; bad "skills.tsv: $id points into retired path $retired" ;;
          esac
        done < "$REPO/test/retired-paths.txt"
      fi
    done <<< "$rows"
    [ "$badkind" = 0 ] && ok "skills.tsv kinds are all valid"
    [ "$badbundle" = 0 ] && ok "every bundle row ships a SKILL.md at its path"
    [ "$badretired" = 0 ] && ok "no skills.tsv row points into a retired path"
  else
    bad "missing skills/skills.tsv"
  fi

  # Two documents, two readers. The repo's own AGENTS.md is instructions for
  # working in this tree; the fleet core that installs to $HOME/AGENTS.md is a
  # separate artifact. Collapsing them is what made the installed copy a
  # pointer to itself on the next install.
  check "ships the fleet core" test -f "$REPO/home/AGENTS.md"
  check "fleet core is not this repo's own instructions" bash -c \
    "! cmp -s '$REPO/AGENTS.md' '$REPO/home/AGENTS.md'"
  # The two exclusions are decisions, not accidents: a mirror of the agent dir
  # must never carry credential files, and the generated profile instance tree is
  # not this repo's content at all.
  check "the mirror ships no secrets directory" \
    bash -c "[ ! -e '$REPO/home/.pi/agent/secrets' ]"
  check "the mirror does not carry a profile instance tree" \
    bash -c "[ ! -e '$REPO/home/.pi-profile-switch' ]"

  # The shipped overlord docs: present, and free of any one operator's projects.
  for f in home/.overlord/AGENTS.md home/.overlord/README.md; do
    check "ships $f" test -f "$REPO/$f"
  done
  # The two shipped docs are templates every fleet inherits, so they must not
  # name one operator's projects. The guard is scoped to those two files on
  # purpose: home/.overlord/tools/ is this fleet's own machinery, and naming a
  # fleet lane there (a rooms file, a lane-seeding list) is the tool doing its
  # job, not a leak. Scoping to the docs the sentence claims to guard is what
  # keeps the check honest once the tooling lives in the mirror too.
  local leaks
  leaks="$(grep -riE 'apothic|autopod|subtoken|starla|sibyl|solid-lynx|omebian|mycord|vpn2proxy|surreal|account-management' \
           "$REPO/home/.overlord/AGENTS.md" "$REPO/home/.overlord/README.md" 2>/dev/null | wc -l)"
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
  if grep -q 'theme.custom' "$REPO/home/.config/herdr/config.toml"; then
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
  # The shipped overlord doc is the role-NEUTRAL space contract: what is true for
  # every lane in the directory, with role instructions delegated to `.pi/modes/`.
  # These are the headings it actually carries. The list this replaces
  # (`## Intake`, `### Goal-driven lanes`, `### Reserved right now`,
  # `## Operational invariants`) named sections of the older role-bearing document,
  # which still exists at docs/overlord-orchestrator-AGENTS-2026-11-08.md — so the
  # check was demanding that the shipped file grow role prose back, and it failed
  # for as long as nobody looked. Assert what the file is, not what it replaced.
  local sec
  for sec in '## Two reads that lie' '## Degraded start' '## Absolutes' \
             '## Where things live' '## Session continuity and reloads'; do
    check "overlord doc carries '$sec'" grep -qF "$sec" "$REPO/home/.overlord/AGENTS.md"
  done
  # Role-neutral core: the doc names where role text lives rather than carrying it.
  check "overlord doc delegates roles to .pi/modes/" \
    grep -qF 'Role instructions live in' "$REPO/home/.overlord/AGENTS.md"
  # ...and the role prose it used to carry has not come back. This is the direction
  # the headings above cannot see: a lane can add a `## Intake` section without
  # breaking any positive assertion.
  local stale_role=""
  for sec in '## Role and boundaries' '## Intake:' '## Directing agents' '### Goal-driven lanes'; do
    grep -qF "$sec" "$REPO/home/.overlord/AGENTS.md" && stale_role="$stale_role$sec; "
  done
  check_eq "role prose has not been resurrected into the overlord AGENTS.md" "" "$stale_role"
  # Role append, checked against the files that carry it: each space role names a
  # fleet mode key and composes onto it. `replace` would shadow the fleet contract
  # the lane is supposed to keep, so the strategy is part of the invariant.
  local role_n=0 role_bad="" role_f
  for role_f in "$REPO"/home/.overlord/.pi/modes/*.json; do
    [ -f "$role_f" ] || continue
    role_n=$((role_n + 1))
    node -e 'const s = require(process.argv[1]);
      const ok = typeof s.key === "string" && s.key.length > 0 &&
                 s.promptStrategy === "append" &&
                 typeof s.systemPrompt === "string" && s.systemPrompt.length > 0;
      process.exit(ok ? 0 : 1)' "$role_f" || role_bad="$role_bad$(basename "$role_f") "
  done
  check "overlord space ships role files" test "$role_n" -gt 0
  check_eq "every overlord role file composes with promptStrategy append" "" "$role_bad"
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
  check "config ships the command-bar bind" grep -q 'command = "herdr-bar.open"' "$REPO/home/.config/herdr/config.toml"
  check "config ships the plugin-manager bind" grep -q 'command = "ray.plugin-manager.open"' "$REPO/home/.config/herdr/config.toml"
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
      grep -q "command = \"$action\"" "$REPO/home/.config/herdr/config.toml" \
        || missing_bind="$missing_bind$id($action) "
    done < <(printf '%s' "$bind" | tr ',' '\n')
  done < <(node "$REPO/scripts/plugins-manifest.js" rows "$REPO/herdr/plugins.toml")
  check_eq "every declared keybind is present in config.toml" "" "$missing_bind"

  # The non-blocking invariant must be enforced at a call site, not just written
  # down: an agent that forgets does not get the benefit of a paragraph.
  #
  # The hooks ship in the `pi-fleet-hooks` package now, declared in its own
  # `pi.extensions`, so the source is in the subrepo and no copy belongs in the
  # agent dir — a copy there double-loads every hook on a fresh machine. These
  # three assertions kept reading the retired location and failed for a week
  # after the move, which is the same staleness the install suite had: an
  # assertion that names a path outlives the decision that moved it.
  local hooks="$REPO/src/pi-extensions/pi-fleet-hooks/src/nonblock.ts"
  check "nonblock extension ships in pi-fleet-hooks" test -f "$hooks"
  check "nonblock defaults to disabled" grep -q 'function enabled' "$hooks"
  check "nonblock targets the attach trap" grep -q 'action !== "attach"' "$hooks"
  check "skill documents the blocking table" \
    grep -q "jobs action='attach'" "$REPO/yellowstone-skill/SKILL.md"
  check "overlord doc carries the invariants" grep -qF '## Absolutes' "$REPO/home/.overlord/AGENTS.md"

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
  #
  # `src/` is excluded from both checks on purpose: those are other repositories'
  # trees at pinned commits, delivered by `git subrepo`. Policing them from here
  # would mean editing a fork's fixtures to satisfy our lint, and the conversion
  # gate is what holds their content honest. Measured at the conversion commit:
  # 7 credential-pattern hits and 3 absolute paths inside `src/`, all of them
  # test fixtures (`sk-` and PEM placeholders in redaction tests) except one
  # real one — `herdr-voice-linux/scripts/merge-lanes` hardcodes
  # `/home/<user>/Code/herdr-voice-linux`; that belongs to the fork, not here.
  #
  # `vendor/` is NOT excluded, and that is deliberate. It is scanned in full, and
  # the only thing exempted is the exact synthetic stand-in token the vendor
  # fixtures use (see CREDENTIAL_TOKEN_SYNTHETIC). A path or directory exemption
  # here would be the one place a real secret could hide from every gate.
  local cred_hits cred_paths
  cred_hits="$(credential_findings "$REPO")"
  cred_paths="$(printf '%s\n' "$cred_hits" | grep -c . || true)"
  # Paths and a count only: in the failing case the matched text IS the credential.
  [ "$cred_paths" = 0 ] || printf '       credential-shaped tokens in:%s\n' \
      "$(printf '%s\n' "$cred_hits" | sed '/^$/d' | sed 's/^/ /' | tr '\n' ' ')"
  check_eq "no credentials in the tree" 0 "$cred_paths"

  # The negative direction, because an allowlist that is never exercised decays
  # into a blanket exclusion: plant a real-looking credential and a real-looking
  # developer path in a SCANNED location and require both to still be RED. Both
  # plants go under `vendor/` deliberately — that is where a `--exclude-dir=vendor`
  # would have hidden them, so the plant is the direct test of "no blanket vendor
  # exclusion". The planted tokens are assembled at run time so this file contains
  # no matching literal of its own.
  #
  # Every fixture copy below is FAIL-CLOSED: `cp … 2>/dev/null || true` made the
  # two "stays exempt" assertions pass when the copy silently failed, because an
  # absent file has no findings. A fixture that did not arrive is now its own
  # failure, and the exact synthetic token is asserted present, so "not a finding"
  # means "present and correctly exempted" rather than "absent".
  local plant; plant="$(mktemp -d)"
  local fixture_ok=1
  mkdir -p "$plant/$VENDOR_PAYLOAD_REL/scripts" \
           "$plant/$VENDOR_PAYLOAD_REL/ft20-provenance/patches" \
           "$plant/vendor/ft20-portable"
  plant_fixture() {  # $1 = repo-relative source, $2 = plant-relative dest
    mkdir -p "$(dirname "$plant/$2")"
    cp "$REPO/$1" "$plant/$2" 2>/dev/null || { fixture_ok=0; bad "fixture copy failed: $1"; }
  }
  plant_fixture "$VENDOR_ACCEPTED_REL" "$VENDOR_ACCEPTED_REL"
  # An accepted-payload member: its upstream TSC default must stay exempt, and only
  # because the bytes still match the recorded hash.
  plant_fixture "$VENDOR_PAYLOAD_REL/scripts/verify.sh" "$VENDOR_PAYLOAD_REL/scripts/verify.sh"
  # Our own tooling: its synthetic sentinels must stay exempt too.
  plant_fixture "vendor/ft20-portable/probes/actual-probes.mjs" "vendor/ft20-portable/actual-probes.mjs"
  # The one recorded patch that is exempt by exact name and hash.
  local patch_rel; patch_rel="${VENDOR_PATCH_EXEMPT_PIN% *}"
  plant_fixture "$patch_rel" "$patch_rel"
  check_eq "every negative-test fixture copy landed" 1 "$fixture_ok"
  check "the synthetic-token fixture carries the exact synthetic token" \
    grep -qF -- "$CREDENTIAL_TOKEN_SYNTHETIC" "$plant/vendor/ft20-portable/actual-probes.mjs"
  check "the accepted-payload fixture carries a developer path to exempt" \
    grep -qE "$DEV_PATH_RE" "$plant/$VENDOR_PAYLOAD_REL/scripts/verify.sh"

  printf 'const k = "%s%s";\n' 'sk-' 'L1VERealCredential0123456789' \
    > "$plant/vendor/ft20-portable/planted.txt"
  printf '# %s/%s/Code/checkout\n' /home stranger > "$plant/planted-path.txt"
  check_eq "a planted real credential outside the allowlist is still caught" \
    "vendor/ft20-portable/planted.txt" "$(credential_findings "$plant" | tr '\n' ' ' | sed 's/ $//')"
  check_eq "a planted developer path outside the allowlist is still caught" \
    "planted-path.txt" "$(developer_path_findings "$plant" | tr '\n' ' ' | sed 's/ $//')"
  # The exemption still works, and works for the stated reason.
  check_eq "the synthetic fixture token itself is not a finding" 0 \
    "$(credential_findings "$plant" | grep -c 'actual-probes' || true)"
  check_eq "the accepted payload's developer path stays exempt by matching bytes" 0 \
    "$(developer_path_findings "$plant" | grep -c 'scripts/verify.sh' || true)"
  check_eq "the one recorded exempt patch's developer path stays exempt" 0 \
    "$(developer_path_findings "$plant" | grep -c 'patches/0001-' || true)"

  # Membership alone is not an exemption. Append a developer path to an accepted
  # member: the bytes no longer match the recorded hash, so the file must fall out
  # of the exemption and be reported. This is the exact defect the first version had
  # — it keyed on the path, so a modified member kept its exemption forever.
  printf 'WorkingDirectory=%s/%s/Code/tampered\n' /home intruder \
    >> "$plant/$VENDOR_PAYLOAD_REL/scripts/verify.sh"
  check_eq "a modified manifest member loses its exemption" 1 \
    "$(developer_path_findings "$plant" | grep -c 'scripts/verify.sh' || true)"
  plant_fixture "$VENDOR_PAYLOAD_REL/scripts/verify.sh" "$VENDOR_PAYLOAD_REL/scripts/verify.sh"

  # A NEW patch under patches/ inherits nothing. The blanket `patches/*` this
  # replaced would have exempted it unread.
  printf 'WorkingDirectory=%s/%s/Code/unlisted\n' /home stranger \
    > "$plant/$VENDOR_PAYLOAD_REL/ft20-provenance/patches/0005-unreviewed.patch"
  check_eq "an unlisted new patch inherits no exemption" 1 \
    "$(developer_path_findings "$plant" | grep -c '0005-unreviewed' || true)"

  # And the token exemption is the token, not the file: change one character of the
  # synthetic sentinel and the same fixture becomes a finding.
  sed 's/SYNTHETICCREDENT1AL/SYNTHETICCREDENT1AX/' \
    "$plant/vendor/ft20-portable/actual-probes.mjs" > "$plant/vendor/ft20-portable/mutated.mjs"
  check_eq "a mutated sentinel in the same fixture becomes a finding" 1 \
    "$(credential_findings "$plant" | grep -c 'mutated.mjs' || true)"

  # The four provenance records are pinned by hash. Doctoring the accepted manifest
  # so it re-exempts a modified file must fail the pin, not be read as truth.
  check_eq "the four provenance artifacts match their pinned hashes" 0 \
    "$(printf '%s\n' "$VENDOR_ORACLE_PINS" | while IFS= read -r pin; do
         [ -n "$pin" ] || continue
         vendor_pin_matches "$REPO" "$pin" || printf '%s\n' "$pin"
       done | grep -c . || true)"
  printf '0000000000000000000000000000000000000000000000000000000000000000  scripts/verify.sh\n' \
    >> "$plant/$VENDOR_ACCEPTED_REL"
  check_eq "a doctored accepted manifest fails its pin" 1 \
    "$(vendor_pin_matches "$plant" "$VENDOR_ACCEPTED_REL $(vendor_oracle_pin "$VENDOR_ACCEPTED_REL")"; echo $?)"
  rm -rf "$plant"
  rm -rf "$plant"

  # Match any concrete developer home directory rather than one literal path, so
  # this check cannot be satisfied or defeated by its own text. In a git worktree
  # `.git` is a *file* whose one line is the main checkout's gitdir, so the
  # directory exclusion alone would report the lane's scaffolding as tree content;
  # the filter drops that line and nothing else. `src/` is excluded on purpose:
  # those are other repositories' trees at pinned commits, delivered by
  # `git subrepo`, and their fixtures are not ours to edit — the credentials check
  # above carries the same exclusion for the same reason.
  #
  # Two tools in the mirror name a developer path on purpose and are allowed to:
  # `relaunch-lane-monorepo.sh` and `unit-path-refs.sh` are the tools that MEASURE
  # loose references, and their expressions have to contain the prefix they search
  # for — the same self-matching grep that once made the migration count unable to
  # reach zero. Excluding them by name, rather than by laundering the pattern,
  # keeps the exemption visible. The accepted vendor payload and its recorded
  # patches are exempt by provenance (see "lint scope"): one accepted script
  # carries its author's TSC default. That exemption is in
  # developer_path_findings() so the planted-path check above exercises it rather
  # than restating it.
  local dev_paths; dev_paths="$(developer_path_findings "$REPO")"
  [ -z "$dev_paths" ] || printf '       developer paths in: %s\n' "$(printf '%s\n' "$dev_paths" | tr '\n' ' ')"
  check_eq "no absolute developer paths in the tree" "" "$dev_paths"
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
  # Retired hook copies are asserted ABSENT, from the same list the mirror suite
  # reads. The two hooks are declared by the `pi-fleet-hooks` package now, so a
  # copy beside the package double-loads on a fresh machine; this check asserted
  # the copy was installed for a day after it was retired, and failed on every
  # run in that window. Reading `test/retired-paths.txt` instead of naming a path
  # here means the next retirement is covered without editing this file — and it
  # removes the second place that had to know, which is what went stale.
  local retired rc_retired=0 dest
  while IFS= read -r retired; do
    case "$retired" in '' | '#'*) continue ;; esac
    dest="$home/${retired#\~/}"
    if [ -e "$dest" ]; then
      rc_retired=1
      echo "  retired path was installed: $retired" >&2
    fi
  done < "$REPO/test/retired-paths.txt"
  check_eq "no retired path is installed" 0 "$rc_retired"

  # Packages: all declared, and the fork is present as a git source.
  local npkg
  npkg="$(node -e 'const s=require(process.argv[1]);console.log(s.packages.length)' "$home/.pi/agent/settings.json")"
  # Counts are derived from the repo, not asserted at a literal: they change
  # whenever a package is added, and a literal turns that into a test failure
  # that says nothing about correctness.
  local want_pkg
  want_pkg="$(node -e 'console.log(require(process.argv[1]).packages.length)' "$REPO/home/.pi/agent/settings.json")"
  check_eq "all $want_pkg declared packages present" "$want_pkg" "$npkg"
  # Since the conversion the nine carried packages are local paths into the
  # checkout rather than git sources, so asserting the fork's GitHub slug would
  # assert the pre-conversion world. What matters is that the entry names the
  # monorepo copy of the fork.
  check "pi-pretty-tui installed from the monorepo copy of its fork" \
    grep -q '/src/pi-extensions/pi-pretty-tui' "$home/.pi/agent/settings.json"

  # Providers, and no secret values in models.json.
  local nprov
  nprov="$(node -e 'const m=require(process.argv[1]);console.log(Object.keys(m.providers).length)' "$home/.pi/agent/models.json")"
  local want_prov
  want_prov="$(node -e 'console.log(Object.keys(require(process.argv[1]).providers).length)' "$REPO/home/.pi/agent/models.json")"
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
  check "~/AGENTS.md matches the shipped core" cmp -s "$REPO/home/AGENTS.md" "$home/AGENTS.md"
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
  tab_line="$(printf '%s\n' "$out" | grep -iE 'overlord:|herdr not installed|no herdr server|could not create tab' | head -1)"
  if [ -n "$tab_line" ]; then ok "overlord tab stage reports: $(printf '%s' "$tab_line" | sed 's/^ *//')"
  else bad "overlord tab stage said nothing about tabs"; fi

  # doctor must run to completion and be honest about the unconfigured key.
  local dout
  dout="$(in_home "$home" bash "$REPO/scripts/doctor.sh" 2>&1)"
  check_contains "doctor reports missing credentials" "$dout" "pi-secrets"
  # The herdr stage did not run in this sandbox, so config.toml is absent. doctor
  # reports that from the mirror section, by mirror path — one place for "the
  # file is missing/differs", instead of a second comparison in the herdr block.
  check_contains "doctor reports missing herdr config" "$dout" "home/.config/herdr/config.toml"
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

  # A hand-edited ~/AGENTS.md must be backed up before the shipped core lands.
  printf '# my own instructions\ncustom rule\n' > "$home/AGENTS.md"
  in_home "$home" bash "$REPO/install.sh" agents --yes >/dev/null 2>&1
  check "hand-edited ~/AGENTS.md backed up" bash -c "ls '$home/AGENTS.md.bak-yellowstone-'* >/dev/null 2>&1"
  check "~/AGENTS.md replaced by the shipped core" cmp -s "$REPO/home/AGENTS.md" "$home/AGENTS.md"

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

# --------------------------------------------------------------- mirror -----
# home/ is the literal mirror of $HOME, so the mirror is testable *as* a mirror.
# These checks fail in both directions — a file in home/ that no destination
# claims, and a documented destination that home/ cannot back — plus the three
# behaviours a restructure like this breaks first: a copy landing byte-identical,
# doctor noticing a modified file, and the install-if-absent personal files
# surviving a reinstall.
#
suite_mirror() {
  suite mirror

  local probe_home="$SANDBOX/mirror-probe"
  mkdir -p "$probe_home"

  # rel<TAB>destination<TAB>policy for every file under home/, resolved by
  # scripts/lib.sh itself so this suite cannot drift from the installer by
  # re-implementing the mapping $2 is the HOME the destinations are computed for.
  mirror_rows() {
    env HOME="$1" REPO_FOR_PROBE="$REPO" bash -c '
      source "$REPO_FOR_PROBE/scripts/lib.sh"
      cd "$REPO_FOR_PROBE/home" || exit 1
      find . -type f | sed "s|^\./||" | LC_ALL=C sort | while IFS= read -r rel; do
        if ! dest="$(home_dest "$rel")"; then printf "%s\t-\tNONE\n" "$rel"; continue; fi
        printf "%s\t%s\t%s\n" "$rel" "$dest" "$(home_policy "$rel")"
      done
    '
  }

  local rows nrows
  rows="$(mirror_rows "$probe_home")"
  nrows="$(printf '%s\n' "$rows" | grep -c .)"
  [ "$nrows" -ge 18 ] && ok "home/ carries $nrows files" || bad "home/ carries only $nrows files"

  check_eq "every file in home/ has a destination" "" \
    "$(printf '%s\n' "$rows" | awk -F'\t' '$3=="NONE"{printf "%s ", $1}')"

  # The fleet tooling: shipped, runnable, and free of a path into a ~/Code
  # checkout — the whole point of migrating it into the mirror. The executable
  # check is not cosmetic: four tools had lost their exec bit in the live
  # directory, so a plain copy would have shipped files that only run when
  # called through an interpreter, and nothing would have noticed.
  check "ships the fleet tooling" test -d "$REPO/home/.overlord/tools"
  local nonexec
  nonexec="$(find "$REPO/home/.overlord/tools" "$REPO/home/.overlord/bin" -maxdepth 1 -type f ! -perm -u+x | wc -l)"
  check_eq "every mirrored tool is executable" 0 "$nonexec"
  # relaunch-lane-monorepo.sh names the pattern on purpose: it is the tool that
  # measures loose references. `unit-path-refs.sh` does the same job for systemd
  # units, so it carries the prefix it searches for in its own header (and in the
  # example the retired unit used). Every other tool must reach the fleet's own code
  # through the installed package list, not through a checkout path.
  #
  # Two shapes, because the first version of this check only caught the first:
  # a literal "/home/<user>/Code/…" string, and a Python-style join
  # Path.home() / "Code" / "<repo>". The join form is how the second hardcoded
  # path hid from the guard while a real ~/Code dependency was still there.
  local codept=0 codept_join
  codept="$(grep -rnE '/home/[a-z]+/Code/' "$REPO/home/.overlord/tools" 2>/dev/null \
           | grep -vE 'yellowstone|relaunch-lane-monorepo|unit-path-refs' | wc -l)"
  codept_join="$(grep -rnE '"Code"[[:space:]]*/[[:space:]]*"' "$REPO/home/.overlord/tools" 2>/dev/null \
           | grep -v 'yellowstone' | wc -l)"
  check_eq "no mirrored tool hardcodes a ~/Code path" 0 "$((codept + codept_join))"

  # Paths this repo deliberately stopped installing must not come back. A
  # full-plan golden file was the first attempt and it was the wrong shape: it
  # fired on every intentional addition, and it baked host facts (whether dagr is
  # installed, where its plugin lives) into a fixture. A retired-path list only
  # fires on the thing it names.
  local retired hit_plan="" hit_tree=""
  if [ -f "$REPO/test/retired-paths.txt" ]; then
    plan_destinations="$(env HOME="$probe_home" HERDR_CONFIG_DIR="$probe_home/.config/herdr" \
        PI_CODING_AGENT_DIR="$probe_home/.pi/agent" AGENTS_SKILLS_DIR="$probe_home/.agents/skills" \
        LOCAL_BIN_DIR="$probe_home/.local/bin" OVERLORD_DIR="$probe_home/.overlord" \
        SYSOPS_DIR="$probe_home/.sysops" \
        "$REPO/install.sh" --dry-run 2>/dev/null \
          | sed -n -e 's/^ *would: [a-z]* .*-> //p' -e 's/^ *would: [a-z]* \(~\/[^ ]*\).*/\1/p' \
          | sed 's/ .*//')"
    while IFS= read -r retired; do
      case "$retired" in ''|'#'*) continue ;; esac
      # `grep -q` exits at the first match, which SIGPIPEs the upstream writer; under
      # `set -o pipefail` that can report failure for a pipeline that matched. The
      # match is the question here, so ask it without a pipeline at all.
      case "$(printf '\n%s\n' "$plan_destinations")" in
        *"$retired"*) hit_plan="$hit_plan $retired" ;;
      esac
      [ -e "$probe_home/${retired#\~/}" ] && hit_tree="$hit_tree $retired"
    done < "$REPO/test/retired-paths.txt"
    check_eq "no retired path is back in the installer's plan" "" "$hit_plan"
  fi

  # The other direction: every root the installer documents must be backed by
  # content in home/, unless what lands there is generated rather than shipped.
  local roots generated root dest missing_roots=""
  roots="$(env HOME="$probe_home" REPO_FOR_PROBE="$REPO" bash -c '
    source "$REPO_FOR_PROBE/scripts/lib.sh"; home_dest_roots')"
  generated="$(env HOME="$probe_home" REPO_FOR_PROBE="$REPO" bash -c '
    source "$REPO_FOR_PROBE/scripts/lib.sh"; home_generated_dirs')"
  while IFS='|' read -r root dest; do
    [ -n "$root" ] || continue
    if [ -n "$(cd "$REPO/home" && find "./$root" -type f 2>/dev/null | head -1)" ]; then
      continue
    fi
    printf '%s\n' "$generated" | grep -qx -- "$dest" || missing_roots="$missing_roots$root "
  done <<< "$roots"
  check_eq "every documented destination is backed by home/ or generated" "" "$missing_roots"

  # ---- install into a throwaway HOME: the mirror must land intact --------
  local home out rc
  home="$(new_home mirror)"
  out="$(in_home "$home" bash "$REPO/install.sh" pi agents overlord secrets --yes 2>&1)"; rc=$?
  check_eq "install.sh exits 0" 0 "$rc"

  # The herdr stage's two file destinations through the same helper the stage
  # calls. Its remaining work — the pi integration and 14 plugin installs — is
  # machine state, not mirror content, and running it here would make this suite
  # depend on the network and mutate the box.
  in_home "$home" bash -c 'source "$1/scripts/lib.sh"; install_home_tree .config/herdr; install_home_tree .local/bin' \
    _ "$REPO" >/dev/null 2>&1

  # Only the bundle skills, from a synthetic manifest: the mirror's skill rows
  # are what this asserts, and a repo-kind fetch would prove the network instead.
  local bundles="$home/bundles.tsv"
  grep -vE '^[[:space:]]*(#|$)' "$REPO/skills/skills.tsv" | awk -F'\t' '$2=="bundle"' > "$bundles"
  in_home "$home" env SKILLS_MANIFEST="$bundles" bash "$REPO/scripts/skills-sync.sh" install >/dev/null 2>&1

  rows="$(mirror_rows "$home")"
  local rel target policy not_landed="" not_identical=""
  while IFS=$'\t' read -r rel target policy; do
    [ -n "$rel" ] || continue
    case "$policy" in
      copy|copy-exec)
        if [ ! -e "$target" ]; then not_landed="$not_landed$rel "
        elif ! cmp -s -- "$REPO/home/$rel" "$target"; then not_identical="$not_identical$rel "
        fi ;;
      *)
        [ -e "$target" ] || not_landed="$not_landed$rel " ;;
    esac
  done <<< "$rows"
  check_eq "every mirrored file landed at its destination" "" "$not_landed"
  check_eq "every copied file is byte-identical to home/" "" "$not_identical"

  # The overlord-operations skill is mirrored under .overlord/skills and linked
  # into .agents/skills. A fresh machine must get the LINK, not a copy: a copied
  # directory would be a skill the repo no longer owns, which is the drift
  # 2df88aee removed for profile-config. And the link must resolve, or a fresh
  # machine gets a dangling skill and no diagnostic.
  #
  # The target is the INSTALLED copy under $HOME, not the repo's home/.overlord
  # copy, and the wording here previously said "mirrored" for both — which is how
  # a link direction gets argued about when the code already agrees. Pointing at
  # the repo copy would make the installed file write-only: the installer writes
  # it and nothing reads it. Pointing here means the installer writes it and the
  # skill system reads it through the link, and a link into $HOME survives the
  # checkout moving, which the retirement project will do.
  check "overlord skill is linked, not copied" \
    test -L "$home/.agents/skills/overlord-operations"
  check_eq "overlord skill links to the installed copy" \
    "$home/.overlord/skills/overlord-operations" \
    "$(readlink -- "$home/.agents/skills/overlord-operations" 2>/dev/null)"
  check "overlord skill link resolves to a real SKILL.md" \
    test -f "$home/.agents/skills/overlord-operations/SKILL.md"

  # A first install must not hand pi a package placeholder as a path.
  check_eq "no unrendered package placeholder in a fresh settings.json" "" \
    "$(node -e 'const s=require(process.argv[1]);const b=(s.packages||[]).map(p=>String(typeof p==="string"?p:p.source)).filter(x=>x.startsWith("@"));console.log(b.join(" "))' "$home/.pi/agent/settings.json")"

  # ---- the personal files are kept, never overwritten -------------------
  printf '{"reminders":["mine, hand-written"]}\n' > "$home/.pi/agent/pi-persist.json"
  printf '{"mru":["my-model"]}\n' > "$home/.pi/agent/model-picker.json"
  out="$(in_home "$home" bash "$REPO/install.sh" pi --yes 2>&1)"
  check_contains "reinstall reports the personal file was kept" "$out" "kept"
  check_eq "pi-persist.json kept" '{"reminders":["mine, hand-written"]}' \
    "$(cat "$home/.pi/agent/pi-persist.json")"
  check_eq "model-picker.json kept" '{"mru":["my-model"]}' \
    "$(cat "$home/.pi/agent/model-picker.json")"

  # ---- doctor: one modified destination is a failure, named by path ------
  local victim="$home/.pi/agent/pi-auto-compact.json" dout drc
  node -e 'const f=process.argv[1];const j=require(f);j.tampered=true;require("fs").writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$victim"
  dout="$(in_home "$home" bash "$REPO/scripts/doctor.sh" 2>&1)"; drc=$?
  check_ne "doctor exits non-zero when a mirrored file is modified" 0 "$drc"
  check_contains "doctor names the modified path" "$dout" "pi-auto-compact.json"

  # ---- dry run: names every destination, writes nothing ------------------
  # A destination file that exists after a dry run would mean the plan was a lie.
  # Rendered as `~/…`, because that is the form the plan prints.
  local dh wrote plan d
  dh="$(new_home mirror-dry)"
  plan="$(in_home "$dh" bash "$REPO/install.sh" --dry-run --yes 2>&1)"
  wrote=""
  while IFS=$'\t' read -r rel target policy; do
    [ -e "$target" ] && wrote="$wrote$rel "
  done <<< "$(mirror_rows "$dh")"
  check_eq "dry run creates no destination" "" "$wrote"
  check_eq "dry run creates no backup" "" "$(find "$dh" -name '*.bak-yellowstone-*' 2>/dev/null | head -1)"
  for d in .config/herdr .pi/agent .agents/skills .local/bin AGENTS.md .overlord .sysops; do
    check_contains "dry-run plan names ~/$d" "$plan" "~/$d"
  done
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

  # The unmanaged-directory population has no other guard: a tidy that removes
  # real directories in AGENTS_SKILLS is invisible to every other check, so a
  # machine-local baseline makes it loud.
  local home4; (
    home4="$(new_home baseline)"
    mkdir -p "$home4/.agents/skills/keep-me" "$home4/.local/state/yellowstone"
    echo 5 > "$home4/.local/state/yellowstone/skills-baseline"
    out="$(in_home "$home4" bash "$REPO/scripts/doctor.sh" 2>&1)"; rc=$?
    check_eq "a skills population below its baseline fails doctor" 1 "$rc"
    check_contains "the failure names the shortfall" "$out" "1 real directories"
    check_contains "the failure names the baseline" "$out" "baseline 5"
    echo 1 > "$home4/.local/state/yellowstone/skills-baseline"
    out="$(in_home "$home4" bash "$REPO/scripts/doctor.sh" 2>&1)" || true
    check_contains "a matching baseline does not report a shortfall" "$out" "1 real directories (baseline 1)"
  )

  # skills-sync with no checkouts must explain the remedy, not just fail.
  # Two correct paths now: resolve the skill from a checkout inside the
  # monorepo (the normal case), or explain the clone remedy when there is none.
  # Asserting only the remedy would assert the world before the conversion.
  out="$(in_home "$home3" bash "$REPO/scripts/skills-sync.sh" install 2>&1)"
  check "skills-sync resolves each repo-owned skill from a checkout or names the remedy" \
    bash -c "printf '%s' \"\$1\" | grep -qE 'using checkout|gh repo clone'" _ "$out"
}

# --------------------------------------------------------------- builder ----
# The box-side idleness verdict. These are the decisions that either leak money
# (never reaching `idle`) or kill somebody's build (reaching it too eagerly), and
# both have shipped before, so they are asserted rather than trusted.
#
suite_builder() {
  suite builder

  # The skill is a repo-kind row in skills/skills.tsv whose source is the in-tree copy
  # under src/skills/fleet-skills/. The suite used to read
  # `home/.agents/skills/shared-flyio-build-server/`, which is where an INSTALL puts the
  # link — not where this repo keeps the script — so every case below ran `sh` against a
  # path that did not exist, printed "cannot open", and failed for a reason that had
  # nothing to do with the verdict. A gate is allowed to be red; it is not allowed to be
  # red about its own pointer. Resolve the tracked source, and say so when it is absent
  # (a bare `docker run` uses the baked image, which excludes src/ on purpose).
  local skill_dir="$REPO/src/skills/fleet-skills/shared-flyio-build-server"
  local script="$skill_dir/builder-idle.sh"
  local st="$skill_dir/builder-state.sh"
  local home; home="$(new_home builder)"
  local shims="$home/shims"
  mkdir -p "$shims"

  if [ ! -f "$script" ] || [ ! -f "$st" ]; then
    bad "the builder skill is not in this work tree" \
        "looked for $script and $st — the baked image excludes src/; run ./test/run.sh builder, which mounts the checkout"
    return
  fi

  # A fake builder-state: the verdict reads lease facts from `status --json` only.
  cat > "$shims/builder-state" <<'EOS'
#!/bin/sh
[ "$1" = status ] && [ "${2:-}" = --json ] || exit 1
printf '{"leased":%s,"idleSeconds":-1,"leaseCount":%s,"leases":[%s]}\n' \
  "${FAKE_LEASED:-false}" "${FAKE_COUNT:-0}" "${FAKE_BODY:-}"
EOS
  # A fake pgrep so the process set under test is exactly what the case chose,
  # never whatever else the container happens to be running.
  cat > "$shims/pgrep" <<'EOS'
#!/bin/sh
[ "$1" = -x ] || exit 1
for p in $FAKE_PIDS; do [ -d "/proc/$p" ] && echo "$p"; done
exit 0
EOS
  chmod +x "$shims/builder-state" "$shims/pgrep"

  # Run the verdict against a seeded state dir. $2 is the baseline: "idle" seeds a
  # rate of 1% of one core over 100s, "busy" 50%.
  verdict_of() {
    local dir="$home/state-$1" kind="$2"; shift 2
    rm -rf "$dir"; mkdir -p "$dir"
    local cur; cur="$(awk '/^cpu /{ print $2+$3+$4+$7+$8+$9; exit }' /proc/stat)"
    local burn=100; [ "$kind" = busy ] && burn=5000
    printf '%s %s\n' "$(( cur - burn ))" "$(( $(date -u +%s) - 100 ))" > "$dir/cpu-sample"
    PATH="$shims:$PATH" BUILDER_STATE_DIR="$dir" sh "$script" "$@"
  }

  local out

  # The bug this suite exists for: sampling the CPU baseline twice per poll made
  # the second sample read elapsed 0, so the answer was `warmup` on every poll and
  # `idle` was unreachable -- the box could never scale to zero.
  out="$(verdict_of a idle --once)"
  check_contains "idle is reachable when nothing is happening" "$out" '"verdict":"idle"'

  out="$(verdict_of b busy --once)"
  check_contains "real work reads cpu-active" "$out" '"verdict":"cpu-active"'

  # A baseline with no timestamp is what an older box left in cpu-sample. Treating
  # the missing field as 0 divides by the whole epoch and calls it idle.
  local legacy="$home/state-legacy"; rm -rf "$legacy"; mkdir -p "$legacy"
  awk '/^cpu /{ print $2+$3+$4+$7+$8+$9; exit }' /proc/stat > "$legacy/cpu-sample"
  out="$(PATH="$shims:$PATH" BUILDER_STATE_DIR="$legacy" sh "$script" --once)"
  check_contains "a timestamp-less baseline fails closed" "$out" '"verdict":"warmup"'
  check "the timestamp-less baseline is rewritten" \
    test "$(awk 'NF==2' "$legacy/cpu-sample")" != ""

  # A live `cargo` that has burned no CPU, touched nothing and has no client is a
  # wedge -- but only once that state is older than WEDGE_GRACE.
  cp /bin/sleep "$home/cargo" 2>/dev/null || cp "$(command -v sleep)" "$home/cargo"
  "$home/cargo" 30 & local cpid=$!
  for _ in $(seq 1 50); do [ -d "/proc/$cpid" ] && break; done

  local wdir="$home/state-wedge"; rm -rf "$wdir"; mkdir -p "$wdir"
  local cur; cur="$(awk '/^cpu /{ print $2+$3+$4+$7+$8+$9; exit }' /proc/stat)"
  printf '%s %s\n' "$(( cur - 100 ))" "$(( $(date -u +%s) - 100 ))" > "$wdir/cpu-sample"
  printf '%s\n' "$(( $(date -u +%s) - 5000 ))" > "$wdir/wedge-since"
  out="$(PATH="$shims:$PATH" BUILDER_STATE_DIR="$wdir" WEDGE_GRACE=1200 \
    FAKE_PIDS="$cpid" FAKE_COUNT=0 sh "$script" --once)"
  check_contains "a stalled live process is reported wedged" "$out" '"verdict":"wedged"'

  printf '%s\n' "$(date -u +%s)" > "$wdir/wedge-since"
  out="$(PATH="$shims:$PATH" BUILDER_STATE_DIR="$wdir" WEDGE_GRACE=1200 \
    FAKE_PIDS="$cpid" FAKE_COUNT=0 sh "$script" --once)"
  check_contains "a young stall is still building" "$out" '"verdict":"building"'

  # A lease is a promise the client makes, so a killed client leaves one standing.
  # Past LEASE_START_GRACE with no compile and no churn it must stop vetoing.
  local sdir="$home/state-stale"; rm -rf "$sdir"; mkdir -p "$sdir"
  printf '%s %s\n' "$(( cur - 100 ))" "$(( $(date -u +%s) - 100 ))" > "$sdir/cpu-sample"
  out="$(PATH="$shims:$PATH" BUILDER_STATE_DIR="$sdir" FAKE_COUNT=1 FAKE_PIDS= \
    FAKE_BODY="\"started\":\"$(date -u -d '-1000 seconds' +%Y-%m-%dT%H:%M:%SZ)\"" \
    sh "$script" --once 2>/dev/null)"
  check_contains "a stale lease stops vetoing the stop" "$out" '"verdict":"idle"'

  out="$(PATH="$shims:$PATH" BUILDER_STATE_DIR="$sdir" FAKE_COUNT=1 FAKE_PIDS= \
    FAKE_BODY="\"started\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" \
    sh "$script" --once 2>/dev/null)"
  check_contains "a fresh lease still holds the box" "$out" '"verdict":"leased"'

  kill "$cpid" 2>/dev/null; wait "$cpid" 2>/dev/null

  # The lease must not outlive the record: a child that inherits the lock fd keeps
  # the shared lock held after the recorded holder is gone, and `park` then refuses
  # forever with nothing to name.
  local ldir="$home/state-lock"; rm -rf "$ldir"; mkdir -p "$ldir"
  BUILDER_STATE_DIR="$ldir" sh "$st" lease probe -- sleep 30 >/dev/null 2>&1 &
  local shellpid=$!
  local lease_seen=0
  for _ in $(seq 1 100); do [ -n "$(ls "$ldir/leases" 2>/dev/null)" ] && { lease_seen=1; break; }; done
  for _ in $(seq 1 100); do pgrep -P "$shellpid" -x sleep >/dev/null 2>&1 && break; done
  local child; child="$(pgrep -P "$shellpid" -x sleep 2>/dev/null | head -1)"
  for _ in $(seq 1 20); do :; done
  kill -9 "$shellpid" 2>/dev/null; wait "$shellpid" 2>/dev/null
  local held=0
  [ -n "$child" ] && [ -d "/proc/$child" ] \
    && held="$(ls -l "/proc/$child/fd" 2>/dev/null | grep -c 'lease.lock')"
  # When nothing was created, `held` is 0 and the old assertion passed without ever
  # exercising the lock — a vacuous green in the one check about a lock nobody can see.
  # So assert the fixture happened: no lease record means this case proved nothing.
  check_eq "the lease probe created a lease record" 1 "$lease_seen"
  check_eq "the leased child does not inherit the lock fd" "0" "${held:-0}"
  kill -9 "$child" 2>/dev/null
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

# ---------------------------------------------------------------- behold ----
suite_behold() {
  suite behold
  local home fake rc
  home="$(new_home behold)"
  fake="$home/fake-bin"
  mkdir -p "$fake"
  printf '#!/bin/sh\nexit 0\n' > "$fake/pi"
  chmod +x "$fake/pi"
  in_home "$home" env PATH="$fake:$PATH" bash "$REPO/install.sh" pi behold --yes >"$home/install.log" 2>&1
  rc=$?
  check_eq "offline Behold install exits 0" 0 "$rc"
  check "reporter installed byte-identical" cmp -s "$REPO/src/pi-extensions/behold/pi-extension/behold-state.ts" "$home/.pi/agent/extensions/behold-state.ts"
  check "CLI is executable" test -x "$home/.local/bin/behold"
  check "installed CLI runs independently of checkout" env HOME="$home" "$home/.local/bin/behold" --help
  if bash "$REPO/src/pi-extensions/behold/tests/run-tests.sh"; then
    ok "Behold isolated suite"
  else
    bad "Behold isolated suite"
  fi
}

# ------------------------------------------------------------------ main ----
main() {
  printf 'yellowstone test suite\nrepo: %s\nnode: %s\nherdr: %s\npi: %s\ncontainer memory limit: %s\n' \
    "$REPO" "$(node --version)" "$(herdr --version 2>/dev/null | awk '{print $2}')" \
    "$(pi --version 2>/dev/null)" "${YELLOWSTONE_TEST_MEMORY:-unset (host default)}"

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
    mirror)     suite_mirror ;;
    idempotent) suite_idempotent ;;
    partial)    suite_partial ;;
    failures)   suite_failures ;;
    resolvers)  suite_resolvers ;;
    builder)    suite_builder ;;
    behold)     suite_behold ;;
    all)        suite_smoke; suite_install; suite_mirror; suite_idempotent; suite_partial; suite_failures; suite_resolvers; suite_builder; suite_behold ;;
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
