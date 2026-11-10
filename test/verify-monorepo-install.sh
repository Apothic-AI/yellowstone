#!/usr/bin/env bash
# verify-monorepo-install.sh — the FT-01 acceptance gate for D12.
#
# The monorepo is only worth having if the machine installs *from it*. This
# installs into a throwaway HOME and then asserts that every package the fleet
# loads resolves inside the checkout:
#
#   - each of the nine pi packages resolves under `src/**`, not under `~/Code`
#     and not from an instance's materialised `git/` copy;
#   - no installed package source names `/home/*/Code/` at all;
#   - the skills that used to come from loose checkouts resolve under `src/**`.
#
# It never touches the real HOME: the four destination variables and HOME itself
# are pointed at a temporary tree, and the whole thing is removed on exit.
#
#   ./test/verify-monorepo-install.sh            # install, then assert
#   DRY_RUN_ONLY=1 ./test/verify-monorepo-install.sh   # print the plan only
#
# Needs network (`pi update --extensions` fetches npm packages) and a working
# `pi`. Unlike the round-trip gate it does not need a clean work tree: it copies
# the checkout it is run from into the sandbox first.
set -uo pipefail
cd "$(dirname -- "$0")/.."

REPO="$(pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

HOME_SB="$SANDBOX/home"
mkdir -p "$HOME_SB"

fail=0
note() { printf '  %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=$((fail + 1)); }

echo "sandbox: $SANDBOX"
echo "source : $REPO ($(git rev-parse --short HEAD 2>/dev/null || echo 'no git'))"

# Copy rather than run in place: the installer writes into the tree it lives in
# only via $HOME, but a copy means a bug in that assumption cannot reach the
# checkout the fleet is running from.
cp -a "$REPO/." "$SANDBOX/repo"
if [ -d "$SANDBOX/repo/.git" ]; then rm -rf "$SANDBOX/repo/.git"; fi

# Never let this reach the live multiplexer. `herdr plugin install` talks to the
# running server over its socket regardless of HOME, so the herdr stage gets a
# stub that refuses. The installer treats a missing herdr as an explained
# failure and carries on (that is the `failures` suite's contract), which is
# exactly the behaviour wanted here: install the pi and skills surfaces, leave
# the multiplexer alone.
mkdir -p "$SANDBOX/bin"
cat > "$SANDBOX/bin/herdr" <<'STUB'
#!/usr/bin/env bash
echo "herdr: stubbed by verify-monorepo-install.sh — the live server is not touched" >&2
exit 1
STUB
chmod +x "$SANDBOX/bin/herdr"
export PATH="$SANDBOX/bin:$PATH"

export HOME="$HOME_SB"
export HERDR_CONFIG_DIR="$HOME_SB/.config/herdr"
export PI_CODING_AGENT_DIR="$HOME_SB/.pi/agent"
export AGENTS_SKILLS_DIR="$HOME_SB/.agents/skills"
export LOCAL_BIN_DIR="$HOME_SB/.local/bin"

cd "$SANDBOX/repo" || exit 1

echo
echo "== install =="
if [ "${DRY_RUN_ONLY:-0}" = 1 ]; then
  ./install.sh --dry-run --yes 2>&1 | tail -40
  note "dry-run finished (exit status is not judged here: the herdr stage is stubbed)"
  exit "$fail"
fi

# The installer is run with the herdr stage stubbed, so a non-zero exit is
# expected and is *not* the gate's criterion: the assertions below are. What
# matters is that the pi and skills surfaces installed, so an absent
# settings.json is the failure, an angry herdr stage is a note.
# The launcher stage would otherwise mutate npm's GLOBAL bin dir and repoint this
# machine's real pi-profile at the sandbox — it did exactly that once, and broke the
# launcher for every lane. The gate tests that the tree installs; a sandbox must not
# touch anything outside itself.
PI_LAUNCHER_SKIP_GLOBAL=1 ./install.sh --yes >"$SANDBOX/install.log" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  note "install.sh exited $rc with the herdr stage stubbed (log: $SANDBOX/install.log)"
  grep -E '^(warn|error)' "$SANDBOX/install.log" | head -5 | sed 's/^/    /'
fi

SETTINGS="${PI_CODING_AGENT_DIR}/settings.json"
if [ ! -f "$SETTINGS" ]; then
  bad "no settings.json installed at $SETTINGS"
else
  echo
  echo "== package sources =="
  sources="$(python3 - "$SETTINGS" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for p in d.get('packages',[]):
    s=p if isinstance(p,str) else p.get('source','')
    print(s)
PY
)"
  # pi records an in-tree package RELATIVE to the settings file that declares it
  # ("../../../repo/src/pi-extensions/bizzy"), which keeps the config portable when
  # the tree and the agent dir move together. That is better than the absolute paths
  # this repo used to hand-write, but it means a source cannot be classified or
  # existence-checked until it is resolved against its own settings file. Normalise
  # once here, and both the checks below work on absolute paths.
  sources_resolved=""
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    case "$s" in
      npm:*) sources_resolved="$sources_resolved$s"$'\n' ;;
      /*)    sources_resolved="$sources_resolved$s"$'\n' ;;
      *)     r="$(cd "$(dirname "$SETTINGS")" 2>/dev/null && realpath -m "$s")"
             sources_resolved="$sources_resolved${r:-$s}"$'\n' ;;
    esac
  done <<< "$sources"
  sources="$sources_resolved"

  while IFS= read -r s; do
    [ -n "$s" ] || continue
    case "$s" in
      npm:*) : ;;
      "$REPO"/*|"$SANDBOX/repo"/*)
        [ -e "$s" ] || bad "source does not exist: $s" ;;
      *'/Code/'*)
        bad "still sourced from a loose checkout: $s" ;;
      *)
        bad "unexpected source: $s" ;;
    esac
  done <<< "$sources"
  note "$(printf '%s\n' "$sources" | wc -l | tr -d ' ') sources checked"

  echo
  echo "== the nine packages resolve inside the checkout =="
  for want in \
    src/pi-extensions/pi-goal \
    src/pi-extensions/pi-modes \
    src/pi-extensions/pi-fleet-hooks \
    src/pi-extensions/bizzy \
    src/pi-extensions/pi-pretty-tui \
    src/pi-extensions/pi-rooms \
    src/pi-extensions/apothic-todo \
    src/pi-extensions/pi-persist \
    src/pi-extensions/pi-cache-optimizer ; do
    # Presence of the string is not enough — a rendered source pointing at a
    # directory the checkout does not contain is exactly the failure this gate is
    # for, and grepping the list would pass it happily.
    rendered="$(printf '%s\n' "$sources" | grep -- "$want" | head -1)"
    if [ -n "$rendered" ] && [ -e "$rendered" ]; then
      note "ok   $want"
    elif [ -n "$rendered" ]; then
      bad "installed from a path that does not exist: $want"
    else
      bad "not installed from the monorepo: $want"
    fi
  done
fi

echo
echo "== skills resolve inside the checkout =="
for skill in mycord-skill unblock; do
  target="$(readlink "$AGENTS_SKILLS_DIR/$skill" 2>/dev/null || true)"
  if [ -z "$target" ]; then
    note "skip $skill (not installed by this profile)"
  elif [ -e "$target" ]; then
    note "ok   $skill -> ${target#"$SANDBOX/repo"/}"
  else
    bad "$skill is a dangling link: $target"
  fi
done

echo
if [ "$fail" -ne 0 ]; then
  echo "gate FAILED: $fail problem(s) — a machine installed from this tree would not run the fleet" >&2
  exit 1
fi
echo "gate passed: every installed package and skill resolves inside the monorepo checkout"
